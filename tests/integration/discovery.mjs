// Requires npm run dev. Exercises the real local workerd runtime, not cloud hibernation.
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const clients = [];
async function connect(token = null, origin = 'http://127.0.0.1:8788') {
  const socket = new WebSocket('ws://127.0.0.1:8787/signal', { origin });
  const messages = [];
  socket.on('message', data => messages.push(JSON.parse(data)));
  await once(socket, 'open');
  clients.push(socket);
  socket.send(JSON.stringify({ type: 'join', token }));
  await until(() => messages.find(message => ['welcome', 'error'].includes(message.type)));
  return { socket, messages, first: messages.find(message => ['welcome', 'error'].includes(message.type)) };
}
async function until(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Local discovery integration timed out.');
}
async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const ended = once(socket, 'close'); socket.close(); await ended;
}

try {
  const peers = await Promise.all(Array.from({ length: 8 }, () => connect()));
  console.log('Eight simultaneous local WebSockets joined.');
  assert.equal(new Set(peers.map(peer => peer.first.name)).size, 8);
  const ninth = await connect();
  assert.equal(ninth.first.code, 'room-full');
  console.log('Ninth socket rejected.');
  await close(peers[0].socket);
  const recovered = await connect(peers[0].first.token);
  assert.equal(recovered.first.name, peers[0].first.name);
  assert.equal(recovered.first.id, peers[0].first.id);
  recovered.socket.send(new Uint8Array([1, 2, 3]));
  await until(() => recovered.messages.some(message => message.code === 'invalid-message'));
  await close(recovered.socket);
  const fresh = await connect();
  assert.ok(!peers.some(peer => peer.first.name === fresh.first.name));
  for (const client of clients) await close(client);
  const rebuilt = await connect();
  assert.notEqual(rebuilt.first.epoch, peers[0].first.epoch);
  await close(rebuilt.socket);
  await assert.rejects(() => connect(null, 'https://unrelated.example'), /403/);
  console.log('Local workerd integration passed: concurrent joins, capacity, name reservation, authorized recovery, binary rejection, room rebuilding and origin rejection.');
} finally { for (const client of clients) client.terminate(); }
