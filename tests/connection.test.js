import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerConnection, securityCode, selectedRoute } from '../frontend/peer.js';
import { waitForBuffer } from '../frontend/transfer.js';

test('verification codes are symmetric and change with either negotiated certificate', async () => {
  const description = byte => ({ sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\n` });
  const code = await securityCode({ localDescription: description('AB'), remoteDescription: description('CD') });
  assert.match(code, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.equal(await securityCode({ localDescription: description('CD'), remoteDescription: description('AB') }), code);
  assert.notEqual(await securityCode({ localDescription: description('EF'), remoteDescription: description('CD') }), code);
  await assert.rejects(() => securityCode({ localDescription: { sdp: '' }, remoteDescription: description('AB') }));
});

test('a cancelled negotiation cannot fail a newer manual attempt when its promise rejects late', async () => {
  const original = globalThis.RTCPeerConnection;
  const rejections = [];
  class NativePeerBoundary extends EventTarget {
    createDataChannel() {
      const channel = new EventTarget();
      channel.readyState = 'connecting'; channel.bufferedAmount = 0;
      channel.close = () => { channel.readyState = 'closed'; channel.dispatchEvent(new Event('close')); };
      return channel;
    }
    createOffer() { return new Promise((resolve, reject) => rejections.push(reject)); }
    close() { this.connectionState = 'closed'; }
  }
  globalThis.RTCPeerConnection = NativePeerBoundary;
  try {
    const discovery = new EventTarget(); discovery.send = () => {};
    const errors = [];
    const peer = new PeerConnection(discovery, { canReceive: () => true, onError: error => errors.push(error) });
    const first = peer.start('A'.repeat(16), [new File(['first'], 'first')]);
    peer.active.session.cancel();
    const second = peer.start('A'.repeat(16), [new File(['second'], 'second')]);
    const current = peer.active;
    rejections[0](new Error('Old browser operation rejected after cancellation.'));
    await first;
    assert.equal(peer.active, current);
    assert.deepEqual(errors, []);
    peer.active.session.cancel();
    rejections[1](new Error('Cleanup'));
    await second;
  } finally {
    if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection;
  }
});

test('selected-route inspection rejects actual relay statistics and handles unsupported stats honestly', async () => {
  const stats = candidateType => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType, protocol: 'udp' }],
    ['remote', { type: 'remote-candidate', candidateType: 'host' }],
  ]);
  assert.equal(await selectedRoute({ getStats: async () => stats('host') }), 'host ↔ host · udp');
  await assert.rejects(() => selectedRoute({ getStats: async () => stats('relay') }), /relay/);
  assert.match(await selectedRoute({ getStats: async () => new Map() }), /unavailable/);
});

test('backpressure pauses reading, resumes below the watermark and aborts cleanly', async () => {
  const channel = new EventTarget(); channel.bufferedAmount = 2 * 1024 * 1024; channel.readyState = 'open';
  const abort = new AbortController();
  let resumed = false;
  const waiting = waitForBuffer(channel, abort.signal).then(() => { resumed = true; });
  await Promise.resolve(); assert.equal(resumed, false);
  channel.bufferedAmount = 0; channel.dispatchEvent(new Event('bufferedamountlow'));
  await waiting; assert.equal(resumed, true);
  channel.bufferedAmount = 2 * 1024 * 1024;
  const cancelled = waitForBuffer(channel, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, /interrupted/);
});
