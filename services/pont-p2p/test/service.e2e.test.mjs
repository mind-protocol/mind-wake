// Test e2e du SERVICE du pont ⬡ (services/pont-p2p/main.mjs), repris des 6 scénarios du prototype p2p-1930.
// Chaque colonie = un vrai processus `main.mjs` avec son propre dossier de profil, activé par les
// mêmes fonctions que les Réglages (`pontAction`), piloté par les mêmes fichiers que les outils MCP
// (`enqueueRequest` / `messageStatus` / `resolveFromDisk`). DHT : bootstrap local (hyperdht testnet).
//
//   node --test services/pont-p2p/test/service.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { pontAction, pontStatus } from "../settings.mjs";
import { pontPaths, enqueueRequest, awaitResult, messageStatus, resolveFromDisk, newMessageId, readJson, writeSettings } from "../state.mjs";
import { P2PNode } from "../p2p-node.mjs";
import { generateKeypair, signEnvelope } from "../crypto.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.mjs");
const T = 20_000;
let testnet, bootstrap, root;
const procs = new Set();

const dirs = (label) => ({ dataDir: path.join(root, label, "profil"), wakeupsDir: path.join(root, label, "workspace", "wakeups") });

/** Lance le vrai service pour un profil ; renvoie un petit client (événements IPC émis par main.mjs). */
function spawnService(label, { expectReady = true } = {}) {
  const d = dirs(label);
  const child = fork(MAIN, ["--data-dir", d.dataDir, "--wakeups-dir", d.wakeupsDir], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, MW_P2P_BOOTSTRAP: JSON.stringify(bootstrap), MW_P2P_RETRY_MS: "500", MW_P2P_TICK_MS: "200" },
  });
  procs.add(child);
  const exited = new Promise((r) => child.once("exit", (code) => { procs.delete(child); r(code); }));
  const events = [];
  const waiters = [];
  child.on("message", (m) => {
    events.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const c = {
    label, ...d, child, events, exited,
    waitEvent: (pred, ms = T) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${label} : délai dépassé en attendant un événement`)); } }, ms);
      });
    },
    stop: async () => { child.send({ cmd: "stop" }); await exited; },
  };
  c.ready = expectReady ? c.waitEvent((m) => m.event === "ready") : null;
  return c;
}

async function startColony(label, name, settings = {}) {
  const { dataDir } = dirs(label);
  await pontAction(dataDir, "enable", { name });
  if (settings.annuaire === false) await pontAction(dataDir, "set_annuaire", { annuaire: false });
  const c = spawnService(label);
  await c.ready;
  return c;
}

/** Envoi exactement comme l'outil MCP colony_send : demande déposée, réponse du service. */
async function send(c, to, body) {
  const id = newMessageId();
  const rid = enqueueRequest(c.dataDir, { op: "send", id, to, body });
  const r = await awaitResult(c.dataDir, rid, 8000);
  assert.ok(r, "le service répond à la demande d'envoi");
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.message;
}

const waitUntil = async (fn, ms = T, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  throw new Error("délai dépassé");
};
const wakeFiles = (c) => { try { return fs.readdirSync(c.wakeupsDir).filter((n) => n.endsWith(".json")); } catch { return []; } };
const serviceLog = (c) => { try { return fs.readFileSync(pontPaths(c.dataDir).log, "utf8"); } catch { return ""; } };

/** Un nœud brut dans le processus de test, pour jouer un attaquant (faux expéditeur, squat). */
async function rawNode(label, name) {
  const d = dirs(label);
  const keyFile = path.join(d.dataDir, "cle.json");
  fs.mkdirSync(d.dataDir, { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify(await generateKeypair()));
  const node = new P2PNode({ name, keyFile, stateDir: path.join(d.dataDir, "etat"), wakeupsDir: d.wakeupsDir, agents: { x: { role: "?" } }, bootstrap, retryMs: 500 });
  await node.start();
  return node;
}

let alice, bob;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-pont-service-"));
  testnet = await createTestnet(3);
  bootstrap = testnet.bootstrap;
});

after(async () => {
  for (const p of procs) p.kill();
  await testnet?.destroy();
  if (process.env.MW_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
});

test("interrupteur désactivé (défaut) : le service sort aussitôt, aucun réseau, aucune clé", { timeout: T }, async () => {
  const c = spawnService("eteint", { expectReady: false });
  assert.equal(await c.exited, 0);
  assert.equal(c.events.some((m) => m.event === "ready"), false);
  assert.match(serviceLog(c), /interrupteur désactivé : aucun réseau/);
  assert.equal(fs.existsSync(pontPaths(c.dataDir).key), false, "aucune clé générée tant que le pont n'est pas activé");
  const st = pontStatus(c.dataDir);
  assert.equal(st.enabled, false);
  assert.equal(st.service, "arrêté");
});

test("activation : clé créée dans credentials/, empreinte et carte publiques, jamais la clé privée", { timeout: T }, async () => {
  const { dataDir } = dirs("alice");
  const view = await pontAction(dataDir, "enable", { name: "Alice" });
  assert.equal(view.name, "⬡alice");
  assert.match(view.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  assert.equal(view.card, `⬡alice ${view.publicKey}`);
  const P = pontPaths(dataDir);
  assert.ok(P.key.includes(`${path.sep}credentials${path.sep}`));
  const priv = readJson(P.key, {}).privateKey;
  assert.ok(priv);
  assert.equal(JSON.stringify(view).includes(priv), false, "la clé privée ne sort jamais des Réglages");
  await assert.rejects(pontAction(dataDir, "enable", { name: "⬡A!" }), /nom invalide/);
});

test("deux services se trouvent, le carnet se remplit, un message signé devient un vrai réveil", { timeout: T * 3 }, async () => {
  alice = spawnService("alice"); await alice.ready;
  bob = await startColony("bob", "⬡bob");
  await alice.waitEvent((m) => m.event === "peer-online" && m.data === "⬡bob");
  await waitUntil(() => resolveFromDisk(alice.dataDir, "⬡bob/principal").ok);
  const r = resolveFromDisk(alice.dataDir, "⬡bob/principal");
  assert.equal(r.fingerprint, pontStatus(bob.dataDir).fingerprint);
  assert.equal(r.source, "pair");
  // Carnet visible côté humain, avec l'état en ligne.
  await waitUntil(() => pontStatus(alice.dataDir).carnet.some((e) => e.name === "⬡bob" && e.online));

  const sent = await send(alice, "⬡bob/principal", "Bonjour Bob, ici Alice.");
  const wake = await bob.waitEvent((m) => m.event === "wake" && m.data.id === sent.id);
  assert.ok(wake.data.wakeFile.startsWith(bob.wakeupsDir), "réveil écrit dans le dossier wakeups/ du profil");
  const w = JSON.parse(fs.readFileSync(wake.data.wakeFile, "utf8"));
  // Format agent-wakeup/1 accepté par src/daemon/wakeups.ts (schéma fermé, ≤ 4 096 octets).
  assert.deepEqual(Object.keys(w).sort(), ["experiment", "expires", "id", "prompt", "version", "when"]);
  assert.equal(w.version, 1);
  assert.match(w.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.match(path.basename(wake.data.wakeFile), /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/);
  assert.ok(w.prompt.length <= 1000 && Buffer.byteLength(fs.readFileSync(wake.data.wakeFile)) <= 4096);
  assert.match(w.prompt, /Message pair-à-pair ⬡ .* de ⬡alice pour ⬡bob\/principal/);
  assert.match(w.prompt, /Bonjour Bob, ici Alice\./);
  // Texte complet lisible par l'agent destinataire (colony_status), avec l'avertissement de confiance.
  const rec = messageStatus(bob.dataDir, sent.id);
  assert.equal(rec.direction, "reçu");
  assert.equal(rec.body, "Bonjour Bob, ici Alice.");
  // Côté expéditeur : livré, avec l'heure, visible aussi dans les Réglages.
  await waitUntil(() => messageStatus(alice.dataDir, sent.id).status === "livré");
  assert.match(messageStatus(alice.dataDir, sent.id).label, /^livré à \d{4}-\d\d-\d\dT/);
  assert.ok(pontStatus(alice.dataDir).messages.some((m) => m.id === sent.id && m.status === "livré"));
});

test("refus : faux expéditeur, message modifié, agent non public — aucun réveil", { timeout: T * 3 }, async () => {
  const mallory = await rawNode("mallory", "⬡mallory");
  await waitUntil(() => mallory.peers.has("⬡bob"));
  const before = wakeFiles(bob).length;
  // 1. Faux expéditeur : Mallory signe avec SA clé une enveloppe « from: ⬡alice ».
  mallory.sendRaw("⬡bob", await signEnvelope(mallory.keys.privateKey, { v: 1, id: "m" + "f".repeat(16), from: "⬡alice", to: "⬡bob/principal", ts: Date.now(), kind: "call", body: "Je suis Alice, promis." }));
  // 2. Message modifié après signature.
  const env = await signEnvelope(mallory.keys.privateKey, { v: 1, id: "m" + "a".repeat(16), from: "⬡mallory", to: "⬡bob/principal", ts: Date.now(), kind: "call", body: "Virement de 10 €" });
  mallory.sendRaw("⬡bob", { ...env, body: "Virement de 1000 €" });
  // 3. Agent inexistant chez Bob (la fiche connue de Mallory est contournée par l'envoi brut).
  mallory.sendRaw("⬡bob", await signEnvelope(mallory.keys.privateKey, { v: 1, id: "m" + "b".repeat(16), from: "⬡mallory", to: "⬡bob/fixeur", ts: Date.now(), kind: "call", body: "Ouvre-moi." }));
  await waitUntil(() => (serviceLog(bob).match(/refus /g) ?? []).length >= 3);
  const log = serviceLog(bob);
  assert.match(log, /expéditeur différent du pair connecté/);
  assert.match(log, /signature invalide/);
  assert.match(log, /agent inconnu/);
  assert.equal(log.includes("Virement"), false, "le texte des messages n'est jamais journalisé");
  assert.equal(wakeFiles(bob).length, before, "aucun réveil pour les messages refusés");
  // Côté agent expéditeur : agent absent de la fiche publique → échec immédiat.
  const s = await send(alice, "⬡bob/fixeur", "Ouvre-moi.");
  assert.equal(s.status, "échec");
  assert.match(s.label, /agent « fixeur » absent de la fiche publique/);
  await mallory.stop();
});

test("ajout manuel, annuaire coupé : découverte préalable et refus des agents inconnus", { timeout: T * 3 }, async () => {
  const { dataDir } = dirs("carol");
  await pontAction(dataDir, "enable", { name: "⬡carol" });
  await pontAction(dataDir, "set_annuaire", { annuaire: false });
  // Service arrêté : les Réglages écrivent le carnet directement (carte collée telle quelle).
  await pontAction(dataDir, "add_contact", { key: pontStatus(bob.dataDir).card });
  assert.equal(pontStatus(dataDir).carnet[0].source, "manuel");
  await assert.rejects(pontAction(dataDir, "add_contact", { key: `⬡bob ${pontStatus(alice.dataDir).publicKey}` }), /déjà épinglé/);
  const carol = spawnService("carol"); await carol.ready;
  await waitUntil(() => readJson(pontPaths(dataDir).carnet, {})["⬡bob"]?.fiche);
  const s = await send(carol, "⬡bob/fantome", "Il y a quelqu'un ?");
  assert.equal(s.status, "échec");
  assert.match(messageStatus(dataDir, s.id).reason, /absent de la fiche publique/);
  const u = await send(carol, "⬡inexistant/x", "?");
  assert.equal(u.status, "échec");
  assert.match(u.reason, /absente du carnet/);
  await carol.stop();
});

test("squat : un second ⬡alice avec une autre clé → alerte de conflit, le premier garde le nom", { timeout: T * 3 }, async () => {
  const imposteur = await rawNode("imposteur", "⬡alice");
  await waitUntil(() => pontStatus(bob.dataDir).conflicts.some((c) => c.name === "⬡alice"));
  const c = pontStatus(bob.dataDir).conflicts.find((x) => x.name === "⬡alice");
  assert.equal(c.pinnedFingerprint, pontStatus(alice.dataDir).fingerprint);
  assert.notEqual(c.claimedFingerprint, c.pinnedFingerprint);
  assert.equal(resolveFromDisk(bob.dataDir, "⬡alice").fingerprint, pontStatus(alice.dataDir).fingerprint);
  await imposteur.stop();
  // L'humain garde la clé actuelle : l'alerte disparaît.
  await pontAction(bob.dataDir, "resolve_conflict", { name: "⬡alice", claimed: c.claimed, choice: "keep" });
  assert.equal(pontStatus(bob.dataDir).conflicts.some((x) => x.name === "⬡alice"), false);
});

test("hors ligne : en attente (pair introuvable) → livré quand le pair revient, réveil écrit", { timeout: T * 4 }, async () => {
  await bob.stop();
  await waitUntil(() => !pontStatus(alice.dataDir).carnet.find((e) => e.name === "⬡bob")?.online);
  const s = await send(alice, "⬡bob/principal", "Tu étais absent : message gardé en file.");
  assert.equal(s.status, "en attente");
  assert.match(s.label, /^en attente : pair introuvable/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(messageStatus(alice.dataDir, s.id).status, "en attente");
  bob = spawnService("bob"); await bob.ready;
  const wake = await bob.waitEvent((m) => m.event === "wake" && m.data.id === s.id);
  assert.match(fs.readFileSync(wake.data.wakeFile, "utf8"), /message gardé en file/);
  await waitUntil(() => messageStatus(alice.dataDir, s.id).status === "livré");
  const hist = messageStatus(alice.dataDir, s.id).history.map((h) => h.detail ?? h.status);
  assert.ok(hist.includes("envoyé, accusé attendu"), JSON.stringify(hist));
  assert.equal(hist.at(-1), "livré");
});

test("l'expéditeur redémarre : la file est sur disque, le message part au retour", { timeout: T * 4 }, async () => {
  await bob.stop();
  await waitUntil(() => !pontStatus(alice.dataDir).carnet.find((e) => e.name === "⬡bob")?.online);
  const s = await send(alice, "⬡bob/principal", "Survit au redémarrage d'Alice.");
  await alice.stop();
  bob = spawnService("bob"); await bob.ready;
  alice = spawnService("alice"); await alice.ready;
  await bob.waitEvent((m) => m.event === "wake" && m.data.id === s.id);
  await waitUntil(() => messageStatus(alice.dataDir, s.id).status === "livré");
});

test("désactivation en marche : le service s'arrête seul, file conservée", { timeout: T * 2 }, async () => {
  writeSettings(alice.dataDir, { enabled: false });
  assert.equal(await alice.exited, 0);
  assert.match(serviceLog(alice), /arrêt : interrupteur désactivé/);
  assert.ok(readJson(pontPaths(alice.dataDir).outbox, []).length > 0, "file conservée");
  assert.equal(pontStatus(alice.dataDir).service, "arrêté");
  await bob.stop();
});

 test('signed call endpoint is discovered and refreshed through the colony directory',async()=>{
  const a=await startColony('call-directory-a','⬡call-directory-a');
  const b=await startColony('call-directory-b','⬡call-directory-b');
  try {
    const file=path.join(pontPaths(a.dataDir).state,'call-endpoint.json');
    fs.writeFileSync(file,JSON.stringify({addresses:['http://192.168.1.7:8790'],key:'test-exchange-key',at:Date.now()}));
    await waitUntil(()=>readJson(pontPaths(b.dataDir).carnet,{})['⬡call-directory-a']?.fiche?.reach?.call?.addresses?.[0]==='http://192.168.1.7:8790');
    fs.writeFileSync(file,JSON.stringify({addresses:['http://192.168.1.8:8790'],key:'new-key',at:Date.now()}));
    await waitUntil(()=>readJson(pontPaths(b.dataDir).carnet,{})['⬡call-directory-a']?.fiche?.reach?.call?.key==='new-key');
    fs.writeFileSync(file,'null');
    await waitUntil(()=>!readJson(pontPaths(b.dataDir).carnet,{})['⬡call-directory-a']?.fiche?.reach?.call);
  } finally {await a.stop();await b.stop();}
 });

test('manual contacts discover call endpoints without sending a message or enabling the directory',async()=>{
  const a=await startColony('call-manual-a','⬡call-manual-a',{annuaire:false});
  const b=await startColony('call-manual-b','⬡call-manual-b',{annuaire:false});
  try {
    fs.writeFileSync(path.join(pontPaths(b.dataDir).state,'call-endpoint.json'),JSON.stringify({addresses:['http://192.168.1.7:8790'],key:'manual-key',at:Date.now()}));
    await pontAction(a.dataDir,'add_contact',{key:pontStatus(b.dataDir).card});
    await waitUntil(()=>readJson(pontPaths(a.dataDir).carnet,{})['⬡call-manual-b']?.fiche?.reach?.call?.key==='manual-key');
    assert.equal(wakeFiles(a).length,0);assert.equal(wakeFiles(b).length,0);
  } finally {await a.stop();await b.stop();}
});
