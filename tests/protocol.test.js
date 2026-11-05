import test from 'node:test';
import assert from 'node:assert/strict';
import { parseControl, parseSignal, validateFiles, validateDescription } from '../shared/protocol.js';

test('batch metadata preserves unusual filenames, sizes and extensions without interpreting them', () => {
  const files = [{ name: '../<img src=x onerror=alert(1)>.🪐', size: 3 }, { name: 'empty', size: 0 }];
  assert.deepEqual(validateFiles(files), files);
  for (const input of [[{ name: 'x', size: -1 }], [{ name: 'x', size: 1.5 }], [], [{ name: 'x', size: 1, bytes: 'secret' }]]) {
    assert.throws(() => validateFiles(input));
  }
});

test('browser data-only SDP accepts extmap-allow-mixed while rejecting media and unknown fields', () => {
  const sdp = ['v=0', 'o=- 6383930909427198391 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:synthetic', 'a=ice-pwd:syntheticPasswordForTest', 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}`, 'a=setup:actpass', 'a=mid:0',
    'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
  assert.equal(validateDescription({ type: 'offer', sdp }).sdp, sdp);
  assert.throws(() => validateDescription({ type: 'offer', sdp: sdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n' }));
  assert.throws(() => validateDescription({ type: 'offer', sdp: sdp + 'a=filename:private.txt\r\n' }));
  assert.equal(validateDescription({ type: 'offer', sdp: sdp.replace('a=msid-semantic: WMS', 'a=msid-semantic:WMS *') }).type, 'offer');
});

test('signaling is a strict envelope: binary, unknown fields and metadata are rejected', () => {
  for (const message of [new ArrayBuffer(3), '{}', '{', JSON.stringify({ type: 'file', bytes: 'secret' }), JSON.stringify({ type: 'ping', file: 'secret' })]) {
    assert.throws(() => parseSignal(message));
  }
  assert.deepEqual(parseSignal('{"type":"ping"}'), { type: 'ping' });
});

test('control messages reject oversized frames, unsupported versions and malformed completion', () => {
  assert.deepEqual(parseControl('{"type":"accept"}'), { type: 'accept' });
  for (const message of ['{"type":"done","size":2}', '{}', 'x'.repeat(65537)]) assert.throws(() => parseControl(message));
});
