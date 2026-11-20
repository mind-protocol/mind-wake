// Appel MIND porté par le pont ⬡ : deux vrais services `main.mjs` (DHT locale de test) et deux vrais
// serveurs d'appels (call-peers). Le HTTP direct de l'appelant est coupé : chaque requête d'appel
// (directory, sync, deliver, read, end) doit passer par le flux Hyperswarm authentifié du pont, puis
// par le même gestionnaire /mind-call/v2 que le LAN chez le destinataire.
//
//   node --test services/pont-p2p/test/call-relay.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { pontAction } from "../settings.mjs";
import { pontPaths, readJson } from "../state.mjs";
import { P2PNode } from "../p2p-node.mjs";
import { generateKeypair } from "../crypto.mjs";
import { createCallService } from "../../../lumina-prime/app/server/chat-call.mjs";
import { createCallPeers } from "../../../lumina-prime/app/server/call-peers.mjs";
import { createCallColonies } from "../../../lumina-prime/app/server/call-colonies.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.mjs");
const T = 30_000;
let testnet, bootstrap, root;
const procs = new Set();
const cleanups = [];

const waitUntil = async (fn, ms = T, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  throw new Error("délai dépassé");
};

function spawnService(dataDir) {
  const child = fork(MAIN, ["--data-dir", dataDir, "--wakeups-dir", path.join(dataDir, "wakeups")], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, MW_P2P_BOOTSTRAP: JSON.stringify(bootstrap), MW_P2P_RETRY_MS: "500", MW_P2P_TICK_MS: "200" },
  });
  procs.add(child);
  const exited = new Promise((r) => child.once("exit", () => { procs.delete(child); r(); }));
  const ready = new Promise((res) => child.on("message", (m) => { if (m.event === "ready") res(); }));
  return { child, ready, stop: async () => { child.send({ cmd: "stop" }); await exited; } };
}

/** Une installation : profil, pont activé, service lancé, serveur d'appels sur 127.0.0.1. */
async function install(label, { fetchImpl } = {}) {
  const dataDir = path.join(root, label);
  const name = "⬡" + label.toLowerCase();
  await pontAction(dataDir, "enable", { name });
  const service = spawnService(dataDir);
  await service.ready;
  const main = [], sent = [], notices = [];
  const call = createCallService({
    mainLabel: label, mainAgentId: "marco", mirrorIntervalMs: 0, mirrorQuietMs: 0,
    handleTable: () => new Map([["room3", { room: 3, agent: null, label: "Room 3" }]]),
    mainReplies: () => main, roomEntries: () => [], sendMain: async (id, text) => { sent.push({ id, text }); return {}; },
    routeHandle: async (handle, text, id) => { sent.push({ id, text, handle }); return { status: "routed" }; },
    noticeMain: async (key, text) => { notices.push({ key, text }); }, noticeRoom: async () => {},
    speak: async (text) => ({ bytes: Buffer.from(`RIFF${text}`), mime: "audio/wav", provider: "test" }),
  });
  const colonies = createCallColonies(dataDir);
  const peers = createCallPeers({ call, dataDir, file: path.join(dataDir, "app", "call-peers.json"), colonies, port: 0, host: "127.0.0.1", ...(fetchImpl ? { fetchImpl } : {}) });
  cleanups.push(async () => { await peers.close(); call.stop(); await service.stop(); });
  return { label, name, dataDir, service, call, peers, colonies, main, sent, notices };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-pont-call-"));
  testnet = await createTestnet(3);
  bootstrap = testnet.bootstrap;
});

after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
  for (const p of procs) p.kill();
  await testnet?.destroy();
  if (process.env.MW_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
});

test("un appel entre deux colonies passe par le pont ⬡ quand le HTTP direct est injoignable", { timeout: T * 3 }, async () => {
  let httpAttempts = 0;
  const a = await install("Alpha", { fetchImpl: async () => { httpAttempts++; throw new TypeError("fetch failed (LAN injoignable)"); } });
  const b = await install("Beta");
  // Chaque serveur publie sa clé d'échange ; le service la met dans sa fiche signée, que le pair apprend.
  await a.peers.ready(); await b.peers.ready();
  await waitUntil(async () => (await a.colonies.contacts()).some((c) => c.colony === b.name && c.p2p));

  const target = await waitUntil(async () => { try { return await a.peers.resolveAddress(b.name); } catch { await a.peers.refresh(); return null; } });
  assert.equal(target.remoteHandle, "mind");
  assert.ok(httpAttempts > 0, "le HTTP direct a bien été tenté puis abandonné");

  const scope = { owner: "desktop-owner", id: randomUUID(), epoch: 1 };
  a.call.openSession(scope.owner, scope.id, 1, [target.handle]);
  await a.call.syncRemote(scope);
  assert.equal(b.call.active().length, 1, "l'appel existe chez le destinataire");

  const before = httpAttempts;
  const t0 = Date.now();
  await a.call.deliver([target.handle], "chat-p2p", "Bonjour par le pont", scope);
  const ms = Date.now() - t0;
  assert.ok(b.sent.some((m) => m.text.includes("Bonjour par le pont")), "message livré chez Beta");
  assert.equal(httpAttempts, before, "une fois le pont établi, le HTTP mort n'est plus essayé en premier");
  assert.ok(ms < 5000, `latence acceptable (${ms} ms)`);

  b.main.push({ id: "r1", role: "agent", at: new Date(Date.now() + 5).toISOString(), text: "Beta répond par le pont." });
  const replies = await a.call.replies(target.handle, "2020-01-01T00:00:00Z", scope);
  assert.equal(replies.length, 1);
  const audio = await a.call.speech(target.handle, replies[0].id, false, scope);
  assert.match(audio.bytes.toString(), /Beta répond par le pont/);

  a.call.endSession(scope.owner, scope.id, 1);
  await waitUntil(() => b.call.active().length === 0, 10_000);
  assert.match(fs.readFileSync(pontPaths(a.dataDir).log, "utf8"), /appel relayé → ⬡beta : ok/);
  // Aucune demande ni réponse orpheline.
  assert.deepEqual(fs.readdirSync(pontPaths(a.dataDir).requests).filter((n) => n.endsWith(".json")), []);
});

test("le pont refuse un paquet d'appel dont l'expéditeur n'est pas la colonie authentifiée", { timeout: T * 2 }, async () => {
  const b = await install("Gamma");
  const dir = path.join(root, "intrus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cle.json"), JSON.stringify(await generateKeypair()));
  const node = new P2PNode({ name: "⬡intrus", keyFile: path.join(dir, "cle.json"), stateDir: path.join(dir, "etat"), wakeupsDir: path.join(dir, "wakeups"), agents: {}, bootstrap, retryMs: 500 });
  await node.start();
  cleanups.push(() => node.stop());
  await waitUntil(() => node.peers.has(b.name));
  const forged = await node.callRpc(b.name, { from: "⬡alpha", to: b.name, id: "x", data: "x" }, { timeoutMs: 5000 });
  assert.deepEqual(forged, { status: 401, body: { error: "peer_unauthorized" } });
  // Expéditeur correct mais signature absente : le serveur d'appels de Gamma refuse lui-même.
  await b.peers.ready();
  await waitUntil(() => readJson(path.join(pontPaths(b.dataDir).state, "call-endpoint.json"), null));
  const unsigned = await node.callRpc(b.name, { from: "⬡intrus", to: b.name, id: "x", data: "x" }, { timeoutMs: 5000 });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.error, "peer_unauthorized");
});
