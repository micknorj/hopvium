import { CHUNK_SIZE, parseControl, validateFiles } from '../shared/protocol.js';

export function waitForBuffer(channel, signal, limit = 1024 * 1024) {
  if (signal.aborted) return Promise.reject(new Error('Transfer cancelled.'));
  if (channel.readyState !== 'open') return Promise.reject(new Error('Connection closed.'));
  if (channel.bufferedAmount <= limit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const lowWater = Math.min(limit, 256 * 1024);
    const finish = error => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', drained);
      channel.removeEventListener('close', closed);
      signal.removeEventListener('abort', closed);
      if (error) reject(error); else resolve();
    };
    const drained = () => { if (channel.bufferedAmount <= lowWater) finish(); };
    const closed = () => finish(new Error('Transfer interrupted.'));
    const timer = setTimeout(() => finish(new Error('The connection stopped responding.')), 60000);
    channel.bufferedAmountLowThreshold = lowWater;
    channel.addEventListener('bufferedamountlow', drained);
    channel.addEventListener('close', closed, { once: true });
    signal.addEventListener('abort', closed, { once: true });
    drained();
  });
}

export class TransferSession {
  constructor(channel, options) {
    this.channel = channel;
    const { files, ...callbacks } = options;
    this.options = callbacks;
    this.state = 'ready';
    this.files = files ?? [];
    this.chunkSize = options.chunkSize ?? CHUNK_SIZE;
    this.index = 0;
    this.received = 0;
    this.transferred = 0;
    this.parts = [];
    this.abort = new AbortController();
    this.queue = Promise.resolve();
    channel.binaryType = 'arraybuffer';
    this.messageHandler = event => {
      this.queue = this.queue.then(() => this.receive(event.data)).catch(() => this.fail('Invalid or interrupted transfer. Restart manually.'));
    };
    this.closeHandler = () => this.connectionEnded('Connection lost. Restart the transfer manually.');
    this.errorHandler = () => this.connectionEnded('The direct connection failed. Restart manually.');
    channel.addEventListener('message', this.messageHandler);
    channel.addEventListener('close', this.closeHandler);
    channel.addEventListener('error', this.errorHandler);
    this.touch();
  }

  get terminal() { return ['complete', 'failed', 'declined', 'cancelled'].includes(this.state); }

  touch(milliseconds = 60000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('The transfer timed out. Restart manually.'), milliseconds);
    this.timer.unref?.();
  }

  control(message) { this.channel.send(JSON.stringify(message)); }

  start() {
    if (this.options.role !== 'sender' || this.state !== 'ready') throw new Error('Invalid transfer state.');
    const files = validateFiles(this.files.map(({ name, size }) => ({ name, size })));
    this.state = 'waiting';
    this.control({ type: 'request', version: 1, files });
    this.options.onStatus?.('Waiting for approval');
    this.touch(120000);
  }

  accept() {
    if (this.state !== 'approval') throw new Error('No request to accept.');
    this.state = 'receiving';
    this.control({ type: 'accept' });
    this.touch();
    this.options.onStatus?.('Receiving');
  }

  decline() {
    if (this.state !== 'approval') return;
    this.control({ type: 'decline' });
    this.finish('declined');
  }

  cancel() {
    if (this.terminal) return;
    if (this.channel.readyState === 'open') this.control({ type: 'cancel' });
    this.finish('cancelled');
  }

  async receive(raw) {
    if (this.terminal) return;
    this.touch();
    if (typeof raw !== 'string') {
      if (this.state !== 'receiving' || this.options.role !== 'receiver' || !(raw instanceof ArrayBuffer) ||
          raw.byteLength === 0 || raw.byteLength > CHUNK_SIZE || !this.files[this.index] ||
          this.received + raw.byteLength > this.files[this.index].size) throw new Error('Unexpected payload.');
      this.parts.push(raw);
      this.received += raw.byteLength;
      this.transferred += raw.byteLength;
      this.progress();
      return;
    }
    const message = parseControl(raw);
    if (message.type === 'cancel') { this.finish('cancelled'); return; }
    if (message.type === 'request' && this.options.role === 'receiver' && this.state === 'ready') {
      this.files = message.files;
      this.state = 'approval';
      this.touch(120000);
      this.options.onRequest?.(this.files);
    } else if (message.type === 'accept' && this.options.role === 'sender' && this.state === 'waiting') {
      this.state = 'sending';
      this.options.onStatus?.('Sending');
      void this.sendNext().catch(() => this.fail('The file could not be sent. Restart manually.'));
    } else if (message.type === 'decline' && this.state === 'waiting') {
      this.finish('declined');
    } else if (message.type === 'file-end' && this.state === 'receiving' && message.index === this.index) {
      const file = this.files[this.index];
      if (!file || this.received !== file.size) throw new Error('Incomplete file.');
      const blob = new Blob(this.parts, { type: 'application/octet-stream' });
      this.parts = [];
      this.received = 0;
      if (blob.size !== file.size) throw new Error('Incomplete file.');
      this.options.onFile?.({ name: file.name, blob });
      this.index++;
      this.control({ type: 'file-ok', index: message.index });
      this.progress();
    } else if (message.type === 'file-ok' && this.state === 'file-ack' && message.index === this.index) {
      this.index++;
      this.state = 'sending';
      void this.sendNext().catch(() => this.fail('The file could not be sent. Restart manually.'));
    } else if (message.type === 'done' && this.state === 'receiving' && this.index === this.files.length && !this.parts.length) {
      this.state = 'received';
      this.control({ type: 'complete' });
      this.options.onStatus?.('All bytes received; acknowledging completion');
    } else if (message.type === 'complete' && this.state === 'completion-ack') {
      this.finish('complete');
    } else throw new Error('Unexpected transfer state.');
  }

  async sendNext() {
    const file = this.files[this.index];
    if (!file) {
      this.state = 'completion-ack';
      this.control({ type: 'done' });
      return;
    }
    for (let offset = 0; offset < file.size; offset += this.chunkSize) {
      await waitForBuffer(this.channel, this.abort.signal);
      const expected = Math.min(this.chunkSize, file.size - offset);
      const chunk = await file.slice(offset, offset + expected).arrayBuffer();
      if (this.abort.signal.aborted || this.state !== 'sending') return;
      if (chunk.byteLength !== expected) throw new Error('File read was incomplete.');
      this.channel.send(chunk);
      this.transferred += chunk.byteLength;
      this.touch();
      this.progress();
    }
    this.state = 'file-ack';
    this.control({ type: 'file-end', index: this.index });
  }

  progress() {
    this.options.onProgress?.({ bytes: this.transferred, total: this.files.reduce((sum, file) => sum + file.size, 0) });
  }

  fail(message) {
    if (this.terminal) return;
    if (this.channel.readyState === 'open') {
      try { this.control({ type: 'cancel' }); } catch { /* Transport is already closing. */ }
    }
    this.finish('failed');
    this.options.onError?.(message);
  }

  connectionEnded(message) {
    // Some engines report an error instead of close when the sender closes after the ACK.
    if (this.state === 'received') this.finish('complete');
    else if (!this.terminal) this.fail(message);
  }

  finish(state) {
    if (this.terminal) return;
    this.state = state;
    clearTimeout(this.timer);
    this.abort.abort();
    this.parts = [];
    this.files = [];
    this.channel.removeEventListener('message', this.messageHandler);
    this.channel.removeEventListener('close', this.closeHandler);
    this.channel.removeEventListener('error', this.errorHandler);
    this.options.onFinish?.(state);
  }
}
