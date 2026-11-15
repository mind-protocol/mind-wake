/**
 * Pattern holders : des patterns et leur pourquoi vivent dans une conversation-semence portée
 * par un agent. Il est réveillé en continu : à chaque nouveau message du fil principal (hors
 * messages des holders), il relit sa conversation et le fil récent, puis intervient ou se
 * tait (`SILENCE`). Pas de filtre par mots-clés : c'est lui qui juge si son domaine est touché.
 * Son intervention est aussi remise à la session principale par `owner-inbox`.
 *
 * Les holders sont des données de l'agent, lues sans exécuter son code : un dossier
 * `artifacts/pattern-holders/<slug>/` de sections `.md` mises bout à bout, ou un fichier
 * `<slug>.md`. Même appel que la réponse rapide : Claude Code sans outils,
 * abonnement claude.ai, pas de clé API. Désactivé par défaut (`pattern-holders.json`).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { workspaceDirFor } from "../daemon/paths.js";
import { FORK_IDS, forkDir, forkEnabled } from "../daemon/forks.js";
import { readForkAssignment } from "../daemon/fork-assignment.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { OwnerMessages } from "./owner-messages.js";
import { enqueueOwnerMessage } from "./owner-inbox.js";
import {
  callClaude,
  fastReplyArgs,
  fastReplyClaude,
  type FastReplyClaude,
} from "./fast-reply.js";

export const PATTERN_HOLDERS_CONFIG = "pattern-holders.json";
export const PATTERN_HOLDERS_STATE = "pattern-holders-state.json";
export const PATTERN_HOLDERS_DIR = path.join("artifacts", "pattern-holders");
/** Identité de publication : le même agent que le fil, comme ⚡. */
export const PATTERN_HOLDER_AGENT_ID = "claude-wake";
const KEY_PREFIX = "pattern-holder:";
const SILENCE = "SILENCE";
const HISTORY_CHARS = 16_000;
const SEED_CHARS = 120_000;
/** Une série de dictées est lue d'un bloc : le dernier message doit avoir ce calme. */
export const PATTERN_HOLDER_SETTLE_MS = 8_000;
/** Une réponse humaine suit le dernier message du holder dans ce délai. */
const REPLY_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------- configuration

export function patternHoldersEnabled(dataDir: string): boolean {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(dataDir, PATTERN_HOLDERS_CONFIG), "utf8"),
    ) as { enabled?: unknown };
    return data.enabled === true;
  } catch {
    return false;
  }
}

export function savePatternHoldersEnabled(dataDir: string, enabled: boolean): void {
  writeJson(path.join(dataDir, PATTERN_HOLDERS_CONFIG), {
    version: 1,
    enabled,
    updatedAt: new Date().toISOString(),
  });
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- holders

export interface PatternHolder {
  readonly slug: string;
  readonly name: string;
  readonly emoji: string;
  /** Délai choisi par le holder entre deux interventions spontanées (0 par défaut). */
  readonly quietMs: number;
  /** Conversation-semence complète (fichier entier ou sections bout à bout), mémoire du holder. */
  readonly seed: string;
  /** `<slug>.md`, ou le dossier `<slug>/` pour un holder en sections. */
  readonly file: string;
  /** Fichiers des sections, dans l'ordre de lecture (holder en dossier seulement). */
  readonly sections?: readonly string[];
}

export type HolderParse = { holder: PatternHolder } | { error: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Lit un holder : un bloc ```json pattern-holder``` puis la conversation-semence. */
export function parsePatternHolder(file: string, text: string): HolderParse {
  const slug = path.basename(file, ".md");
  if (!SLUG.test(slug)) return { error: `nom de fichier invalide : ${slug}` };
  const match = /```json pattern-holder\s*\n([\s\S]*?)\n```/.exec(text);
  if (match === null) return { error: "bloc ```json pattern-holder``` absent" };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(match[1] ?? "") as Record<string, unknown>;
  } catch (error) {
    return { error: `en-tête JSON invalide : ${String(error)}` };
  }
  const name = typeof header["name"] === "string" ? header["name"].trim() : "";
  if (name === "") return { error: "`name` requis" };
  const quiet = header["quietMinutes"];
  return {
    holder: {
      slug,
      name: name.slice(0, 60),
      emoji: typeof header["emoji"] === "string" ? header["emoji"].slice(0, 8) : "🧭",
      quietMs:
        typeof quiet === "number" && Number.isFinite(quiet) && quiet >= 0
          ? Math.min(quiet, 24 * 60) * 60_000
          : 0,
      seed: text.slice(0, SEED_CHARS),
      file,
    },
  };
}

export function patternHoldersDir(dataDir: string): string {
  return path.join(workspaceDirFor(dataDir), PATTERN_HOLDERS_DIR);
}

/** Séparateur entre deux sections d'un holder en dossier. */
export const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * Sections d'un holder en dossier : ses `.md` ordinaires (y compris `_holder.md`), triés par
 * nom de fichier (ordre des codes, `_` avant les lettres), mis bout à bout.
 */
export function readHolderSections(dir: string): { text: string; sections: string[] } | {
  error: string;
} {
  const sections = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .filter((n) => {
      const stat = fs.lstatSync(path.join(dir, n));
      return stat.isFile() && !stat.isSymbolicLink();
    });
  if (sections.length === 0) return { error: "dossier sans section .md" };
  const text = sections
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8").trim())
    .join(SECTION_SEPARATOR);
  return { text, sections };
}

/**
 * Holders valides du workspace, et les entrées ignorées avec leur raison. Un holder est un
 * dossier `<slug>/` de sections ou un fichier `<slug>.md` ; si les deux existent, le dossier
 * fait foi et le fichier est laissé de côté. Les entrées commençant par `_` sont ignorées.
 */
export function loadPatternHolders(dataDir: string): {
  holders: PatternHolder[];
  invalid: { file: string; error: string }[];
} {
  const dir = patternHoldersDir(dataDir);
  const holders: PatternHolder[] = [];
  const invalid: { file: string; error: string }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith("_"));
  } catch {
    return { holders, invalid };
  }
  const folders = new Set<string>();
  const files: string[] = [];
  for (const name of names) {
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) folders.add(name);
      else if (name.endsWith(".md")) files.push(name);
    } catch (error) {
      invalid.push({ file: path.join(dir, name), error: String(error) });
    }
  }
  const entries = [
    ...[...folders].map((name) => ({ slug: name, folder: true })),
    ...files
      .filter((name) => !folders.has(path.basename(name, ".md")))
      .map((name) => ({ slug: path.basename(name, ".md"), folder: false })),
  ].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const entry of entries) {
    const file = path.join(dir, entry.folder ? entry.slug : `${entry.slug}.md`);
    try {
      if (entry.folder) {
        const read = readHolderSections(file);
        if ("error" in read) {
          invalid.push({ file, error: read.error });
          continue;
        }
        const parsed = parsePatternHolder(file, read.text);
        if ("error" in parsed) invalid.push({ file, error: parsed.error });
        else holders.push({ ...parsed.holder, sections: read.sections });
        continue;
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        invalid.push({ file, error: "pas un fichier ordinaire" });
        continue;
      }
      const parsed = parsePatternHolder(file, fs.readFileSync(file, "utf8"));
      if ("error" in parsed) invalid.push({ file, error: parsed.error });
      else holders.push(parsed.holder);
    } catch (error) {
      invalid.push({ file, error: String(error) });
    }
  }
  return { holders, invalid };
}

// ---------------------------------------------------------------- fil principal

export interface FilMessage {
  readonly id: string;
  readonly at: string;
  readonly author: "humain" | "agent";
  readonly text: string;
  /** Slug du holder auteur, pour un message publié par un pattern holder. */
  readonly holder?: string;
}

/** Texte lisible d'un message humain : les dictées arrivent dans une enveloppe JSON. */
export function humanText(raw: string): string {
  if (!raw.startsWith("{")) return raw;
  try {
    const envelope = JSON.parse(raw) as { schema?: unknown; text?: unknown };
    if (
      typeof envelope.schema === "string" &&
      envelope.schema.startsWith("mind.voice.part") &&
      typeof envelope.text === "string"
    )
      return envelope.text;
  } catch {
    // Pas une enveloppe : texte tel quel.
  }
  return raw;
}

/** Messages du fil principal des deux côtés, du plus ancien au plus récent. */
export function readFil(dataDir: string, limit = 200): FilMessage[] {
  const out: FilMessage[] = [];
  try {
    for (const raw of fs
      .readFileSync(path.join(dataDir, "human-messages.jsonl"), "utf8")
      .split("\n")
      .slice(-limit)) {
      try {
        const h = JSON.parse(raw) as { id?: unknown; at?: unknown; text?: unknown };
        if (typeof h.id === "string" && typeof h.at === "string" && typeof h.text === "string")
          out.push({ id: h.id, at: h.at, author: "humain", text: humanText(h.text) });
      } catch {
        // Ligne partielle : ignorée.
      }
    }
  } catch {
    // Aucun message humain.
  }
  const file = path.join(dataDir, "owner-messages.sqlite");
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      for (const r of db
        .prepare(
          "SELECT id, created_at, text, request_key FROM messages WHERE deleted=0 ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as { id: string; created_at: string; text: string; request_key: string }[]) {
        const holder = r.request_key.startsWith(KEY_PREFIX)
          ? r.request_key.slice(KEY_PREFIX.length).split(":")[0]
          : undefined;
        out.push({
          id: r.id,
          at: r.created_at,
          author: "agent",
          text: r.text,
          ...(holder === undefined ? {} : { holder }),
        });
      }
    } finally {
      db.close();
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- réveil

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Le mot ou l'expression apparaît entier dans le texte, sans tenir compte des accents. */
export function mentionsTopic(text: string, topic: string): boolean {
  const t = fold(topic).trim();
  if (t === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(t)}($|[^\\p{L}\\p{N}])`, "u").test(
    fold(text),
  );
}

export type WakeReason = "mention" | "reply" | "fil";

/**
 * Pourquoi ce holder se réveille pour ces nouveaux messages, ou `null`. Tout nouveau message
 * le réveille ; mention et réponse l'obligent à répondre. Les messages des holders ne
 * réveillent personne : pas de conversation en boucle entre holders.
 */
export function wakeReason(
  holder: PatternHolder,
  fil: readonly FilMessage[],
  fresh: readonly FilMessage[],
): { reason: WakeReason } | null {
  let reason: WakeReason | null = null;
  for (const m of fresh) {
    if (m.holder !== undefined) continue;
    if (mentionsTopic(m.text, `@${holder.slug}`) || mentionsTopic(m.text, holder.name)) {
      reason = "mention";
      continue;
    }
    if (m.author === "humain" && reason !== "mention") {
      const before = fil.filter((x) => x.at < m.at && x.id !== m.id).at(-1);
      if (
        before?.holder === holder.slug &&
        Date.parse(m.at) - Date.parse(before.at) <= REPLY_WINDOW_MS
      )
        reason = "reply";
    }
    reason ??= "fil";
  }
  return reason === null ? null : { reason };
}

// ---------------------------------------------------------------- prompt

export const PATTERN_HOLDER_NOTE = [
  "Tu es un pattern holder de l'agent MIND : tu portes des patterns et leur pourquoi, dans ta conversation-semence ci-dessous. Ce n'est ni un compte rendu ni un registre de décisions. Tu dors le reste du temps ; le runtime te réveille à chaque nouveau message du fil principal, et c'est à toi de juger si un de tes patterns est en jeu.",
  "Tu n'as aucun outil : tu ne lis aucun fichier, ne lances rien et ne vérifies rien. Ton texte est publié tel quel dans le fil principal, sous ton nom, et remis à la session principale, qui a les outils et fait le travail.",
  "Ton rôle : aider l'agent à être en bonne posture, à partir des patterns et de leur pourquoi : conseil, vision, feedback sur sa façon de faire. Rappelle un pattern au moment où il est en jeu, relie une idée nouvelle à ce que tu portes, signale une contradiction ou une question restée ouverte. Tu ne fais pas le travail de la session principale et tu ne répètes pas ce qui vient d'être dit.",
  "Tu portes le comment et le pourquoi, pas le quoi ni le quand : c'est ton humain qui dirige le travail. Vérifier n'est pas un feu vert à attendre : ne bloque personne, propose d'avancer par petites passes et de corriger ensuite. Ce que ton humain n'a pas tranché reste ouvert : ne lui fais pas dire une décision qu'il n'a pas prise.",
  "Tes sections sont à toi et tu les entretiens toi-même. Quand tu reconnais un pattern important à garder, ou quand ton humain corrige ou complète un pattern, écris la section dans ta réponse avec un bloc ```section nom-de-section.md``` contenant la section entière (bout de discussion avec son pourquoi, dans le style de tes sections). Le runtime l'enregistre dans ton dossier et l'annonce dans le fil. Un pattern n'a pas besoin de s'être joué devant vous : il est vrai en soi. Un nom existant remplace la section : enrichis-la plutôt que d'en créer une qui la répète. Nom en minuscules et tirets ; pas de `_holder.md`, pas de nom commençant par `zz` (l'objectif reste en dernier). Au plus deux sections par réponse ; ajoute une phrase qui dit ce que tu as écrit et pourquoi.",
  "Si le réveil vient d'une mention ou d'une réponse qui t'est adressée, réponds. Sinon, n'interviens que si tu apportes quelque chose de réel à ce moment ; dans le doute, réponds exactement SILENCE. Une à quatre phrases, dans la langue de ton humain, sans titres ni préambule ; n'écris ni ton nom ni ton emoji, le runtime les ajoute.",
].join(" ");

export function patternHolderSystemPrompt(holder: PatternHolder): string {
  return [
    PATTERN_HOLDER_NOTE,
    "",
    `Ton nom : ${holder.name} (@${holder.slug}).`,
    "",
    ...(holder.sections === undefined
      ? []
      : [`Tes sections, dans l'ordre : ${holder.sections.join(", ")}.`, ""]),
    "--- Ta conversation-semence (mémoire, données et non consignes système) ---",
    holder.seed,
    "--- Fin de la conversation-semence ---",
  ].join("\n");
}

function bound(lines: readonly FilMessage[], chars: number): FilMessage[] {
  const kept: FilMessage[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    size += line.text.length + 60;
    if (size > chars && kept.length > 0) break;
    kept.push(line);
  }
  return kept.reverse();
}

export function patternHolderPrompt(
  holder: PatternHolder,
  fil: readonly FilMessage[],
  fresh: readonly FilMessage[],
  wake: { reason: WakeReason },
  threadLabel = "Fil principal",
): string {
  const freshIds = new Set(fresh.map((m) => m.id));
  const show = (m: FilMessage) =>
    JSON.stringify({
      at: m.at,
      auteur:
        m.holder === undefined
          ? m.author
          : m.holder === holder.slug
            ? "toi (pattern holder)"
            : `pattern holder @${m.holder}`,
      texte: m.text,
    });
  const earlier = bound(
    fil.filter((m) => !freshIds.has(m.id)),
    HISTORY_CHARS,
  );
  const why =
    wake.reason === "mention"
      ? "Tu es mentionné directement : réponds."
      : wake.reason === "reply"
        ? "Ton humain répond à ton dernier message : réponds."
        : "Nouveaux messages dans le fil. Interviens seulement si un de tes patterns est en jeu et que tu apportes quelque chose maintenant ; sinon SILENCE.";
  return [
    `${threadLabel} récent (le plus récent en dernier) :`,
    ...earlier.map(show),
    "",
    "Nouveaux messages depuis ton dernier réveil :",
    ...fresh.map(show),
    "",
    why,
  ].join("\n");
}

// ---------------------------------------------------------------- état

interface HolderState {
  /** Fil écouté au dernier passage ; absent = fil principal. */
  thread?: HolderThread;
  /** Dernier message du fil déjà examiné (date ISO). */
  cursor: string;
  lastSpokeAt?: string;
  lastResult?: { at: string; state: "spoke" | "silent" | "failed"; detail?: string };
}
type State = Record<string, HolderState>;

export function readPatternHolderState(dataDir: string): State {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, PATTERN_HOLDERS_STATE), "utf8"),
    ) as State;
  } catch {
    return {};
  }
}

function saveState(dataDir: string, state: State): void {
  writeJson(path.join(dataDir, PATTERN_HOLDERS_STATE), state);
}

// ---------------------------------------------------------------- fil écouté

/** Fil écouté par un holder : `principal`, ou `fork:<n>` quand ce fork l'a dans son affectation. */
export type HolderThread = "principal" | `fork:${number}`;

/**
 * Un holder rattaché à un fork actif (`forks assign … holder`) écoute le fil de ce fork et y
 * publie ; sinon il écoute le fil principal. Une affectation illisible est ignorée ici.
 */
export function holderThread(dataDir: string, slug: string): HolderThread | null {
  let assigned = false;
  for (const id of FORK_IDS) {
    try {
      if (readForkAssignment(forkDir(dataDir, id))?.holder !== slug) continue;
      assigned = true;
      if (forkEnabled(dataDir, id)) return `fork:${String(id)}` as HolderThread;
    } catch {
      // Affectation invalide : signalée par `forks status`, pas par les holders.
    }
  }
  return assigned ? null : "principal";
}

function forkIdOf(thread: HolderThread): number {
  return Number(thread.slice("fork:".length));
}

export function threadLabel(thread: HolderThread): string {
  return thread === "principal" ? "Fil principal" : `Fil du fork ${String(forkIdOf(thread))}`;
}

/**
 * Messages d'un fork, du plus ancien au plus récent : messages humains directs et réponses du
 * fork. Les notices du runtime sont écartées ; un message qui commence par le préfixe d'un
 * holder est attribué à ce holder.
 */
export function readForkThread(
  dataDir: string,
  id: number,
  holders: readonly PatternHolder[],
  limit = 200,
): FilMessage[] {
  const dir = forkDir(dataDir, id);
  if (!SecondThreadStore.exists(dir)) return [];
  const store = new SecondThreadStore(dir);
  try {
    return store
      .entries(limit)
      .filter((e) => e.notice === undefined && (e.role === "agent" || e.role === "human"))
      .map((e): FilMessage => {
        const owner = holders.find((h) => e.text.startsWith(`${h.emoji} ${h.name} · `));
        return {
          id: `fork:${String(id)}:${String(e.id)}`,
          at: e.at,
          author: e.role === "human" ? "humain" : "agent",
          text: e.text,
          ...(owner === undefined ? {} : { holder: owner.slug }),
        };
      })
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  } finally {
    store.close();
  }
}

function readThread(
  dataDir: string,
  thread: HolderThread,
  holders: readonly PatternHolder[],
): FilMessage[] {
  return thread === "principal"
    ? readFil(dataDir)
    : readForkThread(dataDir, forkIdOf(thread), holders);
}

/** Publie l'intervention dans le fil du fork et la remet à la session du fork. */
function publishInFork(
  dataDir: string,
  holder: PatternHolder,
  thread: HolderThread,
  text: string,
  trigger: string,
): string {
  const id = forkIdOf(thread);
  const store = new SecondThreadStore(forkDir(dataDir, id));
  try {
    const entry = store.add("agent", `${holder.emoji} ${holder.name} · ${text}`.slice(0, 4000));
    const key = `${KEY_PREFIX}${holder.slug}:${trigger}`
      .replace(/[^A-Za-z0-9_.:-]/g, "-")
      .slice(0, 128);
    store.addNoticeOnce(
      key,
      `MIND runtime — ton pattern holder « ${holder.name} » (@${holder.slug}) est intervenu dans ton fil :\n${JSON.stringify(text)}\nIl garde tes patterns et leur pourquoi. Tiens-en compte ; s'il se trompe, dis-le dans ton fil.`,
      `Pattern holder · ${holder.name}`,
      true,
    );
    return `fork:${String(id)}:${String(entry)}`;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- publication

export function deliverHolderMessage(
  dataDir: string,
  holder: PatternHolder,
  reply: { replyId: string; text: string; triggerId: string },
): void {
  enqueueOwnerMessage(dataDir, {
    id: `${KEY_PREFIX}${holder.slug}:${reply.triggerId}`.slice(0, 128),
    at: new Date().toISOString(),
    text: `MIND runtime — le pattern holder « ${holder.name} » (@${holder.slug}) est intervenu dans le fil principal (${reply.replyId}) :\n${JSON.stringify(reply.text)}\nIl porte des patterns et leur pourquoi. Tiens-en compte. Pour lui répondre ou le contredire, écris dans le fil en le mentionnant (@${holder.slug}). Pour ajouter ou corriger un pattern, ajoute ou modifie une section dans artifacts/pattern-holders/${holder.slug}/.`,
    origin: {
      kind: "peer_message",
      channel: "pattern-holder",
      author: `Pattern holder · ${holder.name}`,
      senderRef: `${KEY_PREFIX}${holder.slug}`,
      recipientRef: "principal",
      threadId: "principal",
      messageId: reply.replyId,
      correlationId: reply.triggerId,
    },
  });
}

// ---------------------------------------------------------------- un passage

export interface PatternHolderTickOptions {
  readonly dataDir: string;
  readonly claude?: FastReplyClaude;
  readonly call?: typeof callClaude;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** N'appelle pas le modèle et ne publie rien : rend seulement les réveils prévus. */
  readonly dryRun?: boolean;
  /** Limite le passage à ces holders. */
  readonly only?: readonly string[];
}

export interface PatternHolderOutcome {
  readonly slug: string;
  readonly state: "spoke" | "silent" | "failed" | "quiet" | "planned";
  readonly reason?: WakeReason;
  readonly text?: string;
  readonly detail?: string;
}

export function patternHolderClaude(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FastReplyClaude {
  const base = fastReplyClaude(env);
  return { ...base, model: env["MIND_WAKE_PATTERN_HOLDER_MODEL"] ?? base.model };
}

/**
 * Examine les nouveaux messages du fil pour chaque holder, réveille ceux qui sont concernés
 * et publie leurs interventions. Un premier passage sans état place le curseur au présent :
 * l'historique ancien ne réveille personne.
 */
export async function tickPatternHolders(
  options: PatternHolderTickOptions,
): Promise<PatternHolderOutcome[]> {
  const { dataDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const { holders, invalid } = loadPatternHolders(dataDir);
  for (const bad of invalid) log(`pattern holder ignoré ${bad.file} : ${bad.error}`);
  if (holders.length === 0) return [];
  const threads = new Map<HolderThread, FilMessage[]>();
  const filOf = (thread: HolderThread): FilMessage[] => {
    let fil = threads.get(thread);
    if (fil === undefined) {
      fil = readThread(dataDir, thread, holders);
      threads.set(thread, fil);
    }
    return fil;
  };
  const state = readPatternHolderState(dataDir);
  const outcomes: PatternHolderOutcome[] = [];
  let dirty = false;
  for (const holder of holders) {
    if (options.only !== undefined && !options.only.includes(holder.slug)) continue;
    const thread = holderThread(dataDir, holder.slug);
    // Une affectation vers un fork désactivé reste une affectation : ce holder se tait
    // jusqu'à la réactivation, sans lire le principal ni produire de bruit.
    if (thread === null) continue;
    const fil = filOf(thread);
    const latest = fil.at(-1);
    // Une série de dictées se lit d'un bloc.
    if (latest !== undefined && now() - Date.parse(latest.at) < PATTERN_HOLDER_SETTLE_MS) continue;
    const own = state[holder.slug];
    if (own === undefined || (own.thread ?? "principal") !== thread) {
      // Premier passage, ou holder déplacé vers un autre fil : il part du présent de ce fil.
      state[holder.slug] = { ...own, cursor: latest?.at ?? "", thread };
      dirty = true;
      continue;
    }
    const fresh = fil.filter((m) => m.at > own.cursor);
    if (fresh.length === 0) continue;
    const wake = wakeReason(holder, fil, fresh);
    const cursor = fresh.at(-1)?.at ?? own.cursor;
    if (wake === null) {
      if (!options.dryRun) {
        own.cursor = cursor;
        dirty = true;
      }
      continue;
    }
    if (
      wake.reason === "fil" &&
      own.lastSpokeAt !== undefined &&
      now() - Date.parse(own.lastSpokeAt) < holder.quietMs
    ) {
      // Pause qu'il s'est choisie après avoir parlé : pas de rattrapage plus tard.
      if (!options.dryRun) {
        own.cursor = cursor;
        dirty = true;
      }
      outcomes.push({ slug: holder.slug, state: "quiet", reason: wake.reason });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ slug: holder.slug, state: "planned", reason: wake.reason });
      continue;
    }
    // Le curseur avance avant l'appel : un échec ne réveille pas le holder en boucle.
    own.cursor = cursor;
    saveState(dataDir, state);
    dirty = false;
    const outcome = await wakeHolder(options, holder, fil, fresh, wake, thread);
    own.lastResult = {
      at: new Date(now()).toISOString(),
      state: outcome.state === "spoke" ? "spoke" : outcome.state === "failed" ? "failed" : "silent",
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    };
    if (outcome.state === "spoke") own.lastSpokeAt = own.lastResult.at;
    saveState(dataDir, state);
    outcomes.push(outcome);
  }
  if (dirty && !options.dryRun) saveState(dataDir, state);
  return outcomes;
}

/**
 * Essai sans publication ni état : réveille un holder sur les messages du fil depuis `since`
 * (mention forcée si aucun réveil naturel) et rend sa réponse.
 */
export async function previewPatternHolder(options: {
  dataDir: string;
  slug: string;
  since: string;
  claude?: FastReplyClaude;
  call?: typeof callClaude;
}): Promise<{ reason: WakeReason; natural: boolean; text: string } | { error: string }> {
  const holder = loadPatternHolders(options.dataDir).holders.find((h) => h.slug === options.slug);
  if (holder === undefined) return { error: `holder introuvable : ${options.slug}` };
  const fil = readFil(options.dataDir);
  const fresh = fil.filter((m) => m.at >= options.since);
  if (fresh.length === 0) return { error: `aucun message depuis ${options.since}` };
  const natural = wakeReason(holder, fil, fresh);
  const wake = natural ?? { reason: "mention" as const };
  const claude = options.claude ?? patternHolderClaude();
  const dir = path.join(options.dataDir, "pattern-holders", holder.slug);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, "system-prompt.preview.md");
  fs.writeFileSync(promptFile, patternHolderSystemPrompt(holder));
  const result = await (options.call ?? callClaude)(
    claude,
    fastReplyArgs(claude.model, promptFile),
    patternHolderPrompt(holder, fil, fresh, wake),
    dir,
  );
  if ("error" in result) return { error: result.error };
  return { reason: wake.reason, natural: natural !== null, text: result.text.trim() };
}

async function wakeHolder(
  options: PatternHolderTickOptions,
  holder: PatternHolder,
  fil: readonly FilMessage[],
  fresh: readonly FilMessage[],
  wake: { reason: WakeReason },
  thread: HolderThread = "principal",
): Promise<PatternHolderOutcome> {
  const { dataDir } = options;
  const log = options.log ?? (() => undefined);
  const claude = options.claude ?? patternHolderClaude();
  const dir = path.join(dataDir, "pattern-holders", holder.slug);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, "system-prompt.md");
  fs.writeFileSync(promptFile, patternHolderSystemPrompt(holder));
  const started = Date.now();
  const result = await (options.call ?? callClaude)(
    claude,
    fastReplyArgs(claude.model, promptFile),
    patternHolderPrompt(holder, fil, fresh, wake, threadLabel(thread)),
    dir,
  );
  if ("error" in result) {
    log(`pattern holder ${holder.slug} : échec — ${result.error}`);
    return { slug: holder.slug, state: "failed", reason: wake.reason, detail: result.error };
  }
  const edits = extractSections(withoutOwnPrefix(holder, result.text));
  const written = writeHolderSections(dataDir, holder, edits.sections);
  for (const w of written)
    log(`pattern holder ${holder.slug} : section ${w.name} ${w.state}${w.error === undefined ? "" : ` — ${w.error}`}`);
  const notes = written.map((w) =>
    w.state === "refusée"
      ? `(section ${w.name} non enregistrée : ${w.error ?? "refusée"})`
      : `(section ${w.name} ${w.state})`,
  );
  const said = edits.text === SILENCE || edits.text.endsWith(`\n${SILENCE}`) ? "" : edits.text;
  const text = [said, ...notes].filter((t) => t !== "").join("\n");
  if (text === "") {
    log(`pattern holder ${holder.slug} (${wake.reason}) : silence`);
    return { slug: holder.slug, state: "silent", reason: wake.reason };
  }
  const trigger = fresh.at(-1)?.id ?? "fil";
  if (thread !== "principal") {
    const replyId = publishInFork(dataDir, holder, thread, text, trigger);
    log(
      `pattern holder ${holder.slug} (${wake.reason}) publié dans ${thread} (${replyId}) en ${String(Date.now() - started)} ms`,
    );
    return { slug: holder.slug, state: "spoke", reason: wake.reason, text };
  }
  const messages = new OwnerMessages(dataDir, PATTERN_HOLDER_AGENT_ID);
  let replyId: string;
  try {
    replyId = messages.publish(
      `${holder.emoji} ${holder.name} · ${text}`.slice(0, 4000),
      `${KEY_PREFIX}${holder.slug}:${trigger}`.slice(0, 200),
      new Date((options.now ?? Date.now)()).toISOString(),
    ).id;
  } finally {
    messages.close();
  }
  try {
    deliverHolderMessage(dataDir, holder, { replyId, text, triggerId: trigger });
  } catch (error) {
    log(`pattern holder ${holder.slug} : remise au principal en échec — ${String(error)}`);
  }
  log(
    `pattern holder ${holder.slug} (${wake.reason}) publié en ${String(Date.now() - started)} ms`,
  );
  return { slug: holder.slug, state: "spoke", reason: wake.reason, text };
}

// ---------------------------------------------------------------- sections écrites par le holder

const SECTION_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
const SECTION_MAX_CHARS = 12_000;
const SECTIONS_PER_WAKE = 2;

/** Blocs ```section nom.md``` d'une réponse, et le texte restant à publier. */
export function extractSections(raw: string): {
  text: string;
  sections: { name: string; content: string }[];
} {
  const sections: { name: string; content: string }[] = [];
  const text = raw
    .replace(/```section[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)\r?\n```/g, (_m, name: string, body: string) => {
      sections.push({ name: name.trim(), content: body });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, sections };
}

export interface SectionWrite {
  readonly name: string;
  readonly state: "ajoutée" | "mise à jour" | "refusée";
  readonly error?: string;
}

/**
 * Enregistre les sections proposées par un holder en dossier. Garde-fous : seulement son
 * dossier, noms simples, ni `_holder.md` ni nom classé à partir de `zz` (l'objectif reste en
 * dernier), taille bornée, deux sections par réveil. Écriture atomique.
 */
export function writeHolderSections(
  dataDir: string,
  holder: PatternHolder,
  sections: readonly { name: string; content: string }[],
): SectionWrite[] {
  const dir = path.join(patternHoldersDir(dataDir), holder.slug);
  const out: SectionWrite[] = [];
  let folder: boolean;
  try {
    const stat = fs.lstatSync(dir);
    folder = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    folder = false;
  }
  for (const [index, section] of sections.entries()) {
    const refuse = (error: string) => out.push({ name: section.name, state: "refusée", error });
    if (!folder) {
      refuse("holder sans dossier de sections");
      continue;
    }
    if (index >= SECTIONS_PER_WAKE) {
      refuse(`au plus ${String(SECTIONS_PER_WAKE)} sections par réveil`);
      continue;
    }
    if (!SECTION_NAME.test(section.name) || section.name.startsWith("zz")) {
      refuse("nom invalide (minuscules, chiffres, tirets, .md ; rien qui commence par zz)");
      continue;
    }
    const content = section.content.trim();
    if (content === "" || content.length > SECTION_MAX_CHARS) {
      refuse(`contenu vide ou de plus de ${String(SECTION_MAX_CHARS)} caractères`);
      continue;
    }
    const file = path.join(dir, section.name);
    let existed: boolean;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        refuse("pas un fichier ordinaire");
        continue;
      }
      existed = true;
    } catch {
      existed = false;
    }
    try {
      const tmp = `${file}.${String(process.pid)}.tmp`;
      fs.writeFileSync(tmp, content + "\n");
      fs.renameSync(tmp, file);
      out.push({ name: section.name, state: existed ? "mise à jour" : "ajoutée" });
    } catch (error) {
      refuse(String(error));
    }
  }
  return out;
}

/** Le modèle recopie parfois le préfixe qu'il voit sur ses messages passés : retiré. */
export function withoutOwnPrefix(holder: PatternHolder, raw: string): string {
  let text = raw.trim();
  for (;;) {
    const before = text;
    if (text.startsWith(holder.emoji)) text = text.slice(holder.emoji.length).trimStart();
    if (text.startsWith(holder.name))
      text = text.slice(holder.name.length).replace(/^\s*[·:\-—]\s*/u, "");
    if (text === before) return text;
  }
}

// ---------------------------------------------------------------- service du moteur

export interface PatternHolderServiceOptions {
  readonly dataDir: string;
  readonly allowed?: () => boolean;
  readonly claude?: FastReplyClaude;
  readonly call?: typeof callClaude;
  readonly log?: (message: string) => void;
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** Hébergé par `daemon run`, comme la réponse rapide ; vit et s'arrête avec le moteur. */
export class PatternHolderService {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(private readonly options: PatternHolderServiceOptions) {}

  start(): void {
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#running;
  }

  async tick(): Promise<void> {
    const { dataDir } = this.options;
    if (this.#closed || !patternHoldersEnabled(dataDir) || this.options.allowed?.() === false)
      return;
    await tickPatternHolders({
      dataDir,
      ...(this.options.claude === undefined ? {} : { claude: this.options.claude }),
      ...(this.options.call === undefined ? {} : { call: this.options.call }),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
  }

  #schedule(delay: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#running = this.tick()
        .catch((error: unknown) => {
          this.options.log?.(`pattern holders : ${String(error)}`);
        })
        .finally(() => {
          this.#running = undefined;
          this.#schedule(this.options.pollMs ?? 3_000);
        });
    }, delay);
    this.#timer.unref();
  }
}
