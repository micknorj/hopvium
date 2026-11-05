export const CHUNK_SIZE = 64 * 1024;
export const CONTROL_LIMIT = 64 * 1024;
export const SIGNAL_LIMIT = 24 * 1024;
export const ID = /^[A-Za-z0-9_-]{16}$/;

export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
    throw new Error('Invalid message structure.');
  }
}

function parse(raw, limit) {
  if (typeof raw !== 'string' || raw.length > limit || new TextEncoder().encode(raw).length > limit) {
    throw new Error('Message exceeds protocol boundaries.');
  }
  return JSON.parse(raw);
}

export function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 256) throw new Error('Choose between 1 and 256 files per batch.');
  let total = 0;
  for (const file of files) {
    exact(file, ['name', 'size']);
    if (typeof file.name !== 'string' || !file.name.length || file.name.length > 4096 ||
        !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid file metadata.');
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error('The total byte count cannot be represented safely.');
  }
  if (new TextEncoder().encode(JSON.stringify({ type: 'request', version: 1, files })).length > CONTROL_LIMIT) {
    throw new Error('Batch metadata is too large. Choose fewer files.');
  }
  return files;
}

export function parseControl(raw) {
  const message = parse(raw, CONTROL_LIMIT);
  switch (message.type) {
    case 'request':
      exact(message, ['type', 'version', 'files']);
      if (message.version !== 1) throw new Error('Unsupported transfer protocol.');
      validateFiles(message.files);
      break;
    case 'file-end':
    case 'file-ok':
      exact(message, ['type', 'index']);
      if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index > 255) throw new Error('Invalid file index.');
      break;
    case 'accept': case 'decline': case 'cancel': case 'done': case 'complete':
      exact(message, ['type']);
      break;
    default: throw new Error('Unknown transfer message.');
  }
  return message;
}

// Deliberately permits only browser-generated, data-only SDP, never metadata fields.
export function validateDescription(description) {
  exact(description, ['type', 'sdp']);
  if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' ||
      description.sdp.length > 20000 || !description.sdp.startsWith('v=0\r\n')) throw new Error('Invalid SDP.');
  const lines = description.sdp.split(/\r?\n/).filter(Boolean);
  const session = /^(v=0|o=[^\r\n]{1,160}|s=-|t=0 0|c=IN IP[46] [A-Za-z0-9.:_-]{1,100}|b=AS:\d{1,10}|m=application \d{1,5} (UDP\/DTLS\/SCTP webrtc-datachannel|DTLS\/SCTP \d{1,5}))$/;
  const attribute = /^a=(group:BUNDLE [\w -]{1,80}|msid-semantic: ?WMS ?[\w *-]{0,80}|ice-options:[\w -]{1,80}|ice-ufrag:[\w+/]{1,256}|ice-pwd:[\w+/]{1,256}|fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}|setup:(actpass|active|passive)|mid:[\w-]{1,32}|sctp-port:\d{1,5}|sctpmap:\d{1,5} webrtc-datachannel(?: \d{1,5})?|max-message-size:\d{1,16}|extmap-allow-mixed|sendrecv|end-of-candidates|candidate:[\w .:+/=-]{1,1000})$/;
  if (lines.filter(line => line.startsWith('m=')).length !== 1 ||
      !lines.some(line => line.startsWith('a=fingerprint:sha-256 ')) ||
      !lines.every(line => session.test(line) || attribute.test(line))) throw new Error('Only data-channel SDP is allowed.');
  return description;
}

export function parseSignal(raw) {
  const message = parse(raw, SIGNAL_LIMIT);
  if (message.type === 'ping') { exact(message, ['type']); return message; }
  if (message.type === 'join') {
    exact(message, ['type', 'token']);
    if (message.token !== null && (typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(message.token))) throw new Error('Invalid session.');
    return message;
  }
  const keys = ['type', 'to', 'connection'];
  if (message.type === 'description') keys.push('description');
  else if (message.type === 'candidate') keys.push('candidate');
  else if (message.type !== 'close') throw new Error('Unknown signaling message.');
  exact(message, keys);
  if (!ID.test(message.to) || !ID.test(message.connection)) throw new Error('Invalid signaling destination.');
  if (message.type === 'description') validateDescription(message.description);
  if (message.type === 'candidate') {
    exact(message.candidate, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
    const candidate = message.candidate;
    if (typeof candidate.candidate !== 'string' || !/^candidate:[\w .:+/=-]{1,1000}$/.test(candidate.candidate) ||
        !(candidate.sdpMid === null || typeof candidate.sdpMid === 'string' && /^[\w-]{1,32}$/.test(candidate.sdpMid)) ||
        !(candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === 0) ||
        !(candidate.usernameFragment === null || typeof candidate.usernameFragment === 'string' && /^[\w+/]{1,256}$/.test(candidate.usernameFragment))) {
      throw new Error('Invalid ICE candidate.');
    }
  }
  return message;
}
