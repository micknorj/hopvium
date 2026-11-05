import { expect } from '@playwright/test';

export const PEERS = ['Ganymede', 'Bellatrix', 'Hyperion', 'Makemake', 'Neptune', 'Saturn', 'Europa'];
const SDP = ['v=0', 'o=- 123 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}`, 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n');

// Mock only WebSocket/WebRTC platform boundaries. The real discovery parser,
// peer controller, transfer approval protocol and application renderer still run.
export async function uiFixture(page, names = PEERS) {
  await page.addInitScript(({ sdp }) => {
    window.__qaSent = [];
    class Channel extends EventTarget {
      label = 'hopvium-v1'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
      readyState = 'connecting'; bufferedAmount = 0;
      send(message) { window.__qaSent.push(message); }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
    }
    window.RTCDataChannel = Channel;
    window.RTCPeerConnection = class extends EventTarget {
      connectionState = 'connected'; sctp = { maxMessageSize: 65536 };
      constructor() { super(); window.__qaPeer = this; }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        const channel = new Channel(); window.__qaChannel = channel;
        this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
        setTimeout(() => { channel.readyState = 'open'; channel.dispatchEvent(new Event('open')); }, 0);
      }
      async createAnswer() { return { type: 'answer', sdp }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async addIceCandidate() {}
      async getStats() {
        return new Map([
          ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
          ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
          ['local', { candidateType: 'host', protocol: 'udp' }], ['remote', { candidateType: 'host' }],
        ]);
      }
      close() { this.connectionState = 'closed'; this.dispatchEvent(new Event('connectionstatechange')); }
    };
  }, { sdp: SDP });
  let socket;
  await page.routeWebSocket('ws://127.0.0.1:8787/signal', route => {
    socket = route;
    route.onMessage(raw => {
      if (JSON.parse(raw).type === 'join') {
        route.send(JSON.stringify({ type: 'welcome', id: 'S'.repeat(16), name: 'Enceladus', token: 'T'.repeat(32), epoch: 'E'.repeat(16) }));
        route.send(JSON.stringify({ type: 'peers', peers: [
          { id: 'S'.repeat(16), name: 'Enceladus' },
          ...names.map((name, index) => ({ id: `P${String(index).padStart(15, '0')}`, name })),
        ] }));
      } else if (JSON.parse(raw).type === 'ping') route.send('{"type":"pong"}');
    });
  });
  await page.goto('/hopvium/');
  await expect(page.locator('.peer')).toHaveCount(names.length);
  return {
    async request(files) {
      socket.send(JSON.stringify({ type: 'description', from: `P${'0'.repeat(15)}`, connection: 'C'.repeat(16), description: { type: 'offer', sdp: SDP } }));
      await page.waitForFunction(() => window.__qaChannel?.readyState === 'open');
      await page.evaluate(files => window.__qaChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'request', version: 1, files }) })), files);
      await expect(page.locator('#incoming')).toBeVisible();
    },
    async bytes(count) {
      await page.evaluate(count => window.__qaChannel.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(count).buffer })), count);
    },
    async control(message) {
      await page.evaluate(message => window.__qaChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })), message);
    },
  };
}
