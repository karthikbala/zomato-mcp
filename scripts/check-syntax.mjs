import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const directory of ['src', 'scripts', 'test']) {
  for (const entry of await readdir(directory)) {
    if (!/\.(js|mjs)$/.test(entry)) continue;
    const file = `${directory}/${entry}`;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');
