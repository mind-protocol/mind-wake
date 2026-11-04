import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { appRoot } from './test-all.mjs';

const require = createRequire(join(appRoot, 'package.json'));
const output = resolve(process.env.MIND_WAKE_JOB_OUTPUT ?? join(appRoot, '.runtime', 'check-dev', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(output, { recursive: true });
function fingerprint() {
  const hash = createHash('sha256');
  function visit(path) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.runtime', '.git', 'dist', '.expo'].includes(item.name)) continue;
      const file = join(path, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.(tsx?|m?js|json)$/.test(item.name)) hash.update(file.slice(appRoot.length)).update(readFileSync(file));
    }
  }
  visit(appRoot);
  return hash.digest('hex');
}
const report = { startedAt: new Date().toISOString(), sourceBefore: fingerprint(), steps: [], status: 'running', output };
function save() { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
save();
async function run(name, args) {
  const started = Date.now();
  const log = [];
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: appRoot, windowsHide: true, env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { log.push(data); process.stdout.write(data); });
    child.on('error', (error) => { log.push(Buffer.from(String(error))); done(1); });
    child.on('close', (value) => done(value ?? 1));
  });
  writeFileSync(join(output, `${name}.log`), Buffer.concat(log));
  report.steps.push({ name, code, milliseconds: Date.now() - started }); save();
  return code === 0;
}
try {
  const expo = join(dirname(require.resolve('expo/package.json')), 'bin', 'cli');
  const typescript = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const eslint = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const steps = [
    ['tests', [join(appRoot, 'scripts', 'test-all.mjs')]],
    ['typecheck', [typescript, '--noEmit']],
    ['lint', [eslint, '.']],
    ['web-export', [expo, 'export', '--platform', 'web', '--output-dir', join(output, 'web')]],
  ];
  for (const [name, args] of steps) if (!await run(name, args)) { report.status = 'failed'; break; }
  if (report.status === 'running') {
    if (!existsSync(join(output, 'web', 'index.html'))) throw new Error('Export sans index.html.');
    report.status = 'passed';
  }
} catch (error) { report.status = 'failed'; report.error = String(error); }
report.sourceAfter = fingerprint();
report.sourceChanged = report.sourceBefore !== report.sourceAfter;
if (report.sourceChanged && report.status === 'passed') report.status = 'stale';
report.finishedAt = new Date().toISOString(); save();
console.log(`CHECK DEV : ${report.status} — ${join(output, 'report.json')}`);
process.exitCode = report.status === 'passed' ? 0 : 1;
