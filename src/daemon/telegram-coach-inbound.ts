/**
 * Coachs Telegram d'une room (NLR, 16 nov. 2026 13:04 et 13:07) : quand une personne du
 * `contacts.json` d'un coach écrit au compte Telegram personnel de NLR, le nouvel échange est
 * remis à ce coach seul, dans sa propre session (file privée des relais de la room, jamais une
 * entrée du fil commun) ; le fil de la room ne reçoit qu'une ligne de compte, sans nom. Les
 * messages que NLR a écrits à la main dans ce dialogue entre-temps sont remis aussi, dans l'ordre,
 * étiquetés NLR ; ceux que le coach a envoyés par son outil ne le sont pas (il les connaît).
 *
 * Interrogation périodique par le forks worker, une seule connexion Telethon par passage
 * (sous-commande `inbound` de services/telegram/user_account.py). Dernier id vu par dialogue :
 * forks/<room>/telegram-inbound.json. Premier passage d'un dialogue : point de départ seulement,
 * l'historique n'est pas remis.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { isMultiAgentRoom, readForkAssignment, resolveRoomAgents, type RoomAgent } from "./fork-assignment.js";
import { queuePrivateAgentMessage } from "./room-agents.js";
import { SecondThreadStore } from "./second-thread.js";

export const TELEGRAM_INBOUND_STATE = "telegram-inbound.json";
export const TELEGRAM_INBOUND_INTERVAL_MS = 45_000;
/** Messages demandés par dialogue et par passage (borne du sidecar). */
const BATCH = 50;
const TEXT_CHARS = 3500;
/** Rooms interrogées par défaut (mêmes ids que FORK_IDS de forks.ts, sans import circulaire). */
const ROOMS = [2, 3, 4, 5, 6, 7, 8] as const;

// ------------------------------------------------------------ contacts d'un coach

/** Personne portée par un coach Telegram (`contacts.json` de son dossier). */
export interface CoachContact {
  readonly name: string;
  readonly username: string | null;
  readonly id: string | null;
}

export class CoachContactsError extends Error {
  constructor(readonly code: "no_contacts" | "invalid_contacts", message: string) {
    super(message);
  }
}

/**
 * Contacts d'un coach : `[{"name":"...","username":"@...","id":123}]`. Erreur claire si le fichier
 * manque ou est illisible ; une entrée sans nom ni username ni id est ignorée.
 */
export function readCoachContacts(file: string): CoachContact[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new CoachContactsError(
      "no_contacts",
      `Aucun contacts.json pour ce coach (${file}) : rien ne peut partir. Crée ce fichier, au format [{"name":"...","username":"@...","id":123}], avec les seules personnes que tu portes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new CoachContactsError("invalid_contacts", `contacts.json illisible (${file}) : JSON attendu.`);
  }
  if (!Array.isArray(parsed)) throw new CoachContactsError("invalid_contacts", `contacts.json (${file}) : liste attendue.`);
  const contacts: CoachContact[] = [];
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"].trim() : "";
    const user = typeof o["username"] === "string" ? o["username"].trim().replace(/^@+/, "") : "";
    const idRaw = o["id"];
    const id =
      typeof idRaw === "number" && Number.isSafeInteger(idRaw)
        ? String(idRaw)
        : typeof idRaw === "string" && /^-?\d{1,20}$/.test(idRaw.trim())
          ? idRaw.trim()
          : null;
    if (name === "" && user === "" && id === null) continue;
    contacts.push({ name, username: user === "" ? null : `@${user}`, id });
  }
  return contacts;
}

/** Contact désigné par `to` (@username, id numérique ou nom exact, casse ignorée) ; `null` sinon. */
export function findCoachContact(contacts: readonly CoachContact[], to: string): CoachContact | null {
  const t = to.trim();
  if (t === "") return null;
  const user = t.replace(/^@+/, "").toLowerCase();
  return (
    contacts.find((c) => c.username !== null && c.username.slice(1).toLowerCase() === user) ??
    contacts.find((c) => c.id !== null && c.id === t) ??
    contacts.find((c) => c.name !== "" && c.name.toLowerCase() === t.toLowerCase()) ??
    null
  );
}

/** Cible passée au sidecar : username, sinon id, sinon nom. */
export function coachContactTarget(c: CoachContact): string {
  return c.username ?? c.id ?? c.name;
}

/** Clé stable d'un contact : id, sinon username, sinon nom. */
function contactKey(c: CoachContact): string {
  return c.id ?? c.username?.toLowerCase() ?? c.name.toLowerCase();
}

// ------------------------------------------------------------ sidecar

export type InboundSidecar = (stdin: string) => Promise<Record<string, unknown>>;

interface InboundMessage {
  readonly id: number;
  readonly date: string | null;
  readonly author: "moi" | "lui";
  readonly text: string;
  readonly media: boolean;
}
interface InboundPeer {
  readonly key: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly last_id?: number;
  readonly messages?: readonly InboundMessage[];
}

function sidecarScript(): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "services", "telegram", "user_account.py");
    if (fs.existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Python du sidecar : variable, puis celui de la transcription (telegram.json), puis `python`. */
function pythonFor(dataDir: string): string {
  const fromEnv = process.env["MIND_WAKE_TELEGRAM_USER_PYTHON"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const python = (
      JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as { transcription?: { python?: unknown } }
    ).transcription?.python;
    if (typeof python === "string" && python.trim() !== "") return python.trim();
  } catch {
    // Pas de configuration du bridge : Python du PATH.
  }
  return "python";
}

/** Sidecar réel (`inbound`) : stderr jeté, dernière ligne JSON de stdout. */
export function pythonInboundSidecar(dataDir: string, timeoutMs = 120_000): InboundSidecar {
  return (stdin) =>
    new Promise((resolve) => {
      const script = sidecarScript();
      if (script === null) return resolve({ ok: false, error: "sidecar_missing" });
      let child;
      try {
        child = spawn(pythonFor(dataDir), [script, "--data-dir", dataDir, "inbound"], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        });
      } catch {
        return resolve({ ok: false, error: "python_missing" });
      }
      let out = "";
      let settled = false;
      const finish = (v: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: "timeout" });
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (part: string) => (out += part));
      child.on("error", () => finish({ ok: false, error: "python_missing" }));
      child.on("close", () => {
        try {
          const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "") as unknown;
          if (parsed !== null && typeof parsed === "object") return finish(parsed as Record<string, unknown>);
        } catch {
          // Sortie illisible ci-dessous.
        }
        finish({ ok: false, error: "sidecar_failed" });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin, "utf8");
    });
}

// ------------------------------------------------------------ passage

type Cursors = Record<string, number>;

function readCursors(file: string): Cursors {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number"),
    );
  } catch {
    return {};
  }
}

function writeCursors(file: string, cursors: Cursors): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursors, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Ids des messages envoyés par l'outil de ce coach (table `user_outgoing`), pour ne pas les lui remettre. */
function coachSentIds(dataDir: string, coach: string): Set<string> {
  const file = path.join(dataDir, "telegram.sqlite");
  if (!fs.existsSync(file)) return new Set();
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    const prefix = `coach:${coach}:`;
    const rows = db
      .prepare("SELECT message_id FROM user_outgoing WHERE message_id IS NOT NULL AND substr(key,1,?)=?")
      .all(prefix.length, prefix) as { message_id: string }[];
    return new Set(rows.map((r) => r.message_id));
  } catch {
    return new Set();
  } finally {
    db?.close();
  }
}

function formatExchange(contact: CoachContact, messages: readonly InboundMessage[]): string {
  const who = contact.name || contact.username || contact.id || "?";
  const handle = contact.username ?? contact.id;
  const lines = messages.map((m) => {
    const author = m.author === "lui" ? who : "NLR (écrit à la main)";
    const body = m.text.trim() === "" ? (m.media ? "[média]" : "[vide]") : m.text.trim();
    return `[${m.date ?? "?"}] ${author} : ${body}${m.media && m.text.trim() !== "" ? " [+ média]" : ""}`;
  });
  let text = lines.join("\n");
  if (text.length > TEXT_CHARS) text = `…${text.slice(text.length - TEXT_CHARS)}`;
  return [
    `Nouveau sur Telegram, dialogue de NLR avec ${who}${handle !== null && handle !== who ? ` (${handle})` : ""} — remis à toi seul :`,
    text,
    `Pour répondre : telegram_user_send, to « ${handle ?? who} », avec une idempotency_key neuve.`,
  ].join("\n\n");
}

export interface InboundPollResult {
  readonly delivered: number;
  readonly skipped?: string;
}

/**
 * Un passage : pour chaque room à plusieurs agents active, chaque coach Telegram et chaque
 * personne de son contacts.json, les messages depuis le dernier id vu. Remis au coach s'il y a
 * au moins un message de la personne ; des messages de NLR seuls restent en attente de sa
 * réponse (jusqu'à un lot plein). Un dialogue introuvable ou une erreur n'avance rien.
 */
export async function pollTelegramCoachInbound(input: {
  dataDir: string;
  sidecar?: InboundSidecar;
  rooms?: readonly number[];
  enabled?: (room: number) => boolean;
  log?: (line: string) => void;
}): Promise<InboundPollResult> {
  const { dataDir } = input;
  if (!fs.existsSync(path.join(dataDir, "telegram-user.session"))) return { delivered: 0, skipped: "no_session" };
  const sidecar = input.sidecar ?? pythonInboundSidecar(dataDir);
  let delivered = 0;
  for (const room of input.rooms ?? ROOMS) {
    if (input.enabled !== undefined && !input.enabled(room)) continue;
    const dir = path.join(dataDir, "forks", String(room));
    let agents: RoomAgent[];
    try {
      const assignment = readForkAssignment(dir);
      if (assignment === null || !isMultiAgentRoom(assignment)) continue;
      agents = resolveRoomAgents(assignment, dataDir).filter((a) => a.telegramContacts !== undefined);
    } catch {
      continue;
    }
    const peers: { key: string; agent: RoomAgent; contact: CoachContact; after: number | null; target: string }[] = [];
    const stateFile = path.join(dir, TELEGRAM_INBOUND_STATE);
    const cursors = readCursors(stateFile);
    for (const agent of agents) {
      let contacts: CoachContact[];
      try {
        contacts = readCoachContacts(agent.telegramContacts!);
      } catch {
        continue;
      }
      for (const contact of contacts) {
        const key = `${agent.id}|${contactKey(contact)}`;
        if (peers.some((p) => p.key === key)) continue;
        peers.push({ key, agent, contact, after: cursors[key] ?? null, target: coachContactTarget(contact) });
      }
    }
    if (peers.length === 0) continue;
    const result = await sidecar(JSON.stringify({ peers: peers.map((p) => ({ key: p.key, target: p.target, after: p.after })) }));
    if (result["ok"] !== true || !Array.isArray(result["peers"])) {
      input.log?.(`Telegram entrant (room ${String(room)}) : ${String(result["error"] ?? "réponse illisible")}`);
      continue;
    }
    const byKey = new Map((result["peers"] as InboundPeer[]).map((p) => [p.key, p]));
    const counts = new Map<string, number>();
    const store = new SecondThreadStore(dir);
    try {
      const sentIds = new Map<string, Set<string>>();
      for (const p of peers) {
        const r = byKey.get(p.key);
        if (r === undefined || !r.ok || typeof r.last_id !== "number") continue;
        if (p.after === null) {
          cursors[p.key] = r.last_id;
          continue;
        }
        const own = sentIds.get(p.agent.id) ?? coachSentIds(dataDir, p.agent.id);
        sentIds.set(p.agent.id, own);
        const all = [...(r.messages ?? [])].filter((m) => m.id > (p.after ?? 0)).sort((a, b) => a.id - b.id);
        const visible = all.filter((m) => !(m.author === "moi" && own.has(String(m.id))));
        const incoming = visible.filter((m) => m.author === "lui").length;
        if (incoming === 0 && visible.length > 0 && all.length < BATCH) continue; // NLR seul : on attend la réponse.
        if (incoming > 0) {
          queuePrivateAgentMessage(store, {
            key: `telegram-in:${p.key}:${String(r.last_id)}`,
            to: p.agent.id,
            label: "Telegram (privé)",
            text: formatExchange(p.contact, visible),
          });
          counts.set(p.agent.name, (counts.get(p.agent.name) ?? 0) + incoming);
          delivered += incoming;
        }
        cursors[p.key] = Math.max(p.after, r.last_id);
      }
      // Fil commun : un compte, sans nom ni contenu.
      for (const [name, n] of counts)
        store.add("event", `${name} : ${String(n)} ${n > 1 ? "nouvelles réponses" : "nouvelle réponse"} Telegram (remise à lui seul).`);
    } finally {
      store.close();
    }
    writeCursors(stateFile, cursors);
  }
  return { delivered };
}

/** Boucle du forks worker : un passage toutes les ~45 s jusqu'à l'arrêt. */
export async function runTelegramCoachInbound(input: {
  dataDir: string;
  stopping: () => boolean;
  enabled?: (room: number) => boolean;
  log?: (line: string) => void;
  intervalMs?: number;
}): Promise<void> {
  const interval = input.intervalMs ?? TELEGRAM_INBOUND_INTERVAL_MS;
  while (!input.stopping()) {
    try {
      await pollTelegramCoachInbound({
        dataDir: input.dataDir,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.log === undefined ? {} : { log: input.log }),
      });
    } catch (error) {
      input.log?.(`Telegram entrant : ${error instanceof Error ? error.message : String(error)}`);
    }
    for (let waited = 0; waited < interval && !input.stopping(); waited += 200)
      await new Promise((r) => setTimeout(r, 200));
  }
}
