import { ID, parseSignal, exact } from '../shared/protocol.js';

export class Discovery extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.token = null;
    this.identity = null;
    this.attempt = 0;
    this.stopped = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  connect() {
    if (this.stopped) return;
    this.emit('status', this.attempt ? 'Reconnecting discovery…' : 'Connecting discovery…');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    let terminal = false;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', token: this.token }));
      this.deadline = setTimeout(() => socket.close(), 15000);
    });
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 24576) throw new Error('Invalid discovery response.');
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') {
          exact(message, ['type', 'id', 'name', 'token', 'epoch']);
          if (!ID.test(message.id) || !ID.test(message.epoch) || !/^[A-Za-z]{2,10}$/.test(message.name) || !/^[\w-]{32}$/.test(message.token)) throw new Error();
          const rebuilt = this.identity && (this.identity.epoch !== message.epoch || this.identity.id !== message.id);
          this.token = message.token;
          this.identity = { id: message.id, name: message.name, epoch: message.epoch };
          this.attempt = 0;
          clearTimeout(this.deadline);
          this.emit('identity', this.identity);
          if (rebuilt) this.emit('rebuilt');
          this.emit('status', 'Discovery connected');
          this.heartbeat = setInterval(() => {
            if (this.awaitingPong) { socket.close(); return; }
            this.awaitingPong = true;
            socket.send('{"type":"ping"}');
          }, 20000);
        } else if (message.type === 'peers') {
          exact(message, ['type', 'peers']);
          if (!Array.isArray(message.peers) || message.peers.length > 8) throw new Error();
          const names = new Set();
          const ids = new Set();
          for (const peer of message.peers) {
            exact(peer, ['id', 'name']);
            if (!ID.test(peer.id) || !/^[A-Za-z]{2,10}$/.test(peer.name) || names.has(peer.name) || ids.has(peer.id)) throw new Error();
            names.add(peer.name); ids.add(peer.id);
          }
          this.emit('peers', message.peers.filter(peer => peer.id !== this.identity?.id));
        } else if (message.type === 'pong') {
          exact(message, ['type']);
          this.awaitingPong = false;
        } else if (message.type === 'error') {
          exact(message, ['type', 'code']);
          const errors = {
            'room-full': 'This room is full (8 devices). Close another Hopvium tab, then reload.',
            'names-exhausted': 'All names in this room have been used. The room resets after everyone leaves.',
            'session-active': 'This temporary session is already connected. Reload to join again.',
            'invalid-message': 'Discovery rejected a message. Reload to reconnect.',
          };
          terminal = true;
          this.stopped = true;
          this.emit('status', errors[message.code] ?? 'Discovery unavailable. Reload to reconnect.');
          socket.close();
        } else if (message.type === 'unavailable') {
          exact(message, ['type', 'connection']);
          if (!ID.test(message.connection)) throw new Error();
          this.emit('signal', message);
        } else {
          const { from, ...signal } = message;
          if (!ID.test(from)) throw new Error();
          parseSignal(JSON.stringify({ ...signal, to: from }));
          this.emit('signal', message);
        }
      } catch {
        terminal = true;
        this.stopped = true;
        this.emit('status', 'Invalid discovery response. Reload to reconnect.');
        socket.close();
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(this.deadline);
      clearInterval(this.heartbeat);
      this.awaitingPong = false;
      this.emit('disconnected');
      this.emit('peers', []);
      if (!terminal && !this.stopped && this.attempt < 8) {
        const delay = Math.min(30000, 750 * 2 ** this.attempt++) + Math.floor(Math.random() * 500);
        this.emit('status', 'Discovery disconnected. Reconnecting automatically…');
        this.retry = setTimeout(() => this.connect(), delay);
      } else if (!terminal && !this.stopped) this.emit('status', 'Discovery could not reconnect. Reload to try again.');
    });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Discovery disconnected.');
    parseSignal(JSON.stringify(message));
    this.socket.send(JSON.stringify(message));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.token = null;
  }
}
