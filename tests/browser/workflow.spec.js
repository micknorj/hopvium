import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function supportsTransfers(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/hopvium/');
    return await page.evaluate(() => typeof RTCPeerConnection === 'function' && typeof RTCDataChannel !== 'undefined');
  } finally { await context.close(); }
}

async function devices(browser) {
  const senderContext = await browser.newContext({ acceptDownloads: true });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  await receiverContext.addInitScript(() => {
    window.__receivedBlobs = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = function (blob) { window.__receivedBlobs.push(blob); return create.call(this, blob); };
  });
  await senderContext.addInitScript(() => {
    window.__sockets = [];
    window.__connections = [];
    const Socket = WebSocket;
    const Peer = RTCPeerConnection;
    window.WebSocket = class extends Socket { constructor(...args) { super(...args); window.__sockets.push(this); } };
    window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.__connections.push(this); } };
  });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const failures = [];
  const frames = [];
  for (const page of [sender, receiver]) page.on('pageerror', error => failures.push(error.message));
  for (const page of [sender, receiver]) page.on('websocket', socket => socket.on('framesent', event => frames.push(event.payload)));
  await Promise.all([sender.goto('/hopvium/'), receiver.goto('/hopvium/')]);
  await expect(sender.locator('.peer')).toHaveCount(1);
  await expect(receiver.locator('.peer')).toHaveCount(1);
  return { sender, receiver, senderContext, receiverContext, failures, frames, close: async () => { await senderContext.close(); await receiverContext.close(); } };
}

test('actual WebRTC: approval, matching security codes, exact files, selected route and cleanup', async ({ browser }, testInfo) => {
  test.skip(!await supportsTransfers(browser), 'This Playwright engine build has no WebRTC DataChannel support.');
  const d = await devices(browser);
  try {
    // Test-only instrumentation observes browser transport, without changing production behavior.
    await d.sender.evaluate(() => {
      window.__payloadBytes = 0;
      const original = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (value) {
        if (typeof value !== 'string') window.__payloadBytes += value.byteLength ?? value.size;
        return original.call(this, value);
      };
    });
    const marker = 'HOPVIUM-SYNTHETIC-NOT-FOR-SIGNALING';
    const expected = Buffer.alloc(1024 * 1024 + 19);
    for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
    expected.write(marker);
    const started = performance.now();
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles([
      { name: '<img onerror=alert(1)>.txt', mimeType: 'text/plain', buffer: expected },
      { name: 'empty.🪐', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    ]);
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await expect(d.receiver.locator('#devices')).toHaveAttribute('data-view', 'request');
    const connected = performance.now();
    await expect(d.receiver.locator('#incoming-files')).toContainText('<img onerror=alert(1)>.txt');
    expect(await d.receiver.locator('#incoming-files img').count()).toBe(0);
    expect(await d.sender.evaluate(() => window.__payloadBytes)).toBe(0);
    const codeA = await d.sender.locator('#security-code').textContent();
    await expect(d.receiver.locator('#security-code')).toHaveText(codeA);
    expect(codeA).toMatch(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const route = await d.sender.evaluate(async () => { const { selectedRoute } = await import('./peer.js'); return selectedRoute(window.__connections.at(-1)); });
    expect(route).toMatch(/host|srflx|prflx/);
    expect(route).not.toContain('relay ↔');
    const downloads = [];
    d.receiver.on('download', download => downloads.push(download));
    const transferStart = performance.now();
    await d.receiver.locator('#accept').click();
    await expect(d.sender.locator('#devices')).toHaveAttribute('data-view', 'complete', { timeout: 40000 });
    await expect(d.receiver.locator('#transfer-status')).toBeHidden();
    await expect(d.receiver.locator('#devices')).toHaveAttribute('data-view', 'complete');
    await expect(d.sender.locator('#activity-peer')).toHaveText('Sent');
    await expect(d.receiver.locator('#activity-peer')).toHaveText('Received');
    await expect(d.sender.locator('.file-progress:visible')).toHaveCount(0);
    await expect(d.receiver.locator('.file-progress:visible')).toHaveCount(0);
    const finished = performance.now();
    await expect.poll(() => downloads.length).toBe(2);
    const failures = await Promise.all(downloads.map(download => download.failure()));
    const received = await d.receiver.evaluate(async () => Promise.all(window.__receivedBlobs.map(async blob => Array.from(new Uint8Array(await blob.arrayBuffer())))));
    expect(Buffer.from(received[0])).toEqual(expected);
    expect(received[1].length).toBe(0);
    for (let index = 0; index < downloads.length; index++) if (!failures[index]) {
      expect(await readFile(await downloads[index].path())).toEqual(index === 0 ? expected : Buffer.alloc(0));
    }
    await expect(d.sender.locator('#security-code')).toHaveText('--- ---');
    await expect(d.receiver.locator('#security-code')).toHaveText('--- ---');
    await d.sender.locator('#done').click();
    await expect(d.sender.locator('.peer')).toBeEnabled();
    const manual = d.receiver.waitForEvent('download');
    await d.receiver.locator('#download-list a').first().click();
    const manualDownload = await manual;
    const manualFailure = await manualDownload.failure();
    if (!manualFailure) expect(await readFile(await manualDownload.path())).toEqual(expected);
    await d.receiver.locator('#done').click();
    await expect(d.receiver.locator('#download-list a')).toHaveCount(0);
    expect(d.failures).toEqual([]);
    expect(d.frames.length).toBeGreaterThan(2);
    expect(d.frames.every(frame => typeof frame === 'string' && !frame.includes(marker) && !frame.includes('onerror=alert') && !frame.includes('empty.🪐'))).toBe(true);
    const result = { browser: testInfo.project.name, bytes: expected.length, discoveryAndConnectionMs: connected - started, transferMs: finished - transferStart, mibPerSecond: expected.length / 1048576 / ((finished - transferStart) / 1000), route, downloadFailures: failures, manualDownloadFailure: manualFailure, repetitions: 1, note: 'Loopback contexts, includes UI acknowledgment and download creation; not a cross-device benchmark. Byte comparison reads the completed receiver Blob when the host blocks saving.' };
    await mkdir('.private/benchmarks', { recursive: true });
    await writeFile(path.join('.private/benchmarks', `${testInfo.project.name}.json`), JSON.stringify(result, null, 2));
  } finally { await d.close(); }
});

test('decline sends no content; a new manual transfer can start', async ({ browser }) => {
  test.skip(!await supportsTransfers(browser), 'This Playwright engine build has no WebRTC DataChannel support.');
  const d = await devices(browser);
  try {
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles({ name: 'declined.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(12) });
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await d.receiver.locator('#decline').click();
    await expect(d.sender.locator('#transfer-status')).toContainText('declined');
    await expect(d.receiver.locator('#panel-title')).toHaveText('1 Nearby devices');
    await expect(d.receiver.locator('#downloads')).toBeHidden();
    await expect(d.sender.locator('.peer')).toBeEnabled();
    await d.sender.locator('#done').click();
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles({ name: 'retry.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('manual retry') });
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await d.receiver.locator('#accept').click();
    await expect(d.sender.locator('#devices')).toHaveAttribute('data-view', 'complete');
    expect(d.failures).toEqual([]);
  } finally { await d.close(); }
});

test('per-file sender progress completes an empty file while the next file is paused', async ({ browser }) => {
  test.skip(!await supportsTransfers(browser), 'This engine has no WebRTC DataChannels.');
  const d = await devices(browser);
  try {
    await d.sender.evaluate(() => {
      const read = Blob.prototype.arrayBuffer;
      let reads = 0;
      Blob.prototype.arrayBuffer = async function () {
        if (++reads === 2) await new Promise(resolve => { window.__resumeRead = resolve; });
        return read.call(this);
      };
    });
    const chooser = d.sender.waitForEvent('filechooser');
    await d.sender.locator('.peer').click();
    await (await chooser).setFiles([
      {name:'first-empty.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)},
      {name:'partial.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(256*1024,42)},
      {name:'last-empty.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)},
    ]);
    await d.receiver.locator('#accept').click();
    await expect(d.sender.locator('#transfer-files progress').nth(0)).toHaveJSProperty('value',100);
    await expect.poll(()=>d.sender.locator('#transfer-files progress').nth(1).evaluate(bar=>bar.value)).toBeGreaterThan(0);
    expect(await d.sender.locator('#transfer-files progress').nth(1).evaluate(bar=>bar.value)).toBeLessThan(100);
    await expect(d.sender.locator('#transfer-files progress').nth(2)).toHaveJSProperty('value',0);
    await d.sender.evaluate(()=>window.__resumeRead());
    await expect(d.sender.locator('#devices')).toHaveAttribute('data-view','complete');
    await expect(d.receiver.locator('#devices')).toHaveAttribute('data-view','complete');
    expect(await d.sender.locator('#transfer-files progress').evaluateAll(bars=>bars.map(bar=>bar.value))).toEqual([100,100,100]);
    await d.receiver.locator('#done').click();
    await expect(d.receiver.locator('#download-list li')).toHaveCount(0);
    expect(d.failures).toEqual([]);
  } finally { await d.close(); }
});

test('responsive dark-only appearance, keyboard controls, base paths and no browser persistence', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/hopvium/');
  await expect(page.locator('h1')).toHaveText('Hopvium');
  await expect(page.locator('#self-name')).not.toHaveText('Connecting…');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dark = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(dark);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#devices')).toBeFocused();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }))).toEqual({ local: 0, session: 0, cookies: '' });
  expect(requests.every(url => url.startsWith('http://127.0.0.1:8788/hopvium/'))).toBe(true);
  // Exercise the persisted-pageshow recovery handler; this does not simulate the browser's cache internals.
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))),
  ]);
  await expect(page.locator('#self-name')).not.toHaveText('Connecting…');
});

test('temporary discovery loss cancels approval, recovers the name and never resends files', async ({ browser }) => {
  test.skip(!await supportsTransfers(browser), 'This engine has no WebRTC DataChannels.');
  const d = await devices(browser);
  try {
    const name = await d.sender.locator('#self-name').textContent();
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles({ name: 'do-not-resend.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic') });
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await d.sender.evaluate(() => window.__sockets[0].close());
    await expect(d.receiver.locator('#incoming')).toBeHidden();
    await expect(d.sender.locator('#self-name')).toHaveText(name);
    await expect(d.sender.locator('.peer')).toHaveCount(1);
    await expect(d.receiver.locator('#downloads')).toBeHidden();
    expect(await d.sender.evaluate(() => window.__connections.every(connection => connection.connectionState === 'closed'))).toBe(true);
    await d.sender.locator('#done').click();
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles({ name: 'manual.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('manual restart') });
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await d.receiver.locator('#accept').click();
    await expect(d.sender.locator('#devices')).toHaveAttribute('data-view', 'complete');
  } finally { await d.close(); }
});

test('interrupting an accepted transfer reports failure and closes its connection', async ({ browser }) => {
  test.skip(!await supportsTransfers(browser), 'This engine has no WebRTC DataChannels.');
  const d = await devices(browser);
  try {
    await d.sender.locator('.peer').click();
    await d.sender.locator('#files').setInputFiles({ name: 'interrupt.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8 * 1024 * 1024, 123) });
    await expect(d.receiver.locator('#incoming')).toBeVisible();
    await d.receiver.locator('#accept').click();
    await expect.poll(() => d.receiver.locator('#transfer-files progress').first().evaluate(progress => progress.value)).toBeGreaterThan(0);
    await d.sender.evaluate(() => window.__connections.at(-1).close());
    await expect(d.sender.locator('#transfer-status')).not.toContainText('Transfer complete');
    await expect(d.receiver.locator('#transfer-status')).toContainText(/interrupted|ended|lost|failed/i);
    await expect(d.receiver.locator('#downloads')).toBeHidden();
    await expect(d.sender.locator('.peer')).toBeEnabled();
    expect(await d.sender.evaluate(() => window.__connections.every(connection => connection.connectionState === 'closed'))).toBe(true);
  } finally { await d.close(); }
});
