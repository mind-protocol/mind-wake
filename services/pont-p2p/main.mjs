#!/usr/bin/env node
// Service du pont pair-à-pair ⬡, lancé par le daemon (src/daemon/pont-p2p-supervisor.ts) seulement
// si l'interrupteur des Réglages est activé.
//
//   node services/pont-p2p/main.mjs --data-dir <profil> --wakeups-dir <espace>/wakeups [--parent <pid>]
//
// - sort tout seul si l'interrupteur est désactivé, si le nom change ou si le daemon parent disparaît ;
// - une seule instance par profil (battement `status.json` + pid) ;
// - traite les demandes déposées dans `requests/` (envoi par l'agent, ajout manuel au carnet) ;
// - n'écrit jamais la clé privée ni le texte des messages dans le journal.
// Variables de test uniquement : MW_P2P_BOOTSTRAP (JSON), MW_P2P_RETRY_MS, MW_P2P_TICK_MS.
import fs from "node:fs";
import path from "node:path";
import { P2PNode } from "./p2p-node.mjs";
import {
  pontPaths, readSettings, readJson, writeJson, pidAlive, serviceAlive, fingerprint,
  DEFAULT_AGENTS, DEFAULT_AGENT,
} from "./state.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dataDir = arg("data-dir") ?? process.env.MIND_WAKE_DATA_DIR;
const wakeupsDir = arg("wakeups-dir");
const parentPid = Number(arg("parent") ?? 0);
if (!dataDir || !wakeupsDir) { console.error("usage : main.mjs --data-dir <dir> --wakeups-dir <dir> [--parent <pid>]"); process.exit(2); }

const P = pontPaths(dataDir);
fs.mkdirSync(P.state, { recursive: true });
const log = (line) => { try { fs.appendFileSync(P.log, `${new Date().toISOString()} [${process.pid}] ${line}\n`); } catch {} };

const settings = readSettings(dataDir);
if (!settings.enabled || !settings.name) { log("interrupteur désactivé : aucun réseau, sortie"); process.exit(0); }
if (serviceAlive(dataDir) && readJson(P.status, {}).pid !== process.pid) { log("une autre instance tourne déjà : sortie"); process.exit(0); }

const bootstrap = process.env.MW_P2P_BOOTSTRAP ? JSON.parse(process.env.MW_P2P_BOOTSTRAP) : undefined;
const retryMs = Number(process.env.MW_P2P_RETRY_MS) || undefined;
const tickMs = Number(process.env.MW_P2P_TICK_MS) || 1000;

const {localMessageTargets,deliverLocalMessage}=await import('../../dist/communication/local-message.js');
const CALL_RPC_MAX_MS = 150_000;
const callEndpointFile = () => readJson(path.join(P.state,'call-endpoint.json'),null);
/**
 * Appel reçu d'un pair par le pont : remis tel quel au serveur d'appels local (même route que le LAN,
 * /mind-call/v2), qui vérifie signature, scellement et rejeu. Le pont ne voit que l'enveloppe chiffrée.
 */
async function forwardCall(packet) {
  const e = callEndpointFile();
  const port = Number(e?.port ?? (()=>{ try { return new URL(e?.addresses?.[0]).port; } catch { return 0; } })());
  if (!e || Date.now()-e.at>30_000 || !Number.isInteger(port) || port<=0 || port>65535) return { status:503, body:{ error:'peer_unavailable' } };
  const res = await fetch(`http://127.0.0.1:${port}/mind-call/v2`, { method:'POST', redirect:'error', headers:{'Content-Type':'application/json'}, body:JSON.stringify(packet), signal:AbortSignal.timeout(CALL_RPC_MAX_MS) });
  let body = null; try { body = await res.json(); } catch {}
  return { status:res.status, body };
}
const node = new P2PNode({
  name: settings.name, keyFile: P.key, stateDir: P.state, wakeupsDir,
  callEndpoint: () => { const e=callEndpointFile(); return e && Date.now()-e.at<30_000 ? {addresses:e.addresses,key:e.key} : null; },
  callRpc: forwardCall,
  agents: {...DEFAULT_AGENTS,...localMessageTargets(dataDir)}, receiveMessage: (env,agent) => env.kind==="message" ? deliverLocalMessage(dataDir,{to:agent??DEFAULT_AGENT,text:env.body,author:env.from,key:env.id}) : node.writeWakeup(env,agent), defaultAgent: DEFAULT_AGENT, annuaire: settings.annuaire,
  ...(bootstrap ? { bootstrap } : {}), ...(retryMs ? { retryMs, detailMs: Math.min(3000, retryMs) } : {}),
});

let stopping = false;
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`arrêt : ${reason}`);
  try { writeStatus(true); } catch {}
  const t = setTimeout(() => process.exit(code), 5000); t.unref?.();
  try { await node.stop(); } catch {}
  process.exit(code);
}

function writeStatus(stopped = false) {
  const seeking = {};
  for (const colony of node.pendingColonies?.() ?? []) seeking[colony] = node.reachability(colony) ?? "connecté";
  writeJson(P.status, {
    pid: process.pid, at: new Date().toISOString(), stopped, name: node.name,
    publicKey: node.keys?.publicKey ?? null, fingerprint: fingerprint(node.keys?.publicKey),
    peers: [...node.peers.keys()], seeking, annuaire: settings.annuaire,
    dht: bootstrap ? "bootstrap de test" : "publique (Hyperswarm)",
  });
}

// Appels sortants relayés : un seul état par colonie dans le journal (pas une ligne par requête).
const relayState = new Map();
async function relayCall(req) {
  let result;
  try {
    const timeoutMs = Math.min(CALL_RPC_MAX_MS, Math.max(500, Number(req.timeoutMs) || 10_000));
    if (!req.packet || typeof req.packet !== "object") throw new Error("invalid_request");
    result = { ok: true, ...(await node.callRpc(String(req.to ?? ""), req.packet, { timeoutMs })) };
  } catch (e) { result = { ok: false, reason: String(e?.message ?? e).slice(0, 120) }; }
  const state = result.ok ? "ok" : result.reason;
  if (relayState.get(req.to) !== state) { relayState.set(req.to, state); log(`appel relayé → ${String(req.to).slice(0, 40)} : ${state}`); }
  writeJson(path.join(P.results, `${req.rid}.json`), result);
}

async function handleRequest(file) {
  const req = readJson(file, null);
  try { fs.rmSync(file, { force: true }); } catch {}
  if (!req?.rid || !/^r[0-9a-f]{16}$/.test(req.rid)) return;
  // Un appel attend la réponse du pair : jamais dans la boucle, qui doit rester disponible.
  if (req.op === "callRpc") return void relayCall(req);
  let result;
  try {
    if (req.op === "send") {
      result = { ok: true, message: await node.send(String(req.to ?? ""), req.body, { id: req.id, replyTo: req.replyTo, kind: req.kind??"call" }) };
      log(`envoi ${result.message.id} → ${result.message.to} : ${result.message.label}`);
    } else if (req.op === "addContact") {
      result = node.addContact(String(req.name ?? ""), String(req.publicKey ?? ""), { force: req.force === true });
      log(`carnet : ${req.name} ajouté à la main${req.force ? " (remplacement confirmé)" : ""}`);
    } else if (req.op === "forget") {
      if (node.carnet[req.name]) { delete node.carnet[req.name]; node.saveCarnet(); }
      node.conflicts = node.conflicts.filter((c) => c.name !== req.name);
      writeJson(path.join(P.state, "conflits.json"), node.conflicts);
      result = { ok: true };
    } else if (req.op === "dismissConflict") {
      node.conflicts = node.conflicts.filter((c) => !(c.name === req.name && c.claimed === req.claimed));
      writeJson(path.join(P.state, "conflits.json"), node.conflicts);
      result = { ok: true };
    } else result = { ok: false, reason: "demande inconnue" };
  } catch (e) {
    result = { ok: false, reason: String(e?.message ?? e).slice(0, 300) };
  }
  writeJson(path.join(P.results, `${req.rid}.json`), result);
}

let busy = false, again = false;
async function tick() {
  if (stopping) return;
  if (busy) { again = true; return; }
  busy = true; again = false;
  try {
    const s = readSettings(dataDir);
    if (!s.enabled) return void shutdown("interrupteur désactivé");
    if (s.name !== settings.name || s.annuaire !== settings.annuaire) return void shutdown("réglages modifiés, relance par le daemon", 0);
    if (parentPid && !pidAlive(parentPid)) return void shutdown("daemon parent disparu");
    let names = [];
    try { names = fs.readdirSync(P.requests).filter((n) => /^r[0-9a-f]{16}\.json$/.test(n)).sort(); } catch {}
    for (const n of names.slice(0, 50)) await handleRequest(path.join(P.requests, n));
    // Résultats non lus au-delà de 10 min : supprimés.
    try { for (const n of fs.readdirSync(P.results)) { const f = path.join(P.results, n); if (Date.now() - fs.statSync(f).mtimeMs > 600_000) fs.rmSync(f, { force: true }); } } catch {}
    const agents={...DEFAULT_AGENTS,...localMessageTargets(dataDir)};
    const agentsChanged=JSON.stringify(agents)!==JSON.stringify(node.cfg.agents);
    node.cfg.agents=agents;
    const endpoint=node.cfg.callEndpoint();
    if(agentsChanged||JSON.stringify(endpoint)!==JSON.stringify(node.fiche.reach.call ?? null)) {
      node.fiche=await node.buildFiche();
      for(const peer of node.peers.values())peer.send({t:'hello',fiche:node.fiche});
    }
    writeStatus();
  } catch (e) {
    log(`erreur de tick : ${String(e?.message ?? e).slice(0, 300)}`);
  } finally { busy = false; if (again) setImmediate(() => void tick()); }
}

node.on("status", (v) => process.send?.({ event: "status", data: v }));
node.on("wake", ({ env, wakeFile }) => { log(`réveil ${env.id} de ${env.from} pour ${env.to}`); process.send?.({ event: "wake", data: { id: env.id, from: env.from, to: env.to, wakeFile } }); });
node.on("peer-online", (c) => { log(`en ligne : ${c}`); process.send?.({ event: "peer-online", data: c }); });
node.on("peer-offline", (c) => { log(`hors ligne : ${c}`); process.send?.({ event: "peer-offline", data: c }); });
node.on("conflit", (c) => { log(`conflit de nom : ${c.name} (épinglé ${fingerprint(c.pinned)}, réclamé ${fingerprint(c.claimed)}, ${c.source})`); process.send?.({ event: "conflit", data: c }); });
node.on("refus", (r) => log(`refus ${typeof r.id === "string" ? r.id.slice(0, 40) : "?"} de ${r.peer ?? "?"} : ${r.reason}`));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (e) => { log(`exception : ${String(e?.message ?? e).slice(0, 300)}`); void shutdown("exception", 1); });
// Commande d'arrêt des tests (IPC).
process.on("message", (m) => { if (m?.cmd === "stop") void shutdown("demande IPC"); });

try {
  await node.start();
} catch (e) {
  log(`démarrage impossible : ${String(e?.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
log(`démarré : ${node.name} (empreinte ${fingerprint(node.keys.publicKey)}), annuaire ${settings.annuaire ? "oui" : "non"}, DHT ${bootstrap ? "bootstrap de test" : "publique"}`);
writeStatus();
process.send?.({ event: "ready", data: { name: node.name, publicKey: node.keys.publicKey } });
setInterval(() => void tick(), tickMs);
// Une demande déposée est prise tout de suite (les appels sont quasi temps réel) ; le tick reste le filet.
try { fs.mkdirSync(P.requests, { recursive: true }); fs.watch(P.requests, () => void tick()).on("error", () => {}); } catch {}
