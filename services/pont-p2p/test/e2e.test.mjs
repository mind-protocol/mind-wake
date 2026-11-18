// Pont pair-à-pair ⬡, niveau service : chaque colonie est un vrai processus `main.mjs` (celui que
// lance le daemon) avec son propre profil ; l'agent passe par les vrais outils MCP, l'humain par
// les vraies actions des Réglages. Reprend les 6 scénarios du prototype p2p-1930, plus :
// interrupteur désactivé → aucun réseau, « introuvable » vs « connexion impossible », réponse.
//
//   node --test services/pont-p2p/test/e2e.test.mjs                 (bootstrap DHT local, hors réseau)
//   MW_DHT=public node --test services/pont-p2p/test/e2e.test.mjs   (DHT publique d'Hyperswarm)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";
import { generateKeypair } from "../crypto.mjs";
import { pontAction } from "../settings.mjs";
import { pontPaths, readJson, fingerprint } from "../state.mjs";
import { colonyTopic } from "../p2p-node.mjs";
import { registerPontP2PTools } from "../../mcp/pont-p2p-tools.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.mjs");
const PEER = path.join(here, "peer-process.mjs");
const PUBLIC = process.env.MW_DHT === "public";
const T = PUBLIC ? 60_000 : 20_000;
let testnet, bootstrap, root;
const procs = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (fn, ms = T, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  throw new Error("délai dépassé");
};

function ipcClient(name, child) {
  procs.add(child);
  let rid = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  child.on("exit", () => procs.delete(child));
  child.on("message", (m) => {
    if (m.rid) { const p = pending.get(m.rid); pending.delete(m.rid); return m.error ? p.rej(new Error(m.error)) : p.res(m.result); }
    events.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  return {
    name, child, events,
    call: (cmd, args) => new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); child.send({ rid: id, cmd, args }); }),
    waitEvent: (pred, ms = T) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${name} : délai dépassé en attendant un événement`)); } }, ms);
      });
    },
    exited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

/** Profil d'une colonie : dossier de données + espace avec wakeups/. */
function profile(label) {
  const dataDir = path.join(root, label, "data");
  const wakeupsDir = path.join(root, label, "workspace", "wakeups");
  fs.mkdirSync(dataDir, { recursive: true });
  return { label, dataDir, wakeupsDir };
}

/** Lance le vrai service (comme le daemon) et attend « ready ». */
async function startService(p, { retryMs } = {}) {
  const env = { ...process.env, MW_P2P_TICK_MS: "200", ...(bootstrap ? { MW_P2P_BOOTSTRAP: JSON.stringify(bootstrap) } : {}), ...(retryMs ? { MW_P2P_RETRY_MS: String(retryMs) } : {}) };
  delete env.MIND_WAKE_DATA_DIR;
  const child = fork(MAIN, ["--data-dir", p.dataDir, "--wakeups-dir", p.wakeupsDir], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const c = ipcClient(p.label, child);
  await Promise.race([
    c.waitEvent((m) => m.event === "ready"),
    new Promise((_, rej) => child.once("exit", (code) => rej(new Error(`${p.label} : service sorti (code ${code}) : ${fs.readFileSync(pontPaths(p.dataDir).log, "utf8")}`)))),
  ]);
  p.svc = c;
  return c;
}

async function stopService(p) {
  const c = p.svc;
  if (!c || c.exited()) return;
  const done = new Promise((r) => c.child.once("exit", r));
  c.child.send({ cmd: "stop" });
  await done;
}

/** Colonie brute (tests de refus), clé générée dans son propre dossier. */
async function spawnPeer(label, name, extra = {}) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "key.json");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JSON.stringify(await generateKeypair()));
  const cfg = { name, keyFile, stateDir: path.join(dir, "etat"), wakeupsDir: path.join(dir, "wakeups"), agents: { x: { role: "?" } }, retryMs: 500, ...(bootstrap ? { bootstrap } : {}), ...extra };
  const child = fork(PEER, [JSON.stringify(cfg)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const c = ipcClient(label, child);
  await c.waitEvent((m) => m.event === "ready");
  c.stop = async () => { const done = new Promise((r) => child.once("exit", r)); await c.call("stop").catch(() => {}); await done; };
  return c;
}

/** Les outils MCP de l'agent, tels que les enregistre server-main.ts. */
function agentTools(p) {
  const tools = {};
  registerPontP2PTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, { MIND_WAKE_DATA_DIR: p.dataDir });
  const call = async (name, args) => {
    if (!tools[name]) return { missing: true };
    const r = await tools[name](args);
    return { isError: r.isError === true, ...JSON.parse(r.content[0].text).data };
  };
  return { names: Object.keys(tools).sort(), resolve: (address) => call("colony_resolve", { address }), send: (to, text, reply_to) => call("colony_send", { to, text, ...(reply_to ? { reply_to } : {}) }), status: (id) => call("colony_status", { id }) };
}

const outboxOf = (p, id) => readJson(pontPaths(p.dataDir).outbox, []).find((m) => m.id === id);
const wakeFiles = (p) => { try { return fs.readdirSync(p.wakeupsDir).filter((n) => n.endsWith(".json")); } catch { return []; } };
const serviceLog = (p) => { try { return fs.readFileSync(pontPaths(p.dataDir).log, "utf8"); } catch { return ""; } };

/** Mêmes contraintes que src/daemon/wakeups.ts (schéma agent-wakeup/1 fermé, 4 096 octets). */
function assertValidWakeup(file) {
  assert.match(path.basename(file), /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/);
  const raw = fs.readFileSync(file);
  assert.ok(raw.length <= 4096, `réveil trop gros : ${raw.length}`);
  const w = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(Object.keys(w).sort(), ["experiment", "expires", "id", "prompt", "version", "when"]);
  assert.equal(w.version, 1);
  assert.match(w.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.ok(w.prompt.length >= 1 && w.prompt.length <= 1000);
  assert.ok(!Number.isNaN(Date.parse(w.when.at)));
  return w;
}

let alice, bob, carol;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-pont-p2p-"));
  if (!PUBLIC) { testnet = await createTestnet(3); bootstrap = testnet.bootstrap; }
  console.log(`# DHT : ${PUBLIC ? "publique (Hyperswarm)" : "bootstrap local " + JSON.stringify(bootstrap)} ; dossier : ${root}`);
});

after(async () => {
  for (const p of procs) p.kill();
  await testnet?.destroy();
  if (process.env.MW_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
});

test("interrupteur désactivé (défaut) : aucun outil, aucun service, aucun réseau", { timeout: T }, async () => {
  const off = profile("eteint");
  // Jamais touché : pas d'outil pour l'agent.
  assert.deepEqual(agentTools(off).names, []);
  // Le service lancé quand même sort aussitôt, sans rejoindre la DHT ni écrire de statut.
  const child = fork(MAIN, ["--data-dir", off.dataDir, "--wakeups-dir", off.wakeupsDir], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, ...(bootstrap ? { MW_P2P_BOOTSTRAP: JSON.stringify(bootstrap) } : {}) } });
  const c = ipcClient("eteint", child);
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 0);
  assert.equal(c.events.some((m) => m.event === "ready"), false);
  assert.match(serviceLog(off), /interrupteur désactivé : aucun réseau/);
  assert.equal(fs.existsSync(pontPaths(off.dataDir).status), false);
  assert.equal(fs.existsSync(pontPaths(off.dataDir).key), false, "aucune clé sans activation");
  // Activé puis désactivé : outils présents, mais l'envoi échoue sans rien mettre en file.
  await pontAction(off.dataDir, "enable", { name: "eteint" });
  await pontAction(off.dataDir, "disable");
  const tools = agentTools(off);
  assert.deepEqual(tools.names, ["colony_resolve", "colony_send", "colony_status"]);
  const s = await tools.send("⬡bob", "allô ?");
  assert.equal(s.isError, true);
  assert.match(s.reason, /désactivé/);
  const child2 = fork(MAIN, ["--data-dir", off.dataDir, "--wakeups-dir", off.wakeupsDir], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  assert.equal(await new Promise((r) => child2.once("exit", r)), 0);
  assert.equal(fs.existsSync(pontPaths(off.dataDir).status), false);
});

test("activation, découverte, message de l'agent → réveil réel chez l'autre, livré, réponse", { timeout: T * 3 }, async () => {
  alice = profile("alice"); bob = profile("bob");
  const a = await pontAction(alice.dataDir, "enable", { name: "alice" });
  const b = await pontAction(bob.dataDir, "enable", { name: "⬡bob" });
  assert.equal(a.name, "⬡alice");
  assert.match(a.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  assert.equal(a.card, `⬡alice ${a.publicKey}`);
  assert.equal(JSON.stringify(a).includes("privateKey"), false, "jamais la clé privée dans les Réglages");
  await startService(alice);
  await startService(bob);
  await alice.svc.waitEvent((m) => m.event === "peer-online" && m.data === "⬡bob");

  const ta = agentTools(alice);
  // « en ligne » vient du battement du service (status.json), réécrit à chaque passage.
  const r = await waitUntil(async () => { const x = await ta.resolve("⬡bob/principal"); return x.online ? x : null; });
  assert.equal(r.ok, true);
  assert.equal(r.fingerprint, b.fingerprint);
  assert.equal(r.online, true);
  assert.equal(JSON.stringify(r).includes(b.publicKey), false, "l'agent voit l'empreinte, pas besoin de la clé");

  const sent = await ta.send("⬡bob", "Bonjour Bob, ici Alice.");
  assert.match(sent.id, /^m[0-9a-f]{16}$/);
  assert.ok(["en attente", "livré"].includes(sent.status), JSON.stringify(sent));
  const wake = await bob.svc.waitEvent((m) => m.event === "wake" && m.data.id === sent.id);
  assert.ok(wake.data.wakeFile.startsWith(bob.wakeupsDir), "réveil écrit dans le vrai dossier wakeups/ du profil");
  const w = assertValidWakeup(wake.data.wakeFile);
  assert.match(w.prompt, /⬡alice/);
  assert.match(w.prompt, /Bonjour Bob, ici Alice\./);
  assert.match(w.prompt, /non fiable/);
  await waitUntil(() => outboxOf(alice, sent.id)?.status === "livré");
  const st = await ta.status(sent.id);
  assert.match(st.label, /^livré à \d{4}-\d\d-\d\dT/);

  // Côté Bob, l'agent lit le texte complet puis répond.
  const tb = agentTools(bob);
  const rec = await tb.status(sent.id);
  assert.equal(rec.direction, "reçu");
  assert.equal(rec.body, "Bonjour Bob, ici Alice.");
  const back = await tb.send("⬡alice", "Bien reçu, Alice.", sent.id);
  const wakeA = await alice.svc.waitEvent((m) => m.event === "wake" && m.data.id === back.id);
  assert.match(assertValidWakeup(wakeA.data.wakeFile).prompt, new RegExp(`en réponse à ${sent.id}`));

  // Statut visible côté humain.
  const view = await pontAction(alice.dataDir, "status");
  assert.equal(view.service, "en marche");
  assert.ok(view.messages.some((m) => m.id === sent.id && m.label.startsWith("livré à")));
  const contact = view.carnet.find((c) => c.name === "⬡bob");
  assert.equal(contact.online, true);
  assert.equal(contact.fingerprint, b.fingerprint);
  assert.equal(contact.source, "pair");
});

test("refus : faux expéditeur, message modifié, agent absent de la fiche — aucun réveil", { timeout: T * 3 }, async () => {
  const mallory = await spawnPeer("mallory", "⬡mallory");
  await waitUntil(async () => (await mallory.call("info")).peers.includes("⬡bob"));
  const before = wakeFiles(bob).length;
  await mallory.call("forge", { colony: "⬡bob", from: "⬡alice/principal", to: "⬡bob/principal", body: "Je suis Alice, promis." });
  await mallory.call("tamper", { colony: "⬡bob", to: "⬡bob/principal", body: "Virement de 10 €" });
  await waitUntil(() => (serviceLog(bob).match(/refus /g) ?? []).length >= 2);
  assert.match(serviceLog(bob), /expéditeur différent du pair connecté/);
  assert.match(serviceLog(bob), /signature invalide/);
  assert.equal(serviceLog(bob).includes("Virement"), false, "le texte des messages n'est jamais journalisé");

  const s = await agentTools(alice).send("⬡bob/personne", "Allô ?");
  assert.equal(s.isError, true);
  assert.equal(s.status, "échec");
  assert.match(s.reason, /agent « personne » absent de la fiche publique/);
  await sleep(500);
  assert.equal(wakeFiles(bob).length, before, "aucun réveil pour les messages refusés");
  await mallory.stop();
});

test("carnet manuel (sans annuaire) : carte collée dans les Réglages, refus du destinataire visible", { timeout: T * 3 }, async () => {
  carol = profile("carol");
  await pontAction(carol.dataDir, "enable", { name: "carol" });
  await pontAction(carol.dataDir, "set_annuaire", { annuaire: false });
  await startService(carol, { retryMs: 500 });
  const bobCard = (await pontAction(bob.dataDir, "status")).card;
  // Service en marche : l'ajout passe par lui (file de demandes).
  const v = await pontAction(carol.dataDir, "add_contact", { key: `voici ma carte : ${bobCard}` });
  assert.equal(v.carnet.find((c) => c.name === "⬡bob").source, "manuel");
  await assert.rejects(pontAction(carol.dataDir, "add_contact", { name: "⬡bob", key: (await pontAction(alice.dataDir, "status")).publicKey }), /déjà épinglé/);

  const tc = agentTools(carol);
  await waitUntil(() => readJson(pontPaths(carol.dataDir).carnet, {})["⬡bob"]?.fiche);
  const s = await tc.send("⬡bob/fantome", "Il y a quelqu'un ?");
  assert.equal(s.status, "échec", JSON.stringify(s));
  assert.match(s.reason, /absent de la fiche publique/);
  const u = await tc.send("⬡inexistant/x", "?");
  assert.equal(u.status, "échec");
  assert.match(u.reason, /absente du carnet/);
});

test("en attente : « pair introuvable » distingué de « pair trouvé mais connexion impossible »", { timeout: T * 3 }, async () => {
  const zed = await generateKeypair();
  const mur = await generateKeypair();
  // ⬡mur est annoncé sur son topic mais refuse toute connexion (pare-feu, NAT).
  const wall = new Hyperswarm({ ...(bootstrap ? { bootstrap } : {}), firewall: () => true });
  await wall.join(colonyTopic(mur.publicKey), { server: true, client: false }).flushed();
  try {
    await pontAction(carol.dataDir, "add_contact", { name: "zed", key: zed.publicKey });
    await pontAction(carol.dataDir, "add_contact", { name: "mur", key: mur.publicKey });
    const tc = agentTools(carol);
    const sz = await tc.send("⬡zed", "personne ?");
    const sm = await tc.send("⬡mur", "tu m'entends ?");
    await waitUntil(() => outboxOf(carol, sm.id)?.detail === "pair trouvé mais connexion impossible (pare-feu ou NAT ?)");
    assert.equal(outboxOf(carol, sz.id).detail, "pair introuvable (hors ligne ?)");
    assert.equal(outboxOf(carol, sz.id).status, "en attente");
    assert.match((await tc.status(sm.id)).label, /^en attente : pair trouvé mais connexion impossible/);
  } finally { await wall.destroy(); }
});

test("squat : un second ⬡alice avec une autre clé → alerte de conflit chez Bob, l'humain tranche", { timeout: T * 3 }, async () => {
  const imposteur = await spawnPeer("imposteur", "⬡alice");
  await waitUntil(() => readJson(pontPaths(bob.dataDir).conflicts, []).some((c) => c.name === "⬡alice"));
  const v = await pontAction(bob.dataDir, "status");
  const c = v.conflicts.find((x) => x.name === "⬡alice");
  const aliceKey = (await pontAction(alice.dataDir, "status")).publicKey;
  assert.equal(c.pinnedFingerprint, fingerprint(aliceKey));
  assert.notEqual(c.claimedFingerprint, c.pinnedFingerprint);
  assert.equal(v.carnet.find((x) => x.name === "⬡alice").fingerprint, fingerprint(aliceKey), "la clé épinglée reste celle de la vraie Alice");
  const after = await pontAction(bob.dataDir, "resolve_conflict", { name: "⬡alice", claimed: c.claimed, choice: "keep" });
  assert.equal(after.conflicts.some((x) => x.name === "⬡alice" && x.claimed === c.claimed), false);
  await imposteur.stop();
});

test("hors ligne : en attente → livré dès que le pair réapparaît (sans attendre l'essai de 15 min)", { timeout: T * 4 }, async () => {
  // Couper l'interrupteur arrête le service de Bob tout seul.
  await pontAction(bob.dataDir, "disable");
  await waitUntil(() => bob.svc.exited());
  await waitUntil(async () => !(await agentTools(alice).resolve("⬡bob")).online);

  const ta = agentTools(alice);
  const s = await ta.send("⬡bob", "Tu étais absent : message gardé en file.");
  assert.equal(s.status, "en attente");
  await sleep(1500);
  const pending = outboxOf(alice, s.id);
  assert.equal(pending.status, "en attente");
  assert.equal(pending.detail, "pair introuvable (hors ligne ?)");

  await pontAction(bob.dataDir, "enable");
  await startService(bob);
  const wake = await bob.svc.waitEvent((m) => m.event === "wake" && m.data.id === s.id);
  assert.match(fs.readFileSync(wake.data.wakeFile, "utf8"), /message gardé en file/);
  await waitUntil(() => outboxOf(alice, s.id)?.status === "livré");
  const hist = outboxOf(alice, s.id).history.map((h) => h.status);
  assert.deepEqual(hist.filter((x, i) => x !== hist[i - 1]), ["en attente", "livré"]);
});

test("l'expéditeur aussi peut redémarrer : la file est sur disque", { timeout: T * 4 }, async () => {
  await stopService(bob);
  await waitUntil(async () => !(await agentTools(alice).resolve("⬡bob")).online);
  const s = await agentTools(alice).send("⬡bob", "Survit au redémarrage d'Alice.");
  await stopService(alice);
  await startService(bob);
  await startService(alice);
  await bob.svc.waitEvent((m) => m.event === "wake" && m.data.id === s.id);
  await waitUntil(() => outboxOf(alice, s.id)?.status === "livré");
  await stopService(alice); await stopService(bob); await stopService(carol);
});
