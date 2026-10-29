// Sonde exécutée À L'INTÉRIEUR du confinement. Elle tente réellement chaque sortie de périmètre et
// rapporte le résultat brut du système (code d'erreur). Aucune vérification applicative : si le système
// laisse passer, la sonde réussit et le rapport l'indique comme une fuite.
//
// node probe.mjs --mode probe|tree|bomb --root <dir> --outside <dir> [--port n] [--helper exe]
//                [--harness-pid n] [--user-temp dir] [--children n]

import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const emit = (o) => process.stdout.write('@@PROBE ' + JSON.stringify(o) + '\n');
const errInfo = (e) => ({ code: e.code ?? null, errno: e.errno ?? null, message: String(e.message).slice(0, 400) });

function attempt(test, fn) {
  try {
    emit({ test, outcome: 'allowed', detail: fn() ?? null });
  } catch (e) {
    emit({ test, outcome: 'denied', ...errInfo(e) });
  }
}

async function attemptAsync(test, fn) {
  try {
    emit({ test, outcome: 'allowed', detail: (await fn()) ?? null });
  } catch (e) {
    emit({ test, outcome: e.code === 'ETIMEOUT' ? 'timeout' : 'denied', ...errInfo(e) });
  }
}

function tcpConnect(host, port, ms = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })); }, ms);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve({ connected: true }); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function udpDnsQuery(host, ms = 2000) {
  // Requête DNS minimale (A example.com) envoyée directement, sans passer par le client DNS système.
  const q = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex');
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(Object.assign(new Error('no response'), { code: 'ETIMEOUT' })); }, ms);
    s.once('message', () => { clearTimeout(t); s.close(); resolve({ response: true }); });
    s.once('error', (e) => { clearTimeout(t); s.close(); reject(e); });
    s.send(q, 53, host, (e) => { if (e) { clearTimeout(t); s.close(); reject(e); } });
  });
}

// En AppContainer, les pipes stdio de child_process bloquent Node (libuv crée ses pipes nommés dans
// l'espace global, ce qui est refusé, et réessaie indéfiniment). Les sorties passent donc par un fichier.
function run(file, argv) {
  const out = path.join(args.root, 'tmp', `out-${process.pid}-${Date.now()}.txt`);
  const fd = fs.openSync(out, 'w');
  try {
    const r = spawnSync(file, argv, { stdio: ['ignore', fd, fd], timeout: 10000 });
    if (r.error) throw r.error;
    return { status: r.status, text: fs.readFileSync(out, 'latin1') };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(out, { force: true });
  }
}

function procProbe(pid) {
  return JSON.parse(run(args.helper, ['probe-proc', String(pid)]).text);
}

function regCmd(argv) {
  const r = run('C:\\Windows\\System32\\reg.exe', argv);
  if (r.status !== 0) throw Object.assign(new Error(r.text.trim().split(/\r?\n/)[0]), { code: 'EXIT_' + r.status });
  return { status: r.status, lines: r.text.split(/\r?\n/).filter(Boolean).length };
}

function pipeListen(name) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(name, () => srv.close(() => resolve({ listening: true })));
  });
}

async function probe() {
  const root = args.root, outside = args.outside;
  const secret = path.join(outside, 'secret.txt');
  const bytes = (p) => ({ bytes: fs.readFileSync(p).length }); // jamais le contenu

  // Témoins positifs : la racine accordée doit rester utilisable.
  attempt('fs.write.inside', () => fs.writeFileSync(path.join(root, 'inside.txt'), 'ok'));
  attempt('fs.read.inside', () => bytes(path.join(root, 'inside.txt')));

  // Fichiers hors racine.
  attempt('fs.write.outside', () => fs.writeFileSync(path.join(outside, 'pwned.txt'), 'x'));
  attempt('fs.read.secret', () => bytes(secret));
  attempt('fs.list.outside', () => ({ entries: fs.readdirSync(outside).length }));
  if (args['user-temp']) attempt('fs.write.userTemp', () => fs.writeFileSync(path.join(args['user-temp'], 'mindwake-s2-probe.txt'), 'x'));
  attempt('fs.write.public', () => fs.writeFileSync('C:\\Users\\Public\\mindwake-s2-probe.txt', 'x'));

  // Liens : jonction préexistante (posée par le harnais), puis liens créés par la sonde.
  attempt('link.junction.preexisting.read', () => bytes(path.join(root, 'escape-j', 'secret.txt')));
  attempt('link.junction.preexisting.write', () => fs.writeFileSync(path.join(root, 'escape-j', 'pwned-j.txt'), 'x'));
  if (fs.existsSync(path.join(root, 'escape-s'))) attempt('link.symlink.preexisting.read', () => bytes(path.join(root, 'escape-s')));
  attempt('link.junction.create', () => fs.symlinkSync(outside, path.join(root, 'j2'), 'junction'));
  attempt('link.junction.created.read', () => bytes(path.join(root, 'j2', 'secret.txt')));
  attempt('link.symlink.create', () => fs.symlinkSync(secret, path.join(root, 's2'), 'file'));
  attempt('link.symlink.created.read', () => bytes(path.join(root, 's2')));
  attempt('link.hardlink.create', () => fs.linkSync(secret, path.join(root, 'hl')));
  attempt('link.hardlink.created.read', () => bytes(path.join(root, 'hl')));

  // Réseau.
  if (args.port) await attemptAsync('net.tcp.loopback', () => tcpConnect('127.0.0.1', Number(args.port)));
  await attemptAsync('net.tcp.external', () => tcpConnect('1.1.1.1', 443));
  await attemptAsync('net.udp.external', () => udpDnsQuery('1.1.1.1'));
  await attemptAsync('net.dns.lookup', async () => ({ address: (await dns.lookup('example.com')).address }));

  // IPC locale : pipe nommé dans l'espace global contre l'espace LOCAL propre au conteneur.
  await attemptAsync('ipc.pipe.global', () => pipeListen(`\\\\.\\pipe\\mindwake-s2-${process.pid}`));
  await attemptAsync('ipc.pipe.local', () => pipeListen(`\\\\.\\pipe\\LOCAL\\mindwake-s2-${process.pid}`));

  // Secrets ambiants : environnement hérité, registre utilisateur, mémoire des processus parents.
  attempt('env.inherited', () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('MIND_WAKE_FAKE'));
    if (leaked.length === 0) {
      const seen = Object.keys(process.env).join(',');
      throw Object.assign(new Error(`absent; variables: ${seen}; TEMP=${process.env.TEMP}; LOCALAPPDATA=${process.env.LOCALAPPDATA}`), { code: 'ABSENT' });
    }
    return { leaked };
  });
  attempt('env.registry.hkcu', () => regCmd(['query', 'HKCU\\Environment']));
  attempt('reg.write.hkcu', () => regCmd(['add', 'HKCU\\Software\\MindWakeS2Probe', '/f']));
  // Services intermédiaires qui pourraient lancer du code hors du job (indicateurs en lecture seule :
  // aucune tâche n'est créée, aucune distribution n'est démarrée).
  attempt('broker.wsl.list', () => {
    const r = run('C:\\Windows\\System32\\wsl.exe', ['--list', '--quiet']);
    if (r.status !== 0) throw Object.assign(new Error(r.text.replace(/\0/g, '').trim().slice(0, 200)), { code: 'EXIT_' + r.status });
    return { status: r.status };
  });
  attempt('broker.schtasks.query', () => {
    const r = run('C:\\Windows\\System32\\schtasks.exe', ['/query', '/fo', 'csv']);
    if (r.status !== 0) throw Object.assign(new Error(r.text.trim().split(/\r?\n/)[0]), { code: 'EXIT_' + r.status });
    return { status: r.status, lines: r.text.split(/\r?\n/).filter(Boolean).length };
  });
  if (args.helper) {
    for (const [label, pid] of [['launcher', process.ppid], ['harness', args['harness-pid']]]) {
      if (!pid) continue;
      attempt(`proc.${label}.open`, () => {
        const r = procProbe(pid);
        const opened = ['vmread', 'terminate'].filter((k) => r[k].opened);
        if (opened.length === 0) throw Object.assign(new Error(JSON.stringify(r)), { code: 'ACCESS_DENIED' });
        return r;
      });
    }
  }
}

// Arborescence de descendants qui ne coopère pas : chaque nœud écrit son PID puis tourne indéfiniment.
const SLEEPER = `require('fs').writeFileSync(require('path').join(process.argv[1], String(process.pid)), '');setInterval(()=>{},1e6)`;
const PARENT = `const {spawn}=require('child_process');
spawn(process.execPath,['-e',${JSON.stringify(SLEEPER)},process.argv[1]],{detached:true,stdio:'ignore'}).unref();
${SLEEPER}`;

async function tree() {
  const pidDir = path.join(args.root, 'pids');
  fs.rmSync(pidDir, { recursive: true, force: true });
  fs.mkdirSync(pidDir);
  const n = Number(args.children ?? 3);
  for (let i = 0; i < n; i++) {
    // detached: processus détaché (nouveau groupe, sans console) : il reste pourtant dans le Job Object.
    spawn(process.execPath, ['-e', PARENT, pidDir], { detached: true, stdio: 'ignore' }).unref();
  }
  fs.writeFileSync(path.join(pidDir, String(process.pid)), '');
  const expected = 1 + 2 * n;
  const t0 = Date.now();
  while (fs.readdirSync(pidDir).length < expected && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20));
  emit({ ready: true, pids: fs.readdirSync(pidDir).map(Number) });
  setInterval(() => {}, 1e6);
}

async function bomb() {
  const n = Number(args.children ?? 20);
  let ok = 0; const errors = {};
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => {
      const fail = (e) => { errors[e.code] = (errors[e.code] ?? 0) + 1; resolve(); };
      try {
        // Au-delà de la limite du job, CreateProcess échoue et Node lève une erreur synchrone (UNKNOWN).
        const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
        c.once('spawn', () => { ok++; resolve(); });
        c.once('error', fail);
      } catch (e) { fail(e); }
    });
  }
  emit({ test: 'proc.spawn.limit', outcome: ok < n ? 'denied' : 'allowed', detail: { requested: n, spawned: ok, errors } });
  process.exit(0);
}

const modes = { probe, tree, bomb };
await modes[args.mode ?? 'probe']();
