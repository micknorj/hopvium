// Controlled local-only benchmark. Run npm run dev; optionally supply a local PairDrop URL.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const reference = process.argv[2];
if (reference && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(reference).hostname)) throw new Error('Benchmarks must use a controlled local reference, never a public service.');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve('.private/browsers');
const { chromium } = await import('playwright');
await mkdir('.private/benchmarks', { recursive: true });
const browser = await chromium.launch({ downloadsPath: path.resolve('.private/downloads') });
const cdp = await browser.newBrowserCDPSession();
async function memory() {
  if (process.platform !== 'win32') return null;
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map(info => info.id).filter(id => Number.isSafeInteger(id) && id > 0);
    const sum = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return Number(sum.trim()) || null;
  } catch { return null; }
}
const bytes = 8 * 1024 * 1024;
const payload = Buffer.alloc(bytes);
for (let index = 0; index < bytes; index++) payload[index] = index % 251;
const digest = createHash('sha256').update(payload).digest('hex');
const results = [];
try {
  for (const [name, url] of [['Hopvium', 'http://127.0.0.1:8788/hopvium/'], ...(reference ? [['PairDrop', reference]] : [])]) {
    for (let trial = 1; trial <= 3; trial++) {
      const contexts = await Promise.all([browser.newContext({ acceptDownloads: true }), browser.newContext({ acceptDownloads: true })]);
      try {
        for (const context of contexts) await context.addInitScript(() => {
          window.__pcs = []; window.__blobs = [];
          const Peer = RTCPeerConnection;
          window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.__pcs.push(this); } };
          const create = URL.createObjectURL;
          URL.createObjectURL = function (blob) { window.__blobs.push({ blob, at: performance.now() }); return create.call(this, blob); };
          document.addEventListener('click', event => { if (event.target.closest('#accept, #accept-request')) window.__acceptedAt = performance.now(); }, true);
        });
        const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()));
        const discoveredAt = performance.now();
        await Promise.all([sender.goto(url), receiver.goto(url)]);
        const peer = name === 'Hopvium' ? '.peer' : 'x-peer';
        await Promise.all([sender.locator(peer).first().waitFor(), receiver.locator(peer).first().waitFor()]);
        const discoveryMs = performance.now() - discoveredAt;
        if (name === 'Hopvium') await sender.locator(peer).click();
        const selectedAt = performance.now();
        await sender.locator(name === 'Hopvium' ? '#files' : 'x-peer input[type=file]').setInputFiles({ name: 'synthetic.bin', mimeType: 'application/octet-stream', buffer: payload });
        const request = name === 'Hopvium' ? '#incoming[open]' : '#receive-request-dialog[show]';
        await receiver.locator(request).waitFor({ state: 'attached' });
        const selectionToRequestMs = performance.now() - selectedAt;
        const route = await sender.evaluate(async () => {
          const pc = window.__pcs.find(peer => peer.connectionState === 'connected');
          if (!pc) return null;
          const stats = await pc.getStats();
          let pair;
          for (const item of stats.values()) if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId);
          if (!pair) for (const item of stats.values()) if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item;
          if (!pair) return null;
          return { local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType, protocol: stats.get(pair.localCandidateId)?.protocol };
        });
        if (route?.local === 'relay' || route?.remote === 'relay') throw new Error('Direct/relay comparison refused.');
        const beforeBytes = await memory();
        await receiver.locator(name === 'Hopvium' ? '#accept' : '#accept-request').click();
        await receiver.waitForFunction(size => window.__blobs.some(entry => entry.blob.size === size), bytes, { timeout: 60000 });
        if (name === 'Hopvium') await sender.locator('#transfer-status').filter({ hasText: 'Transfer complete' }).waitFor();
        const afterBytes = await memory();
        const timing = await receiver.evaluate(size => ({ milliseconds: window.__blobs.find(entry => entry.blob.size === size).at - window.__acceptedAt }), bytes);
        // Test-only integrity check, deliberately excluded from transfer timings and memory snapshots.
        const receivedDigest = await receiver.evaluate(async size => {
          const blob = window.__blobs.find(entry => entry.blob.size === size).blob;
          const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
          return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        }, bytes);
        if (receivedDigest !== digest) throw new Error('Received bytes did not match.');
        const connectionsAfter = await sender.evaluate(() => window.__pcs.map(peer => peer.connectionState));
        const sample = { name, trial, bytes, discoveryMs, selectionToRequestMs, acceptToBlobMs: timing.milliseconds, mibPerSecond: 8 / (timing.milliseconds / 1000), route, workingSetBeforeBytes: beforeBytes, workingSetAfterBytes: afterBytes, connectionsAfter, integrity: 'passed' };
        results.push(sample);
        console.log(`${name} trial ${trial}: ${sample.mibPerSecond.toFixed(2)} MiB/s, ${timing.milliseconds.toFixed(0)} ms, ${route?.local} ↔ ${route?.remote}`);
      } finally { await Promise.all(contexts.map(context => context.close())); }
    }
  }
} finally {
  await writeFile('.private/benchmarks/comparison.json', JSON.stringify({ browser: browser.version(), platform: process.platform, date: '2026-11-03', notes: ['One Windows sandbox host, isolated contexts in the same Chromium process; loopback host-to-host UDP.', 'Accept-to-received-Blob measures application processing and transport, excluding synthetic-file injection and test hashing.', 'Working-set snapshots sum browser process RSS; they are not peak memory and include browser, test hooks and pending Blob memory.', 'Reference settings must disable relays and WebSocket file fallback. No production-service load.', 'No LocalSend Web performance-parity claim is supported by this benchmark.'], results }, null, 2));
  await browser.close();
}
