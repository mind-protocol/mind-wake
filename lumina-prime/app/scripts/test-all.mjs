import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function discoverTests(root = appRoot) {
  const files = [];
  function visit(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.runtime', '.git', 'dist'].includes(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (/\.test\.(mjs|ts)$/.test(item.name)) files.push(path);
    }
  }
  for (const name of ['src', 'server', 'scripts', 'tests']) visit(join(root, name));
  return files.sort();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = discoverTests();
  if (!files.length) throw new Error('Aucun test découvert.');
  console.log(`Tests découverts : ${files.length} fichiers.`);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], {
    cwd: appRoot, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
