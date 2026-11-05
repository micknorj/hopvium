import { Discovery } from './discovery.js';
import { PeerConnection } from './peer.js';
import { validateFiles } from '../shared/protocol.js';
import { SIGNAL_URL } from './config.js';

const $ = selector => document.querySelector(selector);
let peers = [];
let recipient = null;
let approval = null;
let view = 'discovery';
let transferRole = null;
let transferName = '';
let batch = [];
let lastProgress = 0;
let progressTimer;
let transferMessage = '';
let discoveryMessage = '';
const downloads = [];

export function formatSize(size) {
  if (size === 0) return '0 bytes';
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: exponent ? 1 : 0 })} ${units[exponent]}`;
}

export function formatSecurityCode(code) {
  const value = BigInt(`0x${code.replaceAll(' ', '')}`) % (36n ** 6n);
  return value.toString(36).toUpperCase().padStart(6, '0').match(/.{3}/g).join(' ');
}

function renderMessage() {
  const message = transferMessage || (view === 'discovery' ? discoveryMessage : '');
  $('#transfer-status').textContent = message;
  $('#transfer-status').hidden = !message;
  $('.workspace').classList.toggle('has-message', !!message && view === 'discovery');
  $('#done').hidden = !(['complete', 'discovery'].includes(view) && (view === 'complete' || transferMessage || downloads.length));
}

function status(message) {
  transferMessage = message;
  renderMessage();
}

function showView(next) {
  view = next;
  $('#devices').dataset.view = next;
  $('#discovery-view').hidden = next !== 'discovery';
  $('#incoming').hidden = next !== 'request';
  $('#activity').hidden = !['connecting', 'waiting', 'transfer', 'complete'].includes(next);
  $('#panel-title').textContent = `${peers.length} Nearby devices`;
  $('#request-actions').hidden = next !== 'request';
  $('#transfer-actions').hidden = !['connecting', 'waiting', 'transfer'].includes(next);
  for (const file of batch) showFileProgress(file);
  renderMessage();
}

function ready() {
  for (const button of $('#peers').querySelectorAll('button')) button.disabled = !!transfer?.active;
}

function renderPeers() {
  if (!peers.some(peer => peer.id === recipient?.id)) {
    recipient = null;
  }
  $('#peers').replaceChildren();
  $('#panel-title').textContent = `${peers.length} Nearby devices`;
  $('#empty').hidden = peers.length > 0;
  for (const peer of peers) {
    const button = document.createElement('button');
    button.className = 'peer';
    button.setAttribute('aria-pressed', String(recipient?.id === peer.id));
    button.setAttribute('aria-label', `Send files to ${peer.name}`);
    button.textContent = peer.name;
    button.addEventListener('click', () => {
      recipient = peer;
      for (const element of $('#peers').children) element.setAttribute('aria-pressed', String(element === button));
      status('');
      $('#files').click();
    });
    $('#peers').append(button);
  }
  ready();
}

function fileRow(file) {
  const row = document.createElement('li');
  const filename = document.createElement('span'); filename.className = 'filename'; filename.textContent = file.name;
  const size = document.createElement('span'); size.className = 'file-size'; size.textContent = formatSize(file.size);
  row.append(filename, size);
  return row;
}

function showTransferFiles(files) {
  $('#transfer-files').replaceChildren();
  batch = files.map(file => {
    const row = fileRow(file);
    const line = document.createElement('div'); line.className = 'file-progress'; line.hidden = true;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0;
    progress.setAttribute('aria-label', `Transfer progress for ${file.name}`);
    const text = document.createElement('span'); text.className = 'progress-text';
    text.textContent = `0 bytes of ${formatSize(file.size)}`;
    line.append(progress, text); row.append(line);
    $('#transfer-files').append(row);
    return { size: file.size, row, line, progress, text, received: false };
  });
}

function updateFileProgress(file, bytes, complete = false) {
  file.progress.value = file.size ? bytes / file.size * 100 : complete ? 100 : 0;
  file.text.textContent = `${formatSize(bytes)} of ${formatSize(file.size)}`;
  showFileProgress(file);
}

function showFileProgress(file) {
  file.line.hidden = view !== 'transfer' || file.progress.value <= 0 || file.progress.value >= 100;
}

function renderFileProgress(bytes) {
  lastProgress = performance.now();
  let offset = 0;
  for (const file of batch) {
    if (!file.received) updateFileProgress(file, Math.max(0, Math.min(file.size, bytes - offset)), bytes > offset);
    offset += file.size;
  }
}

function closeApproval() {
  approval = null;
  $('#incoming-files').replaceChildren();
}

function returnToDevices() {
  showView('discovery');
  $('#transfer-files').replaceChildren();
  batch = [];
}

const supported = typeof RTCPeerConnection === 'function' && typeof RTCDataChannel !== 'undefined' && typeof crypto?.subtle === 'object';
const discovery = SIGNAL_URL && supported ? new Discovery(SIGNAL_URL) : null;
const transfer = discovery && new PeerConnection(discovery, {
  canReceive: () => !downloads.length,
  onStart: (to, role) => {
    transferRole = role;
    showView('connecting');
    showTransferFiles(role === 'sender' ? transfer.active.files : []);
    clearTimeout(progressTimer);
    lastProgress = -Infinity;
    $('#transfer-actions').hidden = false;
    $('#security-code').textContent = '--- ---';
    $('#security-code').setAttribute('aria-label', 'Available after connecting');
    transferName = peers.find(peer => peer.id === to)?.name ?? 'another browser';
    $('#activity-peer').textContent = `Connecting to ${transferName}…`;
    status('');
    ready();
  },
  onConnection: ({ code }) => {
    $('#security-code').textContent = formatSecurityCode(code);
    $('#security-code').removeAttribute('aria-label');
  },
  onRequest: (files, session) => {
    approval = session;
    const name = peers.find(peer => peer.id === transfer.active?.to)?.name ?? 'Another browser';
    const total = formatSize(files.reduce((sum, file) => sum + file.size, 0));
    $('#incoming-description').textContent = `“${name}” would like to share ${files.length} ${files.length === 1 ? 'file' : 'files'} (${total})`;
    $('#incoming-files').replaceChildren(...files.map(file => fileRow(file)));
    showTransferFiles(files);
    showView('request');
    status('');
    $('#decline').focus();
  },
  onProgress: ({ bytes, total }) => {
    clearTimeout(progressTimer);
    const delay = Math.max(0, 150 - (performance.now() - lastProgress));
    if (bytes === total || !delay) renderFileProgress(bytes);
    else progressTimer = setTimeout(() => renderFileProgress(bytes), delay);
  },
  onFile: ({ name, blob }) => {
    const completed = batch.find(file => !file.received);
    const url = URL.createObjectURL(blob);
    downloads.push(url);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.textContent = `Download ${name}`;
    if (completed) {
      completed.received = true;
      updateFileProgress(completed, completed.size, true);
      completed.row.querySelector('.filename').replaceWith(link);
      $('#download-list').append(completed.row);
    }
    $('#downloads').hidden = false;
    link.click();
  },
  onStatus: message => {
    if (message === 'Sending' || message === 'Receiving') {
      $('#activity-peer').textContent = transferRole === 'sender' ? `Sending to ${transferName}` : `Receiving from ${transferName}`;
      status(''); showView('transfer');
    } else if (message === 'Waiting for approval') {
      $('#activity-peer').textContent = `Waiting for ${transferName} to accept`;
      status(''); showView('waiting');
    } else status(message);
  },
  onFinish: state => {
    clearTimeout(progressTimer);
    const focused = document.activeElement;
    const restoreFocus = $('#incoming').contains(focused) || $('#request-actions').contains(focused) || $('#transfer-actions').contains(focused) ||
      state !== 'complete' && $('#activity').contains(focused);
    closeApproval();
    $('#transfer-actions').hidden = true;
    const messages = {
      complete: '',
      declined: 'Transfer declined.',
      cancelled: 'Transfer cancelled.',
      failed: 'Transfer interrupted. Select the files again to restart.',
    };
    status(messages[state]);
    if (state === 'complete') {
      $('#activity-peer').textContent = transferRole === 'sender' ? 'Sent' : 'Received';
      showView('complete');
      for (const file of batch) updateFileProgress(file, file.size, true);
    } else returnToDevices();
    // Restore focus only when the current control is being hidden by this transition.
    if (restoreFocus) $(state === 'complete' ? '#done' : '#devices').focus();
  },
  onError: status,
  onIdle: () => {
    $('#security-code').textContent = '--- ---';
    $('#security-code').setAttribute('aria-label', 'Available after connecting');
    ready();
  },
});

$('#files').addEventListener('change', () => {
  const files = Array.from($('#files').files ?? []);
  $('#files').value = '';
  if (!files.length || !recipient || transfer.active) return;
  try {
    validateFiles(files.map(({ name, size }) => ({ name, size })));
    void transfer.start(recipient.id, files);
  } catch (error) { status(error.message); }
});
$('#accept').addEventListener('click', () => {
  const session = approval;
  if (!session) return;
  closeApproval();
  session.accept();
  $('#cancel').focus();
});
function declineRequest() {
  const session = approval;
  closeApproval();
  session?.decline();
  $('#devices').focus();
}
$('#decline').addEventListener('click', declineRequest);
addEventListener('keydown', event => {
  if (event.key === 'Escape' && approval) { event.preventDefault(); declineRequest(); }
});
$('#cancel').addEventListener('click', () => {
  if (transfer?.active?.session) transfer.active.session.cancel();
  else if (transfer?.active) { status('Transfer cancelled.'); transfer.close(); returnToDevices(); $('#devices').focus(); }
});
$('#done').addEventListener('click', () => {
  if (transfer?.active && !transfer.active.session?.terminal) return;
  downloads.splice(0).forEach(url => URL.revokeObjectURL(url));
  $('#download-list').replaceChildren();
  $('#downloads').hidden = true;
  status('');
  returnToDevices();
  $('#devices').focus();
});

if (discovery) {
  discovery.addEventListener('identity', event => { $('#self-name').textContent = event.detail.name; });
  discovery.addEventListener('peers', event => { peers = event.detail; renderPeers(); });
  discovery.addEventListener('status', event => {
    discoveryMessage = ['Discovery connected', 'Connecting discovery…'].includes(event.detail) ? '' : event.detail;
    renderMessage();
  });
  discovery.addEventListener('disconnected', () => { $('#self-name').textContent = '—'; });
  discovery.connect();
} else {
  $('#self-name').textContent = '—';
  discoveryMessage = supported
    ? 'Discovery is not configured. The owner must build with a secure signaling endpoint before devices can connect.'
    : 'This browser does not provide secure WebRTC DataChannels. Use a supported browser over HTTPS or localhost.';
  renderMessage();
}

addEventListener('pagehide', () => {
  clearTimeout(progressTimer);
  transfer?.active?.session?.cancel();
  transfer?.close();
  discovery?.stop();
  downloads.splice(0).forEach(url => URL.revokeObjectURL(url));
});

addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
