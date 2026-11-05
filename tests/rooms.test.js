import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomState, NAMES } from '../worker/rooms.js';

test('eight devices join with unique names; ninth is rejected; leaving releases a slot', () => {
  const room = new RoomState();
  const peers = Array.from({ length: 8 }, () => room.join());
  assert.equal(new Set(peers.map(peer => peer.name)).size, 8);
  assert.throws(() => room.join(), /room-full/);
  room.leave(peers[0].id);
  const next = room.join();
  assert.notEqual(next.name, peers[0].name);
});

test('hibernation preserves live identities, departed reservations and authorized recovery', () => {
  let room = new RoomState();
  const first = room.join();
  const anchor = room.join();
  room.leave(first.id);
  room = new RoomState(room.snapshot(), [anchor.id]);
  const recovered = room.join(first.token);
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.name, first.name);
  assert.throws(() => room.join(first.token), /session-active/);
  room.leave(first.id);
  const impostor = room.join('invalid-token');
  assert.notEqual(impostor.id, first.id);
  assert.notEqual(impostor.name, first.name);
  assert.ok(JSON.stringify({ room: room.snapshot(), id: anchor.id }).length < 2048);
});

test('reserved-name exhaustion is independent of capacity; empty rooms start a fresh lifetime', () => {
  const room = new RoomState();
  const anchor = room.join();
  const names = new Set([anchor.name]);
  for (let index = 1; index < NAMES.length; index++) {
    const next = room.join();
    assert.ok(!names.has(next.name));
    names.add(next.name);
    room.leave(next.id);
  }
  assert.throws(() => room.join(), /names-exhausted/);
  const epoch = room.epoch;
  room.leave(anchor.id);
  assert.notEqual(room.epoch, epoch);
  assert.ok(room.join().name);
});

test('names are short celestial names; simultaneous synchronous joins cannot oversubscribe', async () => {
  assert.equal(new Set(NAMES).size, NAMES.length);
  assert.ok(NAMES.every(name => /^[A-Za-z]{2,10}$/.test(name)));
  const room = new RoomState();
  const joins = await Promise.allSettled(Array.from({ length: 20 }, async () => room.join()));
  assert.equal(joins.filter(join => join.status === 'fulfilled').length, 8);
});
