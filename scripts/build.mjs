import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function build(signal = process.env.HOPVIUM_SIGNAL_URL ?? '') {
  let origin = '';
  if (signal) {
    const url = new URL(signal);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.pathname !== '/signal' || url.search || url.hash || url.username || url.password ||
        !(url.protocol === 'wss:' || process.env.HOPVIUM_DEV === '1' && loopback && url.protocol === 'ws:')) {
      throw new Error('Use a wss:// endpoint ending in /signal. Local ws:// requires HOPVIUM_DEV=1.');
    }
    origin = url.origin;
  }
  const dist = path.join(root, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'frontend'), dist, { recursive: true });
  await cp(path.join(root, 'shared'), path.join(dist, 'shared'), { recursive: true });
  for (const file of await readdir(dist)) if (file.endsWith('.js')) {
    const filename = path.join(dist, file);
    await writeFile(filename, (await readFile(filename, 'utf8')).replaceAll("'../shared/", "'./shared/"));
  }
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  await writeFile(path.join(dist, 'index.html'), html.replace('__SIGNAL_ORIGIN__', origin));
  await writeFile(path.join(dist, 'config.js'), `export const SIGNAL_URL = ${JSON.stringify(signal || null)};\n`);
  await writeFile(path.join(dist, '.nojekyll'), '');
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
  process.stdout.write('Built static frontend in dist/ (publish at /hopvium/).\n');
}
