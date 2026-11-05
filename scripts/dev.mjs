import http from 'node:http';
import { readFile, mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { build } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.HOPVIUM_DEV = '1';
const dist = await build(process.env.HOPVIUM_SIGNAL_URL ?? 'ws://127.0.0.1:8787/signal');
await mkdir('.private', { recursive: true });
try { await access('.private/.dev.vars'); } catch {
  await writeFile('.private/.dev.vars', `ROOM_HMAC_KEY=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
}
const config = JSON.parse(await readFile('worker/wrangler.jsonc', 'utf8'));
config.main = '../worker/index.js';
config.vars.ALLOWED_ORIGINS = 'http://127.0.0.1:8788,http://localhost:8788';
await writeFile('.private/wrangler.json', JSON.stringify(config));
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--config', '.private/wrangler.json', '--port', '8787', '--persist-to', '.private/cloudflare', '--log-level', 'error'], {
  cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', BROWSER: 'none',
    XDG_CONFIG_HOME: path.join(root, '.private', 'tool-config'), WRANGLER_LOG_PATH: path.join(root, '.private', 'wrangler.log') },
});
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' || !url.pathname.startsWith('/hopvium/')) {
      response.writeHead(404); response.end(); return;
    }
    const relative = decodeURIComponent(url.pathname.slice('/hopvium/'.length)) || 'index.html';
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(dist + path.sep)) { response.writeHead(404); response.end(); return; }
    const body = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(8788, '127.0.0.1', () => process.stdout.write('Local: http://127.0.0.1:8788/hopvium/\n'));
const stop = () => { worker.kill(); server.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
worker.on('exit', code => { if (code) { server.close(); process.exitCode = code; } });
