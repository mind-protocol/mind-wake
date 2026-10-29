// Harnais du spike S2 : prépare des fixtures factices, lance la sonde dans plusieurs confinements,
// mesure la terminaison d'arborescence, nettoie tout, puis écrit results/<horodatage>.json.
//
//   node spikes/isolation/run-tests.mjs [--iterations 10]
//
// Aucun droit administrateur requis. Modifications hors du dossier du spike, toutes temporaires :
// profil AppContainer de l'utilisateur courant (créé puis supprimé), fichiers sondes éventuels dans
// C:\Users\Public et %TEMP% (supprimés), clé HKCU\Software\MindWakeS2Probe si une sonde réussissait (supprimée).

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, '.work');
const ROOT = path.join(WORK, 'root');
const OUTSIDE = path.join(WORK, 'outside');
const RUNTIME = path.join(WORK, 'runtime');
const BUILD = path.join(HERE, 'build');
const SANDBOX = path.join(BUILD, 'sandbox.exe');
const NAME = 'mindwake.spike.s2';
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const ITER = Number(process.argv[process.argv.indexOf('--iterations') + 1] || 10) || 10;

const results = { startedAt: new Date().toISOString(), environment: {}, runs: [], kill: [], cleanup: {} };
const log = (...a) => console.log(...a);

// ---------- préparation ----------

function build() {
  fs.mkdirSync(BUILD, { recursive: true });
  execFileSync(CSC, ['/nologo', '/optimize', '/platform:x64', `/out:${SANDBOX}`, path.join(HERE, 'src', 'Sandbox.cs')], { stdio: 'inherit' });
}

function resetWork() {
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const d of [ROOT, path.join(ROOT, 'tmp'), OUTSIDE, RUNTIME]) fs.mkdirSync(d, { recursive: true });
  // node.exe de Program Files n'accorde rien aux AppContainers : on en copie une version dans une racine en lecture seule.
  fs.copyFileSync(process.execPath, path.join(RUNTIME, 'node.exe'));
  fs.copyFileSync(path.join(HERE, 'probe.mjs'), path.join(RUNTIME, 'probe.mjs'));
  fs.copyFileSync(SANDBOX, path.join(RUNTIME, 'sandbox.exe'));
  // Secret factice : hérite des ACL du profil utilisateur, comme un vrai fichier de l'utilisateur.
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'FAKE-SECRET-' + crypto.randomBytes(8).toString('hex'));
  fs.symlinkSync(OUTSIDE, path.join(ROOT, 'escape-j'), 'junction');
  try {
    fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(ROOT, 'escape-s'), 'file');
    results.environment.preexistingSymlink = true;
  } catch (e) {
    results.environment.preexistingSymlink = `impossible sans privilège ni mode développeur (${e.code})`;
  }
}

function environment() {
  const ver = spawnSync('cmd.exe', ['/c', 'ver'], { encoding: 'utf8' }).stdout.trim();
  Object.assign(results.environment, {
    os: ver, release: os.release(), node: process.version, arch: process.arch,
    elevated: spawnSync('net.exe', ['session'], { stdio: 'ignore' }).status === 0,
  });
}

// ---------- exécution ----------

function sandboxArgs(kind, extra = []) {
  const env = [
    'SystemRoot=C:\\Windows', `PATH=${RUNTIME};C:\\Windows\\System32`,
    `TEMP=${path.join(ROOT, 'tmp')}`, `TMP=${path.join(ROOT, 'tmp')}`,
    // CreateProcess en AppContainer échoue (ERROR_ENVVAR_NOT_FOUND) si le bloc ne contient ni USERPROFILE ni LOCALAPPDATA.
    `USERPROFILE=${ROOT}`, `LOCALAPPDATA=${ROOT}`,
  ];
  const mode = kind === 'lowil' || kind === 'plain' ? kind : 'run';
  const a = [mode, '--name', NAME, '--rw', ROOT, '--ro', RUNTIME, '--cwd', ROOT, ...env.flatMap((e) => ['--env', e])];
  // LPAC : Node échoue à WSAStartup sans la capacité nommée registryRead.
  if (kind === 'lpac') a.push('--lpac', '--cap', 'name:registryRead');
  if (kind === 'appcontainer+internetClient') a.push('--cap', 'internetClient');
  return [...a, ...extra];
}

function launch(kind, probeArgs, extra = []) {
  // --preserve-symlinks* : sinon Node appelle realpath sur chaque ancêtre et lstat('C:\') est refusé en AppContainer.
  const node = [path.join(RUNTIME, 'node.exe'), '--preserve-symlinks-main', '--preserve-symlinks', path.join(RUNTIME, 'probe.mjs')];
  const argv = [...sandboxArgs(kind, extra), '--', ...node, ...probeArgs];
  const child = spawn(SANDBOX, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { kind, probes: [], events: [], other: [], child };
  const lines = (stream, fn) => { let buf = ''; stream.setEncoding('utf8'); stream.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } }); };
  lines(child.stdout, (l) => { if (l.startsWith('@@PROBE ')) { const o = JSON.parse(l.slice(8)); run.probes.push(o); run.onProbe?.(o); } else if (l) run.other.push(l); });
  lines(child.stderr, (l) => { if (l.startsWith('@@SANDBOX ')) { const o = JSON.parse(l.slice(10)); run.events.push(o); run.onEvent?.(o); } else if (l) run.other.push(l); });
  run.exited = new Promise((r) => child.on('exit', (code) => { run.exitCode = code; r(); }));
  return run;
}

const strip = ({ child, onProbe, onEvent, exited, ...rest }) => rest;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function probeRun(kind, port) {
  const run = launch(kind, ['--mode', 'probe', '--root', ROOT, '--outside', OUTSIDE, '--port', String(port),
    '--helper', path.join(RUNTIME, 'sandbox.exe'), '--harness-pid', String(process.pid), '--user-temp', os.tmpdir()],
    ['--timeout-ms', '60000']);
  await run.exited;
  results.runs.push(strip(run));
  log(`\n[${kind}]`);
  for (const p of run.probes) log(`  ${p.outcome.padEnd(8)} ${p.test}${p.code ? '  (' + p.code + ')' : ''}`);
  const err = run.events.find((e) => e.event === 'error');
  if (err) log('  ERREUR lanceur:', err.message);
  cleanupProbeArtifacts();
}

function cleanupProbeArtifacts() {
  for (const f of [path.join(OUTSIDE, 'pwned.txt'), path.join(OUTSIDE, 'pwned-j.txt'), 'C:\\Users\\Public\\mindwake-s2-probe.txt', path.join(os.tmpdir(), 'mindwake-s2-probe.txt')]) {
    if (fs.existsSync(f)) { fs.rmSync(f); (results.cleanup.removedProbeFiles ??= []).push(f); }
  }
  for (const f of ['inside.txt', 'j2', 's2', 'hl']) {
    const p = path.join(ROOT, f);
    // Jamais de suppression récursive à travers un lien : on retire le lien lui-même.
    try { fs.lstatSync(p); } catch { continue; }
    try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  }
  if (spawnSync('reg.exe', ['query', 'HKCU\\Software\\MindWakeS2Probe'], { stdio: 'ignore' }).status === 0) {
    spawnSync('reg.exe', ['delete', 'HKCU\\Software\\MindWakeS2Probe', '/f'], { stdio: 'ignore' });
    results.cleanup.removedRegistryKey = true;
  }
}

// Lance une arborescence non coopérative, attend qu'elle soit complète, la termine selon `how`, mesure.
async function killRun(kind, how, iteration) {
  const extra = how === 'timeout' ? ['--timeout-ms', '3000'] : ['--timeout-ms', '60000'];
  const run = launch(kind, ['--mode', 'tree', '--root', ROOT, '--children', '3'], extra);
  const ready = await new Promise((resolve) => {
    run.onProbe = (o) => { if (o.ready) resolve(o); };
    run.exited.then(() => resolve(null));
  });
  if (!ready) { results.kill.push({ kind, how, iteration, error: 'arborescence non prête', ...strip(run) }); return; }
  // Témoin : le harnais doit voir l'arborescence vivante avant la terminaison, sinon la mesure ne vaut rien.
  const aliveBefore = ready.pids.filter(alive).length;
  const t0 = process.hrtime.bigint();
  if (how === 'command') run.child.stdin.write('kill\n');
  if (how === 'launcher-killed') run.child.kill(); // TerminateProcess du lanceur : le noyau ferme le handle du job
  while (ready.pids.some(alive)) await new Promise((r) => setImmediate(r));
  const observedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await run.exited;
  const done = run.events.find((e) => e.event === 'done');
  const entry = { kind, how, iteration, pids: ready.pids.length, aliveBefore, observedMs: +observedMs.toFixed(3), killToZeroMs: done?.killToZeroMs ?? null, killReason: done?.killReason ?? null, survivors: ready.pids.filter(alive) };
  results.kill.push(entry);
  log(`  ${how.padEnd(16)} #${iteration} ${entry.aliveBefore}/${entry.pids} vivants  observé=${entry.observedMs} ms  noyau=${entry.killToZeroMs} ms  survivants=${entry.survivors.length}`);
}

async function limitRun() {
  const run = launch('appcontainer', ['--mode', 'bomb', '--root', ROOT, '--children', '20'], ['--max-procs', '5', '--timeout-ms', '30000']);
  await new Promise((resolve) => { run.onProbe = (o) => { if (o.test) resolve(); }; run.exited.then(resolve); });
  run.child.stdin.write('kill\n');
  await run.exited;
  results.runs.push(strip(run));
  const p = run.probes[0];
  log(`\n[limite de processus = 5]  ${p?.outcome} ${JSON.stringify(p?.detail)}  évènements limite=${run.events.filter((e) => e.event === 'active-process-limit').length}`);
}

// ---------- programme ----------

const server = net.createServer((s) => { results.loopbackConnectionsAccepted = (results.loopbackConnectionsAccepted ?? 0) + 1; s.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.MIND_WAKE_FAKE_SECRET = 'FAKE-ENV-' + crypto.randomBytes(6).toString('hex');

try {
  build();
  environment();
  resetWork();
  log('Environnement :', JSON.stringify(results.environment));

  for (const kind of ['plain', 'lowil', 'appcontainer', 'lpac', 'appcontainer+internetClient']) await probeRun(kind, port);
  results.loopbackConnectionsAccepted ??= 0;
  log(`\nConnexions loopback acceptées par le harnais (toutes exécutions) : ${results.loopbackConnectionsAccepted}`);

  await limitRun();

  log('\n[terminaison d\'arborescence, AppContainer, 7 processus par arbre]');
  for (let i = 1; i <= ITER; i++) await killRun('appcontainer', 'command', i);
  for (let i = 1; i <= Math.ceil(ITER / 2); i++) await killRun('appcontainer', 'launcher-killed', i);
  await killRun('appcontainer', 'timeout', 1);
  await killRun('lpac', 'command', 1);
} finally {
  server.close();
  // Le lanceur supprime le profil en sortie normale ; après un TerminateProcess il faut le faire ici.
  const c = spawnSync(SANDBOX, ['cleanup', '--name', NAME], { encoding: 'utf8' });
  results.cleanup.profileDelete = c.stderr.trim();
  cleanupProbeArtifacts();
  fs.rmSync(WORK, { recursive: true, force: true });
  results.cleanup.workRemoved = !fs.existsSync(WORK);
  results.finishedAt = new Date().toISOString();
  const summary = (how) => {
    const xs = results.kill.filter((k) => k.how === how && k.observedMs != null).map((k) => k.observedMs).sort((a, b) => a - b);
    const ks = results.kill.filter((k) => k.how === how && k.killToZeroMs >= 0).map((k) => k.killToZeroMs).sort((a, b) => a - b);
    return xs.length ? { n: xs.length, observedMedianMs: xs[Math.floor(xs.length / 2)], observedMaxMs: xs.at(-1), kernelMedianMs: ks[Math.floor(ks.length / 2)] ?? null, kernelMaxMs: ks.at(-1) ?? null, survivors: results.kill.filter((k) => k.how === how).reduce((n, k) => n + (k.survivors?.length ?? 0), 0) } : null;
  };
  results.killSummary = { command: summary('command'), launcherKilled: summary('launcher-killed'), timeout: summary('timeout') };
  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
  const out = path.join(HERE, 'results', results.startedAt.replace(/[:.]/g, '-') + '.json');
  // Les chemins du profil sont remplacés par %USERPROFILE% pour ne pas publier le nom du compte.
  const home = JSON.stringify(os.homedir()).slice(1, -1);
  fs.writeFileSync(out, JSON.stringify(results, null, 2).split(home).join('%USERPROFILE%'));
  log('\nRésumé terminaison :', JSON.stringify(results.killSummary, null, 1));
  log('Nettoyage :', JSON.stringify(results.cleanup));
  log('Résultats :', path.relative(process.cwd(), out));
}
