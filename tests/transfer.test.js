import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferSession } from '../frontend/transfer.js';

class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; sent = [];
  send(value) {
    this.sent.push(value);
    // Real WebRTC exposes binary sends as ArrayBuffers, including when given a typed view.
    const delivered = ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
    queueMicrotask(() => this.other?.dispatchEvent(new MessageEvent('message', { data: delivered })));
  }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
function pair() { const a = new Channel(); const b = new Channel(); a.other = b; b.other = a; return [a, b]; }
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('no file bytes are read or sent before explicit acceptance; decline sends none', async () => {
  const [outgoing, incoming] = pair();
  let read = false;
  const file = { name: 'private.bin', size: 3, slice() { read = true; throw new Error('Must not read'); } };
  const receiver = new TransferSession(incoming, { role: 'receiver' });
  const sender = new TransferSession(outgoing, { role: 'sender', files: [file] });
  sender.start();
  await tick();
  assert.equal(receiver.state, 'approval');
  assert.equal(read, false);
  receiver.decline();
  await tick();
  assert.equal(read, false);
  assert.equal(outgoing.sent.some(value => typeof value !== 'string'), false);
  assert.equal(sender.state, 'declined');
});

test('a multi-file batch including an empty file preserves exact bytes and needs completion acknowledgment', async () => {
  const [outgoing, incoming] = pair();
  const expected = Uint8Array.from({ length: 70001 }, (_, i) => i % 251);
  const files = [new File([expected], 'test.🪐'), new File([], 'empty')];
  const received = [];
  const receiver = new TransferSession(incoming, { role: 'receiver', onFile: file => received.push(file) });
  const sender = new TransferSession(outgoing, { role: 'sender', files });
  sender.start(); await tick(); receiver.accept(); await tick();
  assert.equal(received.length, 2);
  assert.equal(received[0].name, 'test.🪐');
  assert.deepEqual(new Uint8Array(await received[0].blob.arrayBuffer()), expected);
  assert.equal(received[1].blob.size, 0);
  assert.equal(sender.state, 'complete');
  incoming.close();
  assert.equal(receiver.state, 'complete');
  assert.equal(sender.files.length, 0);
});

test('premature or excessive payload and an incorrect byte count fail instead of completing', async () => {
  for (const mode of ['premature', 'overflow', 'short', 'repeat']) {
    const [outgoing, incoming] = pair();
    let delivered = false;
    const receiver = new TransferSession(incoming, { role: 'receiver', onFile: () => { delivered = true; } });
    outgoing.send(JSON.stringify({ type: 'request', version: 1, files: [{ name: 'x', size: 2 }] }));
    await tick();
    if (mode !== 'premature') receiver.accept();
    outgoing.send(new Uint8Array(mode === 'overflow' ? 3 : 1).buffer);
    if (mode === 'short') outgoing.send('{"type":"file-end","index":0}');
    if (mode === 'repeat') outgoing.send('{"type":"accept"}');
    await tick();
    assert.equal(receiver.state, 'failed', mode);
    assert.equal(delivered, false);
  }
});

test('an interrupted transfer releases partial bytes and allows a fresh manual session', async () => {
  const [outgoing, incoming] = pair();
  const receiver = new TransferSession(incoming, { role: 'receiver' });
  outgoing.send('{"type":"request","version":1,"files":[{"name":"x","size":4}]}');
  await tick(); receiver.accept(); outgoing.send(new Uint8Array(2).buffer); await tick();
  incoming.close();
  assert.equal(receiver.state, 'failed');
  assert.equal(receiver.parts.length, 0);
  assert.equal(receiver.files.length, 0);
  const [a, b] = pair();
  const fresh = new TransferSession(b, { role: 'receiver' });
  a.send('{"type":"request","version":1,"files":[{"name":"x","size":0}]}');
  await tick(); assert.equal(fresh.state, 'approval'); fresh.cancel();
});

test('a transport shutdown after all bytes and completion control does not undo a received batch', async () => {
  const [outgoing, incoming] = pair();
  const receiver = new TransferSession(incoming, { role: 'receiver' });
  const sender = new TransferSession(outgoing, { role: 'sender', files: [new File([], 'empty')] });
  sender.start(); await tick(); receiver.accept(); await tick();
  assert.equal(sender.state, 'complete');
  assert.equal(receiver.state, 'received');
  incoming.dispatchEvent(new Event('error'));
  assert.equal(receiver.state, 'complete');
});
