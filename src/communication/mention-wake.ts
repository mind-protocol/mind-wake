/**
 * Réveil par @id (NLR, 18 nov. 2026 : « n'importe qui écrit @id, ça doit atteindre cet agent »).
 * Quiconque écrit `@<id>` — NLR, la session principale, un pattern holder, un agent de room —
 * atteint la cible :
 * - agent de room (`@<agent-id>`, toutes les `forks/<n>/assignment.json`) : une notice ciblée
 *   « @mention → Nom » d'origine humaine. Room éteinte : le worker des rooms en fait un tour
 *   unique pour cet agent seul (forks.ts, `oneShotTriggers`), la room reste éteinte. Room
 *   allumée : la notice entre dans son tour suivant, ou est injectée dans le tour en cours
 *   (room-inbox-hook.ts) ; jamais une seconde instance.
 * - pattern holder (`@<slug>`) : un réveil « mention » sur ce message, publié dans le fil où il a
 *   été mentionné, seulement si le réveil naturel ne le couvre pas (fil qu'il n'écoute pas, ou
 *   auteur holder, que `wakeReason` écarte).
 * Gardes : un réveil par (message, cible) ; pas d'auto-mention ; entre deux agents (humain
 * exclu) au plus `MENTION_PAIR_CAP` réveils par heure glissante, dans les deux sens confondus ;
 * premier passage : curseurs au présent, l'historique ne réveille personne ; messages publics
 * Telegram (contenu externe) jamais pris pour des mentions.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { FORK_IDS, forkDir, forkEnabled, sendNoticeToFork } from "../daemon/forks.js";
import { readForkAssignment, resolveRoomAgents, type RoomAgent } from "../daemon/fork-assignment.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import type { FilMessage, HolderThread, PatternHolder } from "./pattern-holders.js";

export const MENTION_WAKES_STATE = "mention-wakes.json";
export const MENTION_PAIR_CAP = 6;
export const MENTION_PAIR_WINDOW_MS = 60 * 60_000;
const DONE_KEEP = 1000;
const SCAN = 200;
const MESSAGE_CHARS = 3000;
const HOLDER_KEY_PREFIX = "pattern-holder:";
/** Messages publics Telegram relayés dans le fil : contenu externe, jamais une mention. */
const UNTRUSTED_KEYS = ["telegram-public:"];

export type MentionAuthor =
  | { readonly kind: "human" }
  | { readonly kind: "principal" }
  | { readonly kind: "holder"; readonly id: string; readonly name: string }
  | { readonly kind: "agent"; readonly id: string; readonly name: string; readonly room: number }
  | { readonly kind: "room"; readonly room: number };

export interface MentionSource {
  readonly thread: HolderThread;
  readonly message: FilMessage;
  readonly author: MentionAuthor;
}

/** Holder à réveiller par `tickPatternHolders` (appel modèle asynchrone, publication). */
export interface HolderMentionWake {
  readonly slug: string;
  readonly thread: HolderThread;
  readonly message: FilMessage;
}

interface RoomInfo {
  readonly room: number;
  readonly agents: readonly RoomAgent[];
  readonly hub: string | null;
}

interface State {
  version: 1;
  principal?: string;
  forks: Record<string, number>;
  pairs: Record<string, number[]>;
  done: string[];
}

function readState(dataDir: string): State | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, MENTION_WAKES_STATE), "utf8")) as Partial<State>;
    return {
      version: 1,
      ...(typeof raw.principal === "string" ? { principal: raw.principal } : {}),
      forks: raw.forks !== null && typeof raw.forks === "object" ? raw.forks : {},
      pairs: raw.pairs !== null && typeof raw.pairs === "object" ? raw.pairs : {},
      done: Array.isArray(raw.done) ? raw.done.filter((d): d is string => typeof d === "string") : [],
    };
  } catch {
    return null;
  }
}

function writeState(dataDir: string, state: State): void {
  const file = path.join(dataDir, MENTION_WAKES_STATE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + "\n");
  fs.renameSync(tmp, file);
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** `@id` entier : `@se-vendre` ne trouve ni `@se-vendre-2` ni `x@se-vendre`. */
export function mentionsId(text: string, id: string): boolean {
  const escaped = fold(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_@.-])@${escaped}($|[^\\p{L}\\p{N}_-])`, "u").test(fold(text));
}

/** Agents des rooms (le premier gagne pour un id présent deux fois, comme `roomAgentIndex`). */
function readRooms(dataDir: string): RoomInfo[] {
  const rooms: RoomInfo[] = [];
  for (const room of FORK_IDS) {
    try {
      const assignment = readForkAssignment(forkDir(dataDir, room));
      if (assignment === null) continue;
      const agents = resolveRoomAgents(assignment, dataDir);
      if (agents.length > 0) rooms.push({ room, agents, hub: assignment.agentsFrom?.hub ?? null });
    } catch {
      // Affectation invalide : signalée par `forks status`.
    }
  }
  return rooms;
}

const startsAs = (text: string, name: string) =>
  text.startsWith(`${name} :`) || text.startsWith(`${name}:`) || text.startsWith(`**${name}**`);

function holderAuthor(text: string, holders: readonly PatternHolder[]): MentionAuthor | null {
  const h = holders.find((x) => text.startsWith(`${x.emoji} ${x.name} · `) || text.startsWith(`${x.emoji} ${x.name} :`));
  return h === undefined ? null : { kind: "holder", id: h.slug, name: h.name };
}

/** Messages du fil principal depuis `after`, avec leur auteur. */
function principalSources(
  dataDir: string,
  holders: readonly PatternHolder[],
  rooms: readonly RoomInfo[],
): MentionSource[] {
  const out: MentionSource[] = [];
  try {
    for (const raw of fs.readFileSync(path.join(dataDir, "human-messages.jsonl"), "utf8").split("\n").slice(-SCAN)) {
      try {
        const h = JSON.parse(raw) as { id?: unknown; at?: unknown; text?: unknown };
        if (typeof h.id !== "string" || typeof h.at !== "string" || typeof h.text !== "string") continue;
        let text = h.text;
        if (text.startsWith("{")) {
          try {
            const env = JSON.parse(text) as { text?: unknown };
            if (typeof env.text === "string") text = env.text;
          } catch {
            // Texte tel quel.
          }
        }
        out.push({ thread: "principal", author: { kind: "human" }, message: { id: h.id, at: h.at, author: "humain", text } });
      } catch {
        // Ligne partielle.
      }
    }
  } catch {
    // Aucun message humain.
  }
  const file = path.join(dataDir, "owner-messages.sqlite");
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT id, created_at, text, request_key FROM messages WHERE deleted=0 ORDER BY created_at DESC LIMIT ?")
        .all(SCAN) as { id: string; created_at: string; text: string; request_key: string }[];
      for (const r of rows) {
        if (UNTRUSTED_KEYS.some((k) => r.request_key.startsWith(k))) continue;
        const slug = r.request_key.startsWith(HOLDER_KEY_PREFIX)
          ? r.request_key.slice(HOLDER_KEY_PREFIX.length).split(":")[0]
          : undefined;
        const byKey = slug === undefined ? undefined : holders.find((h) => h.slug === slug);
        let author: MentionAuthor | null = byKey === undefined ? null : { kind: "holder", id: byKey.slug, name: byKey.name };
        author ??= holderAuthor(r.text, holders);
        if (author === null)
          for (const room of rooms) {
            const a = room.agents.find((x) => startsAs(r.text, x.name));
            if (a !== undefined) {
              author = { kind: "agent", id: a.id, name: a.name, room: room.room };
              break;
            }
          }
        out.push({
          thread: "principal",
          author: author ?? { kind: "principal" },
          message: {
            id: r.id, at: r.created_at, author: "agent", text: r.text,
            ...(author?.kind === "holder" ? { holder: author.id } : {}),
          },
        });
      }
    } finally {
      db.close();
    }
  }
  return out.sort((a, b) => a.message.at.localeCompare(b.message.at) || a.message.id.localeCompare(b.message.id));
}

/** Entrées d'une room après `after` (notices du runtime écartées, dont celles de ce module). */
function forkSources(
  dataDir: string,
  room: number,
  holders: readonly PatternHolder[],
  info: RoomInfo | undefined,
): { sources: MentionSource[]; last: number } {
  const dir = forkDir(dataDir, room);
  if (!SecondThreadStore.exists(dir)) return { sources: [], last: 0 };
  const store = new SecondThreadStore(dir);
  try {
    const entries = store.entries(SCAN);
    const last = Math.max(0, ...entries.map((e) => e.id));
    const sources: MentionSource[] = [];
    for (const e of entries) {
      if (e.notice !== undefined || (e.role !== "agent" && e.role !== "human")) continue;
      let author: MentionAuthor;
      if (e.role === "human") author = e.senderFork === undefined ? { kind: "human" } : { kind: "room", room: e.senderFork };
      else {
        const agent = info?.agents.find((a) => startsAs(e.text, a.name));
        author =
          holderAuthor(e.text, holders) ??
          (agent === undefined ? { kind: "room", room } : { kind: "agent", id: agent.id, name: agent.name, room });
      }
      sources.push({
        thread: `fork:${String(room)}` as HolderThread,
        author,
        message: {
          id: `fork:${String(room)}:${String(e.id)}`, at: e.at, author: e.role === "human" ? "humain" : "agent", text: e.text,
          ...(author.kind === "holder" ? { holder: author.id } : {}),
        },
      });
    }
    return { sources, last };
  } finally {
    store.close();
  }
}

function authorKey(a: MentionAuthor): string | null {
  switch (a.kind) {
    case "human": return null;
    case "principal": return "principal";
    case "holder": return `holder:${a.id}`;
    case "agent": return `agent:${a.id}`;
    case "room": return `room:${String(a.room)}`;
  }
}

function authorLabel(a: MentionAuthor): string {
  switch (a.kind) {
    case "human": return "NLR";
    case "principal": return "la session principale";
    case "holder": return `le pattern holder « ${a.name} » (@${a.id})`;
    case "agent": return `${a.name} (@${a.id}, Room ${String(a.room)})`;
    case "room": return `la Room ${String(a.room)}`;
  }
}

function threadName(thread: HolderThread): string {
  return thread === "principal" ? "le fil principal" : `le fil de la Room ${thread.slice("fork:".length)}`;
}

/**
 * Une mention d'un agent de la même room est-elle déjà remise par le routage de la room ? NLR
 * dans la room : routage de la room (tour unique adressé à l'agent nommé). Room allumée : la
 * publication d'un holder va à tous ; la réponse d'un agent est relayée au hub, ou du hub à
 * tous, ou sans hub aux agents nommés (room-agents.ts).
 */
function coveredByRoom(dataDir: string, source: MentionSource, room: RoomInfo, target: string): boolean {
  if (source.thread !== `fork:${String(room.room)}`) return false;
  const a = source.author;
  if (a.kind === "human") return true;
  if (!forkEnabled(dataDir, room.room)) return false;
  if (a.kind === "holder") return true;
  if (a.kind !== "agent") return false;
  if (room.hub === null || !room.agents.some((x) => x.id === room.hub)) return room.hub === null;
  return a.id === room.hub ? target !== room.hub : target === room.hub;
}

/**
 * Lit les messages frais de tous les fils, remet les mentions d'agents de room (notice ciblée
 * d'origine humaine) et rend les holders à réveiller. `holderThreadsOf` : fils qu'un holder écoute
 * déjà (réveil naturel par `wakeReason`).
 */
export function routeMentionWakes(options: {
  dataDir: string;
  holders: readonly PatternHolder[];
  holderThreadsOf: (slug: string) => readonly HolderThread[];
  now: number;
  settleMs: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): HolderMentionWake[] {
  const { dataDir, holders } = options;
  const rooms = readRooms(dataDir);
  const agentHome = new Map<string, { agent: RoomAgent; room: RoomInfo }>();
  for (const room of rooms) for (const agent of room.agents) if (!agentHome.has(agent.id)) agentHome.set(agent.id, { agent, room });
  const holderBySlug = new Map(holders.map((h) => [h.slug, h]));
  const prior = readState(dataDir);
  const first = prior === null;
  const state: State = prior ?? { version: 1, forks: {}, pairs: {}, done: [] };
  const done = new Set(state.done);
  const fresh: MentionSource[] = [];
  let dirty = first;

  // Fil principal : une série de dictées se lit d'un bloc ; on s'arrête avant les messages trop frais.
  const principal = principalSources(dataDir, holders, rooms);
  const ripe = principal.filter((s) => options.now - Date.parse(s.message.at) >= options.settleMs);
  if (state.principal === undefined) {
    state.principal = principal.at(-1)?.message.at ?? "";
    dirty = true;
  } else {
    const after = state.principal;
    const news = ripe.filter((s) => s.message.at > after);
    fresh.push(...news);
    const lastAt = news.at(-1)?.message.at;
    if (lastAt !== undefined) {
      state.principal = lastAt;
      dirty = true;
    }
  }
  for (const room of FORK_IDS) {
    const { sources, last } = forkSources(dataDir, room, holders, rooms.find((r) => r.room === room));
    const key = String(room);
    const cursor = state.forks[key];
    if (cursor === undefined) {
      state.forks[key] = last;
      dirty = true;
      continue;
    }
    const news = sources.filter((s) => Number(s.message.id.split(":")[2]) > cursor);
    fresh.push(...news);
    if (last > cursor) {
      state.forks[key] = last;
      dirty = true;
    }
  }

  const wakes: HolderMentionWake[] = [];
  const nowMs = options.now;
  for (const pairKey of Object.keys(state.pairs)) {
    const kept = (state.pairs[pairKey] ?? []).filter((t) => nowMs - t < MENTION_PAIR_WINDOW_MS);
    if (kept.length === 0) delete state.pairs[pairKey];
    else state.pairs[pairKey] = kept;
  }
  for (const source of first ? [] : fresh) {
    const { message: m, author } = source;
    if (!m.text.includes("@")) continue;
    const from = authorKey(author);
    const targets: { key: string; id: string }[] = [];
    for (const id of agentHome.keys()) if (mentionsId(m.text, id)) targets.push({ key: `agent:${id}`, id });
    for (const slug of holderBySlug.keys()) if (mentionsId(m.text, slug)) targets.push({ key: `holder:${slug}`, id: slug });
    for (const target of targets) {
      if (target.key === from) continue;
      const doneKey = `${m.id}>${target.key}`;
      if (done.has(doneKey)) continue;
      let deliver: (() => void) | null = null;
      let what = "";
      if (target.key.startsWith("agent:")) {
        const home = agentHome.get(target.id)!;
        if (coveredByRoom(dataDir, source, home.room, target.id)) continue;
        const quoted = m.text.length > MESSAGE_CHARS ? `${m.text.slice(0, MESSAGE_CHARS)}…` : m.text;
        const text = [
          `@${target.id} — ${authorLabel(author)} t'a mentionné dans ${threadName(source.thread)} [${m.at}] :`,
          quoted,
          "",
          `(Runtime : réveil par @${target.id}, un seul tour pour ce message${forkEnabled(dataDir, home.room.room) ? "" : " ; ta room reste éteinte ensuite"}. Pour répondre à l'auteur, mentionne son @id dans ta réponse, ou écris à NLR par message_owner.)`,
        ].join("\n");
        const key = `mention:${createHash("sha256").update(m.id).digest("hex").slice(0, 24)}:${target.id}`.slice(0, 128);
        what = `${home.agent.name} (Room ${String(home.room.room)})`;
        deliver = () => {
          sendNoticeToFork(dataDir, home.room.room, text.slice(0, 4000), key, `@mention → ${home.agent.name}`, true);
        };
      } else {
        const listened = options.holderThreadsOf(target.id);
        // Réveil naturel (wakeReason) : fil écouté, auteur qui n'est pas un holder.
        if (author.kind !== "holder" && listened.includes(source.thread)) continue;
        what = `holder @${target.id}`;
        deliver = () => {
          wakes.push({ slug: target.id, thread: source.thread, message: m });
        };
      }
      if (from !== null) {
        const pair = [from, target.key].sort().join("|");
        const recent = state.pairs[pair] ?? [];
        if (recent.length >= MENTION_PAIR_CAP) {
          options.log?.(`réveil par @id : ${what} non réveillé par ${m.id} — plafond de ${String(MENTION_PAIR_CAP)} réveils par heure entre ${pair} atteint`);
          done.add(doneKey);
          dirty = true;
          continue;
        }
        if (!options.dryRun) state.pairs[pair] = [...recent, nowMs];
      }
      if (options.dryRun) {
        if (target.key.startsWith("holder:")) deliver();
        continue;
      }
      try {
        deliver();
        options.log?.(`réveil par @id : ${what} ← ${authorLabel(author)} (${m.id})`);
      } catch (error) {
        options.log?.(`réveil par @id : ${what} — échec ${String(error)}`);
      }
      done.add(doneKey);
      dirty = true;
    }
  }
  if (dirty && !options.dryRun) writeState(dataDir, { ...state, done: [...done].slice(-DONE_KEEP) });
  return wakes;
}
