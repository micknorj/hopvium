import { randomId } from '../shared/ids.js';

// Original curated names of stars, planets, moons and minor planets.
export const NAMES = Object.freeze([
  'Saturn', 'Vega', 'Titan', 'Rigel', 'Neptune', 'Europa', 'Mars', 'Venus',
  'Mercury', 'Jupiter', 'Uranus', 'Pluto', 'Ceres', 'Eris', 'Haumea', 'Makemake',
  'Sirius', 'Altair', 'Deneb', 'Polaris', 'Spica', 'Antares', 'Arcturus', 'Capella',
  'Procyon', 'Aldebaran', 'Regulus', 'Castor', 'Pollux', 'Mira', 'Bellatrix', 'Alhena',
  'Io', 'Callisto', 'Ganymede', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Iapetus',
  'Mimas', 'Hyperion', 'Phoebe', 'Triton', 'Nereid', 'Charon', 'Ariel', 'Umbriel',
  'Titania', 'Oberon', 'Miranda', 'Phobos', 'Deimos', 'Vesta', 'Pallas', 'Juno',
  'Hygiea', 'Iris', 'Flora', 'Metis', 'Hebe', 'Psyche', 'Eunomia', 'Egeria',
]);

export class RoomState {
  constructor(snapshot, connected = []) {
    this.epoch = snapshot?.e ?? randomId();
    this.reserved = new Set(snapshot?.r ?? []);
    this.sessions = (snapshot?.s ?? []).map(([id, token, index]) => ({ id, token, index, name: NAMES[index] }));
    this.active = new Set(connected);
  }

  join(token) {
    if (this.active.size >= 8) throw new Error('room-full');
    let session = token && this.sessions.find(entry => entry.token === token);
    if (session && this.active.has(session.id)) throw new Error('session-active');
    if (!session) {
      const available = NAMES.map((_, index) => index).filter(index => !this.reserved.has(index));
      if (!available.length) throw new Error('names-exhausted');
      // Rejection sampling avoids modulo bias.
      const range = Math.floor(0x100000000 / available.length) * available.length;
      const value = new Uint32Array(1);
      do { crypto.getRandomValues(value); } while (value[0] >= range);
      const index = available[value[0] % available.length];
      session = { id: randomId(), token: randomId(24), index, name: NAMES[index] };
      this.reserved.add(index);
      if (this.sessions.length >= 8) {
        this.sessions.splice(this.sessions.findIndex(entry => !this.active.has(entry.id)), 1);
      }
      this.sessions.push(session);
    }
    this.active.add(session.id);
    return { ...session };
  }

  leave(id) {
    this.active.delete(id);
    if (!this.active.size) {
      this.epoch = randomId();
      this.reserved.clear();
      this.sessions = [];
    }
  }

  peers() {
    return this.sessions.filter(peer => this.active.has(peer.id)).map(({ id, name }) => ({ id, name }));
  }

  snapshot() {
    return { e: this.epoch, r: [...this.reserved], s: this.sessions.map(({ id, token, index }) => [id, token, index]) };
  }
}
