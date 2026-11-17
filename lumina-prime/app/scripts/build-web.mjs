// Export web sans fenêtre d'indisponibilité pour la passerelle (desktop-call-page.mjs, serve-preview.mjs).
// `expo export` vide son dossier de sortie au démarrage : exporter directement dans dist/ faisait
// répondre 404 à /desktop-call pendant toute la compilation (~1 min), et l'iframe d'appel du desktop
// recevait `load` sans `mind.call.ready` (incident « Écran d'appel indisponible », 17 nov. 2026).
// Publier les ressources avant index.html conserve les pages déjà ouvertes.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const at = name => fileURLToPath(new URL(`../${name}`, import.meta.url));
const dist = at('dist'), next = at('dist.next');

rmSync(next, { recursive: true, force: true });
const run = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist.next', ...process.argv.slice(2)],
  { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
if (run.status !== 0 || !existsSync(at('dist.next/index.html'))) {
  console.error('Export web échoué : dist/ inchangé.');
  process.exit(run.status || 1);
}

// The gateway or Windows may hold dist/ open. Replace individual files
// atomically and retain older hashed bundles for pending lazy imports.
function rename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
function publish(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (source === next && entry.name === 'index.html') continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) publish(from, to);
    else {
      if (/[.-][a-f0-9]{32}\./.test(entry.name) && existsSync(to) && statSync(to).size === statSync(from).size) continue;
      const pending = to + '.publishing';
      copyFileSync(from, pending);
      rename(pending, to);
    }
  }
}
publish(next, dist);
copyFileSync(path.join(next, 'index.html'), path.join(dist, 'index.html.publishing'));
rename(path.join(dist, 'index.html.publishing'), path.join(dist, 'index.html'));
console.log('Export web publié dans dist/.');
