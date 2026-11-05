import { RoomState } from './rooms.js';
import { parseSignal } from '../shared/protocol.js';
import { discoveryAddress } from './address.js';

export async function roomIdentifier(ip, secret) {
  const address = discoveryAddress(ip);
  if (address === null) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(address));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/signal' || url.search || request.method !== 'GET') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
    if (!origins.includes(request.headers.get('Origin'))) return new Response('Origin denied', { status: 403 });
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || typeof env.ROOM_HMAC_KEY !== 'string' || env.ROOM_HMAC_KEY.length < 32) return new Response('Discovery unavailable', { status: 503 });
    const room = await roomIdentifier(ip, env.ROOM_HMAC_KEY);
    if (room === null) return new Response('Discovery unavailable', { status: 503 });
    // Only the HMAC reaches the namespace. No client-chosen room identifier is accepted.
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request('https://room.internal/signal', { headers: { Upgrade: 'websocket' } }));
  },
};

export class DiscoveryRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sockets = new Map();
    const live = ctx.getWebSockets().filter(socket => socket.readyState === 1);
    let snapshot;
    for (const socket of live) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.room) snapshot = attachment.room;
      this.sockets.set(socket, attachment ?? { id: null, count: 0, since: Date.now(), link: null });
    }
    this.room = new RoomState(snapshot, [...this.sockets.values()].map(value => value.id).filter(Boolean));
    this.pendingTimers = new Map();
    for (const [socket, attachment] of this.sockets) if (!attachment.id) this.joinDeadline(socket);
    // Auto response keeps heartbeats from waking an otherwise idle object.
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    }
  }

  fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (this.sockets.size >= 8) {
      server.send(JSON.stringify({ type: 'error', code: 'room-full' }));
      server.close(4008, 'room-full');
    } else {
      this.sockets.set(server, { id: null, count: 0, since: Date.now(), link: null });
      this.persist();
      this.joinDeadline(server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  joinDeadline(socket) {
    const timer = setTimeout(() => { this.remove(socket); socket.close(4000, 'join-timeout'); }, 10000);
    this.pendingTimers.set(socket, timer);
  }

  persist() {
    const room = this.room.snapshot();
    for (const [socket, attachment] of this.sockets) socket.serializeAttachment({ ...attachment, room });
  }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)); } catch { this.remove(socket); }
  }

  broadcastPeers() {
    const peers = this.room.peers();
    for (const [socket, attachment] of this.sockets) if (attachment.id) this.send(socket, { type: 'peers', peers });
  }

  webSocketMessage(socket, raw) {
    const attachment = this.sockets.get(socket);
    if (!attachment) return;
    try {
      const now = Date.now();
      if (now - attachment.since >= 60000) { attachment.since = now; attachment.count = 0; }
      if (++attachment.count > 180) throw new Error('rate-limit');
      const message = parseSignal(raw);
      if (message.type === 'ping') { this.send(socket, { type: 'pong' }); this.persist(); return; }
      if (message.type === 'join') {
        if (attachment.id) throw new Error('already-joined');
        const peer = this.room.join(message.token);
        attachment.id = peer.id;
        clearTimeout(this.pendingTimers.get(socket));
        this.pendingTimers.delete(socket);
        this.persist();
        this.send(socket, { type: 'welcome', id: peer.id, name: peer.name, token: peer.token, epoch: this.room.epoch });
        this.broadcastPeers();
        return;
      }
      if (!attachment.id || message.to === attachment.id) throw new Error('unauthorized');
      const target = [...this.sockets].find(([, state]) => state.id === message.to);
      if (!target && message.type === 'close') { this.persist(); return; }
      if (!target) throw new Error('unknown-peer');
      const [destination, targetState] = target;
      if (message.type === 'description' && message.description.type === 'offer') {
        if (attachment.link || targetState.link) {
          this.send(socket, { type: 'unavailable', connection: message.connection });
          this.persist();
          return;
        }
        attachment.link = { id: message.connection, to: message.to, role: 'sender', answered: false };
        targetState.link = { id: message.connection, to: attachment.id, role: 'receiver', answered: false };
      } else {
        const authorized = attachment.link?.id === message.connection && attachment.link.to === message.to &&
          targetState.link?.id === message.connection && targetState.link.to === attachment.id;
        // Both endpoints can close concurrently. A stale close has no routing or state effects.
        if (!authorized && message.type === 'close') { this.persist(); return; }
        if (!authorized) throw new Error('unauthorized');
        if (message.type === 'description') {
          if (attachment.link.role !== 'receiver' || attachment.link.answered) throw new Error('unauthorized');
          attachment.link.answered = true;
          targetState.link.answered = true;
        }
      }
      if (message.type === 'close') { attachment.link = null; targetState.link = null; }
      this.persist();
      const { to, ...signal } = message;
      this.send(destination, { ...signal, from: attachment.id });
    } catch (error) {
      const code = ['room-full', 'names-exhausted', 'session-active'].includes(error.message) ? error.message : 'invalid-message';
      this.send(socket, { type: 'error', code });
      this.remove(socket);
      socket.close(4000, code);
    }
  }

  remove(socket) {
    const attachment = this.sockets.get(socket);
    if (!attachment) return;
    clearTimeout(this.pendingTimers.get(socket));
    this.pendingTimers.delete(socket);
    this.sockets.delete(socket);
    if (attachment.id) {
      for (const [other, state] of this.sockets) {
        if (state.link?.to === attachment.id) {
          this.send(other, { type: 'close', from: attachment.id, connection: state.link.id });
          state.link = null;
        }
      }
      this.room.leave(attachment.id);
    }
    this.persist();
    this.broadcastPeers();
  }

  webSocketClose(socket, code = 1000) {
    this.remove(socket);
    // Complete the close handshake explicitly on both current and older runtimes.
    socket.close(code === 1000 || code >= 3000 && code <= 4999 ? code : 1000, 'closed');
  }
  webSocketError(socket) { this.remove(socket); socket.close(1011, 'connection-error'); }
}
