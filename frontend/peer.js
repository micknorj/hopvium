import { TransferSession } from './transfer.js';
import { randomId } from '../shared/ids.js';
import { CHUNK_SIZE } from '../shared/protocol.js';

export async function securityCode(connection) {
  const fingerprints = [connection.localDescription, connection.remoteDescription].map(description => {
    const fingerprint = description?.sdp.match(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/m)?.[1];
    if (!fingerprint || !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(fingerprint)) throw new Error('Verification unavailable.');
    return fingerprint.toUpperCase();
  }).sort();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Hopvium DTLS v1\n${fingerprints.join('\n')}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ');
}

export async function selectedRoute(connection) {
  const stats = await connection.getStats();
  let pair;
  for (const report of stats.values()) if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
  if (!pair) for (const report of stats.values()) if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
  if (!pair) return 'Selected route unavailable in this browser';
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') throw new Error('A relay route was rejected.');
  return `${local?.candidateType ?? 'unknown'} ↔ ${remote?.candidateType ?? 'unknown'} · ${local?.protocol ?? 'unknown'}`;
}

export class PeerConnection {
  constructor(discovery, callbacks) {
    this.discovery = discovery;
    this.callbacks = callbacks;
    this.active = null;
    this.queue = Promise.resolve();
    discovery.addEventListener('signal', event => {
      const message = event.detail;
      this.queue = this.queue.then(() => this.signal(message)).catch(() => {
        if (this.active?.id === message.connection) this.fail('Connection negotiation failed. Try selecting files again.');
      });
    });
    discovery.addEventListener('disconnected', () => this.fail('Discovery disconnected. Restart the transfer manually.'));
    discovery.addEventListener('rebuilt', () => this.fail('The room was rebuilt. Restart the transfer manually.'));
  }

  create(to, id, role, files) {
    if (this.active) throw new Error('Another transfer is active.');
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle',
    });
    const attempt = { connection, to, id, role, files, candidates: [], outgoing: [], signaled: false, session: null };
    this.active = attempt;
    this.callbacks.onStart?.(to, role);
    attempt.timeout = setTimeout(() => this.fail('A direct connection could not be established. This network may block WebRTC; no relay is available.'), 30000);
    connection.addEventListener('icecandidate', event => {
      // Firefox also emits a non-null candidate with an empty string at end of gathering.
      if (!event.candidate?.candidate || this.active !== attempt) return;
      const candidate = event.candidate.toJSON();
      const signal = { type: 'candidate', candidate: {
        candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment ?? null,
      } };
      try {
        if (attempt.signaled) this.send(attempt, signal); else attempt.outgoing.push(signal);
      } catch { this.fail('A signaling message could not be sent. Restart manually.'); }
    });
    connection.addEventListener('connectionstatechange', () => {
      if (this.active !== attempt) return;
      if (['failed', 'closed'].includes(connection.connectionState)) this.fail('The direct connection ended. Restart manually.');
      if (connection.connectionState === 'disconnected') {
        attempt.disconnected = setTimeout(() => this.fail('The direct connection was interrupted. Restart manually.'), 8000);
      } else clearTimeout(attempt.disconnected);
    });
    connection.addEventListener('datachannel', event => {
      if (role !== 'receiver' || attempt.session || event.channel.label !== 'hopvium-v1' || !event.channel.ordered ||
          event.channel.maxRetransmits !== null || event.channel.maxPacketLifeTime !== null) {
        event.channel.close(); this.fail('Unexpected transfer channel.'); return;
      }
      this.bind(attempt, event.channel);
    });
    return attempt;
  }

  send(attempt, message) { this.discovery.send({ ...message, to: attempt.to, connection: attempt.id }); }

  async start(to, files) {
    let attempt;
    try {
      attempt = this.create(to, randomId(), 'sender', files);
      this.bind(attempt, attempt.connection.createDataChannel('hopvium-v1', { ordered: true }));
      const description = await attempt.connection.createOffer();
      if (this.active !== attempt) return;
      await attempt.connection.setLocalDescription(description);
      if (this.active !== attempt) return;
      this.send(attempt, { type: 'description', description: { type: 'offer', sdp: attempt.connection.localDescription.sdp } });
      this.flush(attempt);
    } catch {
      if (this.active === attempt) this.fail('A direct connection could not be started. Try again.');
      else if (!attempt && !this.active) this.callbacks.onError?.('This browser could not create a direct connection.');
    }
  }

  flush(attempt) {
    attempt.signaled = true;
    for (const message of attempt.outgoing) this.send(attempt, message);
    attempt.outgoing = [];
  }

  async signal(message) {
    if (message.type === 'unavailable') {
      if (message.connection === this.active?.id) this.fail('That device is busy. Try again after its transfer finishes.');
      return;
    }
    if (message.type === 'description' && message.description.type === 'offer') {
      if (this.active || !this.callbacks.canReceive()) {
        this.discovery.send({ type: 'close', to: message.from, connection: message.connection });
        return;
      }
      const attempt = this.create(message.from, message.connection, 'receiver');
      await attempt.connection.setRemoteDescription(message.description);
      if (this.active !== attempt) return;
      await attempt.connection.setLocalDescription(await attempt.connection.createAnswer());
      if (this.active !== attempt) return;
      this.send(attempt, { type: 'description', description: { type: 'answer', sdp: attempt.connection.localDescription.sdp } });
      this.flush(attempt);
      return;
    }
    const attempt = this.active;
    if (!attempt || attempt.id !== message.connection || attempt.to !== message.from) return;
    if (message.type === 'close') {
      if (attempt.session?.state === 'received') attempt.session.finish('complete');
      else if (attempt.session?.terminal) this.close(attempt);
      else this.fail('The other device ended the connection. Restart manually if needed.');
      return;
    }
    if (message.type === 'description') {
      await attempt.connection.setRemoteDescription(message.description);
      for (const candidate of attempt.candidates) await attempt.connection.addIceCandidate(candidate);
      attempt.candidates = [];
    } else if (message.type === 'candidate') {
      if (attempt.connection.remoteDescription) await attempt.connection.addIceCandidate(message.candidate);
      else {
        if (attempt.candidates.length >= 128) throw new Error('Too many candidates.');
        attempt.candidates.push(message.candidate);
      }
    }
  }

  bind(attempt, channel) {
    attempt.channel = channel;
    attempt.session = new TransferSession(channel, {
      role: attempt.role, files: attempt.files,
      onRequest: files => this.callbacks.onRequest?.(files, attempt.session),
      onProgress: progress => this.callbacks.onProgress?.(progress),
      onFile: file => this.callbacks.onFile?.(file),
      onStatus: status => this.callbacks.onStatus?.(status),
      onError: message => this.callbacks.onError?.(message),
      onFinish: state => {
        if (this.active !== attempt) return;
        this.callbacks.onFinish?.(state);
        // A receiver lets its queued decline reach the sender before closing.
        if (attempt.role === 'receiver' && state === 'declined') {
          attempt.finishTimer = setTimeout(() => this.close(attempt), 3000);
          channel.addEventListener('close', () => this.close(attempt), { once: true });
        } else this.close(attempt);
      },
    });
    channel.addEventListener('open', async () => {
      clearTimeout(attempt.timeout);
      try {
        const [code, route] = await Promise.all([securityCode(attempt.connection), selectedRoute(attempt.connection)]);
        if (this.active !== attempt) return;
        this.callbacks.onConnection?.({ code, route });
        const maximum = attempt.connection.sctp?.maxMessageSize;
        attempt.session.chunkSize = Math.min(CHUNK_SIZE, maximum === 0 ? CHUNK_SIZE : maximum || 16 * 1024);
        if (attempt.role === 'sender') attempt.session.start();
        attempt.files = null;
      } catch { this.fail('The connection could not be verified. Restart manually.'); }
    }, { once: true });
  }

  fail(message) {
    const attempt = this.active;
    if (!attempt) return;
    attempt.session?.connectionEnded(message);
    if (this.active === attempt) {
      this.callbacks.onError?.(message);
      this.callbacks.onFinish?.('failed');
      this.close(attempt);
    }
  }

  close(attempt = this.active) {
    if (!attempt || this.active !== attempt) return;
    this.active = null;
    attempt.session?.finish('cancelled');
    clearTimeout(attempt.timeout);
    clearTimeout(attempt.disconnected);
    clearTimeout(attempt.finishTimer);
    try { this.send(attempt, { type: 'close' }); } catch { /* Signaling may already be offline. */ }
    attempt.channel?.close();
    attempt.connection.close();
    attempt.files = null;
    attempt.candidates = [];
    attempt.outgoing = [];
    this.callbacks.onIdle?.();
  }
}
