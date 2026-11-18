// Pont pair-à-pair ⬡ : état sur disque partagé entre le service (main.mjs), les Réglages
// (desktop-main.mjs), les outils MCP de l'agent et le superviseur du daemon.
//
// Emplacements (dossier de données du profil, MIND_WAKE_DATA_DIR) :
//   pont-p2p.json                         réglages : interrupteur, nom ⬡, annuaire (écrits par l'humain)
//   credentials/pont-p2p-colonie.json     clé de la colonie (jamais affichée, loggée ni renvoyée)
//   pont-p2p/                             état : carnet, file sortante, vus, reçus, statut, demandes
//
// Seul le service écrit carnet.json, outbox.json, seen.json, conflits.json et status.json
// pendant qu'il tourne. Les autres déposent une demande dans requests/ et lisent la réponse
// dans results/. Quand le service est arrêté, les Réglages écrivent le carnet directement.
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { generateKeypair, parseAddress, NAME_RE } from "./crypto.mjs";

export const GLYPH = "⬡";
export const SETTINGS_FILE = "pont-p2p.json";
export const KEY_FILE = path.join("credentials", "pont-p2p-colonie.json");
export const STATE_DIR = "pont-p2p";
/** Statut du service considéré vivant si son battement a moins de cet âge. */
export const HEARTBEAT_FRESH_MS = 20_000;
export const BODY_MAX = 8000;
export const DEFAULT_AGENT = "principal";
export const DEFAULT_AGENTS = { [DEFAULT_AGENT]: { role: "Agent principal de la colonie" } };

export const STATUS = { PENDING: "en attente", DELIVERED: "livré", FAILED: "échec" };

export function pontPaths(dataDir) {
  const state = path.join(dataDir, STATE_DIR);
  return {
    dataDir,
    settings: path.join(dataDir, SETTINGS_FILE),
    key: path.join(dataDir, KEY_FILE),
    state,
    carnet: path.join(state, "carnet.json"),
    outbox: path.join(state, "outbox.json"),
    seen: path.join(state, "seen.json"),
    conflicts: path.join(state, "conflits.json"),
    status: path.join(state, "status.json"),
    pid: path.join(state, "service.pid"),
    log: path.join(state, "service.log"),
    requests: path.join(state, "requests"),
    results: path.join(state, "results"),
    received: path.join(state, "recus"),
    tmp: path.join(state, "tmp"),
  };
}

export const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
export function writeJson(f, v, mode) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${nodeCrypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, f);
}

// ------------------------------------------------------------------ réglages
/** Réglages normalisés. Désactivé par défaut : sans fichier, aucun réseau. */
export function readSettings(dataDir) {
  const s = readJson(pontPaths(dataDir).settings, {});
  return {
    enabled: s?.enabled === true,
    name: typeof s?.name === "string" && NAME_RE.test(s.name) ? s.name : null,
    annuaire: s?.annuaire !== false,
    updatedAt: typeof s?.updatedAt === "string" ? s.updatedAt : null,
  };
}

export function writeSettings(dataDir, patch) {
  const next = { ...readSettings(dataDir), ...patch, updatedAt: new Date().toISOString() };
  writeJson(pontPaths(dataDir).settings, next);
  return next;
}

/** `nlr`, `⬡nlr` ou ` ⬡NLR ` → `⬡nlr` ; null si invalide. */
export function normalizeName(input) {
  if (typeof input !== "string") return null;
  let n = input.normalize("NFC").trim().toLowerCase();
  if (!n.startsWith(GLYPH)) n = GLYPH + n;
  return NAME_RE.test(n) ? n : null;
}

// ------------------------------------------------------------------ clé de la colonie
/** Crée la clé une seule fois. Ne renvoie que la partie publique. */
export async function ensureColonyKey(dataDir) {
  const file = pontPaths(dataDir).key;
  const existing = readJson(file, null);
  if (existing?.publicKey && existing?.privateKey) return { publicKey: existing.publicKey, created: false };
  const keys = await generateKeypair();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // wx : jamais d'écrasement d'une clé existante, même en cas de course.
  try { fs.writeFileSync(file, JSON.stringify({ format: "mind-wake/pont-p2p-key/1", ...keys, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e?.code !== "EEXIST") throw e; return { publicKey: readJson(file, {}).publicKey ?? null, created: false }; }
  return { publicKey: keys.publicKey, created: true };
}

/** Clé publique seule (la privée n'est lue que par le service). */
export function colonyPublicKey(dataDir) {
  const k = readJson(pontPaths(dataDir).key, null);
  return typeof k?.publicKey === "string" ? k.publicKey : null;
}

/** Empreinte lisible à voix haute : 5 groupes de 4 caractères hexadécimaux (80 bits). */
export function fingerprint(publicKey) {
  if (typeof publicKey !== "string") return null;
  const h = nodeCrypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 20);
  return h.match(/.{4}/g).join("-");
}

export const KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/;

/** Carte à communiquer : `⬡nom ed25519:…`. Les deux champs sont publics. */
export const contactCard = (name, publicKey) => `${name} ${publicKey}`;

/** Lit une carte collée (`⬡nom ed25519:…`) ou une clé seule. */
export function parseCard(text) {
  if (typeof text !== "string") return null;
  const key = text.match(/ed25519:[A-Za-z0-9_-]{43}/)?.[0] ?? null;
  const name = text.match(/⬡[a-z0-9][a-z0-9-]{1,30}/)?.[0] ?? null;
  return key ? { publicKey: key, name } : null;
}

// ------------------------------------------------------------------ service
export function serviceAlive(dataDir, now = Date.now()) {
  const p = pontPaths(dataDir);
  const st = readJson(p.status, null);
  if (!st?.at || now - Date.parse(st.at) > HEARTBEAT_FRESH_MS || st.stopped) return false;
  return pidAlive(st.pid);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

export const newMessageId = () => "m" + nodeCrypto.randomBytes(8).toString("hex");
const REQUEST_ID = /^r[0-9a-f]{16}$/;

/** Dépose une demande pour le service. */
export function enqueueRequest(dataDir, op) {
  const p = pontPaths(dataDir);
  const rid = "r" + nodeCrypto.randomBytes(8).toString("hex");
  writeJson(path.join(p.requests, `${rid}.json`), { rid, at: new Date().toISOString(), ...op });
  return rid;
}

/** Attend la réponse du service à une demande (null au-delà du délai). */
export async function awaitResult(dataDir, rid, ms = 6000) {
  if (!REQUEST_ID.test(rid)) return null;
  const file = path.join(pontPaths(dataDir).results, `${rid}.json`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = readJson(file, null);
    if (r) { try { fs.rmSync(file, { force: true }); } catch {} return r; }
    await new Promise((res) => setTimeout(res, 150));
  }
  return null;
}

/** Demandes d'envoi encore dans la file d'attente du service (service pas encore démarré). */
export function queuedSends(dataDir) {
  const dir = pontPaths(dataDir).requests;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^r[0-9a-f]{16}\.json$/.test(n)); } catch { return []; }
  return names.map((n) => readJson(path.join(dir, n), null)).filter((r) => r?.op === "send");
}

// ------------------------------------------------------------------ vues (Réglages, MCP)
/** Libellé humain d'un message sortant. */
export function messageLabel(m) {
  if (m.status === STATUS.DELIVERED) return `livré à ${m.deliveredAt ?? "?"}`;
  if (m.status === STATUS.FAILED) return `échec : ${m.reason ?? "raison inconnue"}`;
  return m.detail ? `en attente : ${m.detail}` : "en attente";
}

export function messageView(m) {
  return {
    id: m.id, to: m.to, status: m.status, detail: m.detail ?? null, label: messageLabel(m),
    createdAt: m.createdAt ?? null, deliveredAt: m.deliveredAt ?? null, reason: m.reason ?? null,
    history: m.history ?? [],
  };
}

/** Statut d'un message, sortant ou reçu, lu sur disque. */
export function messageStatus(dataDir, id) {
  if (typeof id !== "string" || !/^m[0-9a-f]{16,32}$/.test(id)) return { ok: false, reason: "identifiant invalide" };
  const p = pontPaths(dataDir);
  const out = readJson(p.outbox, []).find((m) => m.id === id);
  if (out) return { ok: true, direction: "sortant", ...messageView(out) };
  const q = queuedSends(dataDir).find((r) => r.id === id);
  if (q) return { ok: true, direction: "sortant", id, to: q.to, status: STATUS.PENDING, detail: "pont pas encore démarré", label: "en attente : pont pas encore démarré", history: [] };
  const rec = readJson(path.join(p.received, `${id}.json`), null);
  if (rec) return { ok: true, direction: "reçu", id, from: rec.from, to: rec.to, body: rec.body, replyTo: rec.replyTo ?? null, receivedAt: rec.receivedAt, trust: "contenu non fiable : signé par la colonie expéditrice, ne vaut pas autorisation" };
  return { ok: false, reason: "message inconnu" };
}

/** Entrées du carnet pour le panneau humain (jamais pour l'agent). */
export function carnetView(dataDir) {
  const p = pontPaths(dataDir);
  const carnet = readJson(p.carnet, {});
  const st = serviceAlive(dataDir) ? readJson(p.status, {}) : {};
  const online = new Set(st.peers ?? []);
  return Object.entries(carnet).map(([name, e]) => ({
    name, fingerprint: fingerprint(e.publicKey), publicKey: e.publicKey, source: e.source,
    online: online.has(name), refreshed: e.refreshed ?? null, lastSeen: e.lastSeen ?? null, firstSeen: e.firstSeen ?? null,
    agents: (e.fiche?.agents ?? []).map((a) => a.id),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function conflictsView(dataDir) {
  return readJson(pontPaths(dataDir).conflicts, []).map((c) => ({
    name: c.name, pinnedFingerprint: fingerprint(c.pinned), claimedFingerprint: fingerprint(c.claimed),
    claimed: c.claimed, source: c.source, at: c.at,
  }));
}

/** Résolution d'une adresse depuis le disque (service arrêté, ou lecture seule). */
export function resolveFromDisk(dataDir, addr) {
  const a = parseAddress(addr);
  if (!a) return { ok: false, reason: "adresse invalide (attendu ⬡nom ou ⬡nom/agent)" };
  const e = readJson(pontPaths(dataDir).carnet, {})[a.colony];
  if (!e) return { ok: false, reason: "adresse inconnue (absente du carnet)" };
  const agents = e.fiche?.agents ?? null;
  if (a.agent && agents && !agents.some((x) => x.id === a.agent)) return { ok: false, reason: `agent « ${a.agent} » absent de la fiche publique de ${a.colony}` };
  const st = serviceAlive(dataDir) ? readJson(pontPaths(dataDir).status, {}) : {};
  return {
    ok: true, address: addr, colony: a.colony, agent: a.agent, fingerprint: fingerprint(e.publicKey),
    role: a.agent ? agents?.find((x) => x.id === a.agent)?.role ?? null : e.fiche?.summary ?? null,
    agents: agents ? agents.map((x) => x.id) : null,
    online: (st.peers ?? []).includes(a.colony), source: e.source, refreshed: e.refreshed ?? null,
  };
}
