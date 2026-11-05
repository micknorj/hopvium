import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { DiscoveryRoom, roomIdentifier } from '../worker/index.js';

class Socket {
  readyState = 1; messages = []; attachment = null;
  send(raw) { this.messages.push(JSON.parse(raw)); }
  serializeAttachment(value) { this.attachment = structuredClone(value); assert.ok(new TextEncoder().encode(JSON.stringify(value)).length <= 2048); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  close(code) { this.readyState = 3; this.closed = code; }
}
function runtime() {
  const sockets = [];
  const ctx = { getWebSockets: () => sockets.filter(socket => socket.readyState === 1) };
  let room = new DiscoveryRoom(ctx);
  return {
    get room() { return room; },
    connect(token = null) {
      const socket = new Socket(); sockets.push(socket);
      // A boundary fake for workerd's WebSocketPair/101 Response; all message handling is real.
      room.sockets.set(socket, { id: null, count: 0, since: Date.now(), link: null });
      room.webSocketMessage(socket, JSON.stringify({ type: 'join', token }));
      return socket;
    },
    leave(socket) { socket.close(1000); room.webSocketClose(socket); },
    wake() { room = new DiscoveryRoom(ctx); },
    stop() { for (const socket of [...room.sockets.keys()]) this.leave(socket); },
  };
}

test('Worker groups only by trusted IP with HMAC, validates origin, and exposes no upload endpoint', async () => {
  const key = 'synthetic-unit-test-secret-at-least-32-characters';
  const a = await roomIdentifier('203.0.113.1', key);
  const b = await roomIdentifier('203.0.113.2', key);
  assert.equal(a.length, 64); assert.notEqual(a, b); assert.equal(a.includes('203.0.113'), false);
  const routed = [];
  const env = { ROOM_HMAC_KEY: key, ALLOWED_ORIGINS: 'https://micknorj.github.io', ROOMS: {
    idFromName: value => value, get: id => ({ fetch: () => { routed.push(id); return new Response('test'); } }),
  } };
  const request = (ip, origin = 'https://micknorj.github.io') => new Request('https://worker.test/signal', { headers: { Upgrade: 'websocket', Origin: origin, 'CF-Connecting-IP': ip, 'X-Forwarded-For': '198.51.100.99' } });
  await worker.fetch(request('203.0.113.1'), env);
  await worker.fetch(request('203.0.113.1'), env);
  await worker.fetch(request('203.0.113.2'), env);
  assert.deepEqual(routed, [a, a, b]);
  const ipv6Room = await roomIdentifier('2001:db8:abcd:1234::1', key);
  await worker.fetch(request('2001:db8:abcd:1234::1'), env);
  await worker.fetch(request('2001:0DB8:ABCD:1234:ffff::2'), env);
  assert.deepEqual(routed.slice(3), [ipv6Room, ipv6Room]);
  for (const ip of ['not-an-ip', '2001:db8::1::2', '203.0.113.256']) {
    const response = await worker.fetch(request(ip), env);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Discovery unavailable');
  }
  assert.equal(routed.length, 5);
  assert.equal((await worker.fetch(request('203.0.113.1', 'https://evil.test'), env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://worker.test/upload', { method: 'POST', body: 'synthetic file bytes' }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.test/signal?room=chosen'), env)).status, 404);
  assert.equal((await worker.fetch(request('203.0.113.1'), { ...env, ROOM_HMAC_KEY: '' })).status, 503);
});

test('socket hibernation restores reservations, sessions, rate limits and room identity without database storage', () => {
  const app = runtime();
  try {
    const departed = app.connect(); const anchor = app.connect();
    const original = departed.messages.find(message => message.type === 'welcome');
    const epoch = original.epoch;
    app.leave(departed); app.wake();
    const next = app.connect();
    assert.notEqual(next.messages[0].name, original.name);
    const recovered = app.connect(original.token);
    assert.equal(recovered.messages[0].name, original.name);
    assert.equal(recovered.messages[0].id, original.id);
    assert.equal(recovered.messages[0].epoch, epoch);
    const impostor = app.connect('A'.repeat(32));
    assert.notEqual(impostor.messages[0].id, original.id);
    app.room.webSocketMessage(anchor, 'arbitrary file payload');
    assert.equal(anchor.closed, 4000);
  } finally { app.stop(); }
});

test('room authorization rejects cross-room signaling, unsolicited candidates and binary data', () => {
  for (const payload of [
    JSON.stringify({ type: 'candidate', to: 'A'.repeat(16), connection: 'B'.repeat(16), candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } }),
    new Uint8Array([1, 2, 3]).buffer,
    'x'.repeat(24577),
  ]) {
    const app = runtime();
    const anchor = app.connect(); const attacker = app.connect();
    const before = anchor.messages.length;
    app.room.webSocketMessage(attacker, payload);
    assert.equal(attacker.closed, 4000);
    assert.equal(anchor.messages.slice(before).some(message => message.type === 'candidate' || message.type === 'close'), false);
    app.stop();
  }
});

test('closing an already departed peer keeps the remaining room and recovery identity alive', () => {
  const app = runtime();
  const departed = app.connect(); const anchor = app.connect();
  const original = departed.messages[0];
  app.leave(departed);
  app.room.webSocketMessage(anchor, JSON.stringify({ type: 'close', to: original.id, connection: 'B'.repeat(16) }));
  assert.equal(anchor.closed, undefined);
  assert.equal(app.connect(original.token).messages[0].id, original.id);
  app.stop();
});

test('a ninth join is rejected, actual termination releases a slot and final departure rebuilds the room', () => {
  const app = runtime();
  const sockets = Array.from({ length: 8 }, () => app.connect());
  const names = sockets.map(socket => socket.messages[0].name);
  const extra = app.connect();
  assert.equal(extra.messages[0].code, 'room-full');
  app.leave(sockets[0]); app.wake();
  const next = app.connect();
  assert.ok(!names.includes(next.messages[0].name));
  const epoch = next.messages[0].epoch;
  app.stop(); app.wake();
  assert.notEqual(app.connect().messages[0].epoch, epoch);
  app.stop();
});

test('message limits survive simulated wake-up', () => {
  const app = runtime();
  const socket = app.connect();
  for (let count = 0; count < 179; count++) { app.room.webSocketMessage(socket, '{"type":"ping"}'); app.wake(); }
  app.room.webSocketMessage(socket, '{"type":"ping"}');
  assert.equal(socket.closed, 4000);
  app.stop();
});
