import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : `${directory}/${entry.name}`))).flat();
}
for (const file of (await Promise.all(['frontend', 'shared', 'worker', 'scripts', 'tests'].map(files))).flat()) {
  if (/\.(js|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.status) throw new Error(result.stderr);
  }
}
const frontend = (await Promise.all((await files('frontend')).filter(file => file.endsWith('.js')).map(file => readFile(file, 'utf8')))).join('\n');
if (/localStorage|indexedDB|document\.cookie|navigator\.sendBeacon|innerHTML|\beval\s*\(/.test(frontend)) throw new Error('Unexpected persistence or unsafe browser API.');
if (/turns?:\/|getUserMedia/.test(frontend)) throw new Error('Unexpected relay or media capture.');
console.log('Syntax and source boundary checks passed. These supplement behavioral tests.');
