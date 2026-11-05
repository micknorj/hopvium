import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const temporary = path.resolve('.private', 'tmp');
await mkdir(temporary, { recursive: true });
await mkdir('.private/downloads', { recursive: true });
const install = process.argv[2] === '--install';
const args = install ? ['install', 'chromium', 'firefox', 'webkit'] : ['test', ...process.argv.slice(2)];
const child = spawn(process.execPath, [path.resolve('node_modules/playwright/cli.js'), ...args], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.resolve('.private/browsers'), TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false' },
});
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('exit', code => { process.exitCode = code ?? 1; });
