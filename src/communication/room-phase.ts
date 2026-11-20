/**
 * Phrase de phase d'une salle (NLR, 18 nov. 2026 16:18–16:26Z). Le holder chef de projet,
 * rattaché à une salle, pose une phrase qui s'ajoute au message de réveil de tous les agents de
 * cette salle. Elle décrit, elle ne commande pas : « Phase de tri : nous regardons quels travaux
 * méritent l'heure. »
 *
 * Le holder n'a pas d'outil fichier : comme pour ```reveil```, il pose la phrase dans sa réponse
 *
 *   ```phase
 *   15 min : Phase de tri : nous regardons quels travaux méritent l'heure
 *   ```
 *
 * (`N min`, `N h`, `N jours`, `N semaines` ou `N réveils`, éventuellement l'échelle déclarée
 * entre parenthèses — `1 j (la journée) : …` —, puis la phrase ; `fin` retire la phrase de son
 * auteur). À l'injection, chaque phrase dit qui l'a posée et, si déclarée, à quelle échelle :
 * « (posée par Narration, la journée) ». Une phrase par auteur et par salle (NLR, 20 nov. 2026) : le chef de
 * projet pose la phase de l'heure, un holder Narration celle de l'arc (jours, semaines) ; une
 * nouvelle phrase ne remplace que celle de son propre auteur. Chacune expire seule, et toutes
 * les phrases actives sont injectées ensemble, la plus ancienne d'abord.
 *
 * C'est le runtime qui ajoute le reste, recalculé à chaque réveil : « — budget restant 6
 * minutes », « — budget restant 3 réveils », « — dernier réveil de la phase ». Un décompte en
 * réveils baisse d'un cran par réveil de la salle (un tour de salle, numéro `n` : tous les agents
 * réveillés dans le même tour voient le même reste).
 *
 * État : `salle-phases.json` dans le dossier de données : par salle, une entrée par auteur.
 * L'ancien format (une seule phrase par salle) est relu comme la phrase de son auteur.
 */
import fs from "node:fs";
import path from "node:path";
import { alarmClock } from "./holder-alarms.js";

export const ROOM_PHASE_FILE = "salle-phases.json";
/**
 * Salle 1 : le fil principal (l'agent principal est l'agent 1, les forks occupent 2 à 8). Les
 * holders du principal y posent leurs phrases ; le daemon les ajoute au réveil du principal.
 */
export const PRINCIPAL_PHASE_ROOM = 1;

/** « 6 », ou « 1 (fil principal) » : la salle telle que la lisent agents et holders. */
function roomLabel(room: number): string {
  return room === PRINCIPAL_PHASE_ROOM ? `${String(room)} (fil principal)` : String(room);
}
const TEXT_MAX_CHARS = 300;
const DAY_MINUTES = 24 * 60;
/** Six semaines : l'arc d'une Narration. */
const MAX_MINUTES = 42 * DAY_MINUTES;
const MAX_WAKES = 200;

export interface RoomPhase {
  readonly text: string;
  /** Holder auteur (nom affiché). */
  readonly author: string;
  /** Échelle déclarée par l'auteur (« l'heure », « la journée », « l'arc »…), facultative. */
  readonly scale?: string;
  /** Date de pose, ISO. */
  readonly setAt: string;
  /** Échéance (phase en minutes), ISO. */
  readonly until?: string;
  /** Nombre de réveils demandés (phase en réveils). */
  readonly wakes?: number;
  /** Réveils restants après le dernier tour compté. */
  wakesLeft?: number;
  /** Dernier tour de salle compté (`n`) : un même tour ne décompte qu'une fois. */
  lastTurn?: number;
}
/** Phrases d'une salle, une par auteur (clé : `authorKey`). */
export type RoomPhases = Record<string, RoomPhase>;
/** Par salle, les phrases de chaque auteur. */
export type RoomPhaseState = Record<string, RoomPhases>;

/** Clé d'auteur : nom du holder, sans casse ni espaces superflus. */
export function authorKey(author: string): string {
  return author.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Blocs ```phase``` d'une réponse (lignes non vides), et le texte restant à publier. */
export function extractPhase(raw: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const text = raw
    .replace(/```phases?[ \t]*\r?\n([\s\S]*?)\r?\n?```/giu, (_m, body: string) => {
      for (const line of body.split(/\r?\n/)) {
        const t = line.replace(/^\s*[-*]\s+/, "").trim();
        if (t !== "") lines.push(t);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, lines };
}

const DURATION =
  /^(?:pour\s+|durant\s+|pendant\s+)?(\d+(?:[.,]\d+)?)\s*(minutes?|min|mn|m|heures?|h|jours?|j|semaines?|sem|r[ée]veils?)(?![\p{L}\p{N}])\s*(?:\(([^()]{1,40})\)\s*)?(?:[:—–-]\s*)?(.*)$/iu;

/** Une ligne de bloc ```phase``` : durée et phrase, `end`, ou une erreur. */
export function parsePhaseLine(
  line: string,
): { text: string; minutes: number; scale?: string } | { text: string; wakes: number; scale?: string } | { end: true } | { error: string } {
  const t = line.trim();
  if (/^(fin|retirer|aucune|annuler)(\s+(de\s+)?(la\s+|ma\s+)?phase)?\.?$/iu.test(t)) return { end: true };
  const m = DURATION.exec(t);
  if (m === null)
    return {
      error: `durée illisible : « ${t.slice(0, 60)} » (attendu : 15 min : …, 1 h : …, 3 jours : …, 2 semaines : … ou 3 réveils : …)`,
    };
  const n = Number((m[1] ?? "").replace(",", "."));
  const unit = (m[2] ?? "").toLowerCase();
  // Échelle déclarée par le holder, facultative : « 1 j (la journée) : … ».
  const scale = (m[3] ?? "").trim();
  const withScale = scale === "" ? {} : { scale };
  const text = (m[4] ?? "").trim().replace(/^[«"]\s*|\s*[»"]$/gu, "").replace(/\s*\.$/u, "").trim();
  if (text === "") return { error: "phrase vide" };
  if (text.length > TEXT_MAX_CHARS) return { error: `phrase de plus de ${String(TEXT_MAX_CHARS)} caractères` };
  if (/^r/u.test(unit)) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_WAKES) return { error: `nombre de réveils invalide (1 à ${String(MAX_WAKES)})` };
    return { text, wakes: n, ...withScale };
  }
  const minutes = /^h/u.test(unit) ? n * 60 : /^j/u.test(unit) ? n * DAY_MINUTES : /^s/u.test(unit) ? n * 7 * DAY_MINUTES : n;
  if (!(minutes >= 1) || minutes > MAX_MINUTES)
    return { error: `durée invalide (1 minute à ${String(MAX_MINUTES / (7 * DAY_MINUTES))} semaines)` };
  return { text, minutes, ...withScale };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Lit l'état ; une salle à l'ancien format (une seule phrase) devient la phrase de son auteur. */
export function readRoomPhases(dataDir: string): RoomPhaseState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dataDir, ROOM_PHASE_FILE), "utf8")) as unknown;
  } catch {
    return {};
  }
  if (!isObject(parsed)) return {};
  const state: RoomPhaseState = {};
  for (const [room, value] of Object.entries(parsed)) {
    if (!isObject(value)) continue;
    if (typeof value["text"] === "string") {
      const phase = value as unknown as RoomPhase;
      state[room] = { [authorKey(typeof phase.author === "string" ? phase.author : "")]: phase };
      continue;
    }
    const phases: RoomPhases = {};
    for (const [key, phase] of Object.entries(value))
      if (isObject(phase) && typeof phase["text"] === "string") phases[key] = phase as unknown as RoomPhase;
    if (Object.keys(phases).length > 0) state[room] = phases;
  }
  return state;
}

function savePhases(dataDir: string, state: RoomPhaseState): void {
  const file = path.join(dataDir, ROOM_PHASE_FILE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Phase échue : minutes passées, ou tous les réveils consommés. */
function expired(phase: RoomPhase, nowMs: number): boolean {
  if (phase.until !== undefined) return Date.parse(phase.until) <= nowMs;
  return (phase.wakesLeft ?? 0) <= 0;
}

/** Ordre d'injection : la plus ancienne d'abord (l'arc avant l'heure, en général), puis l'auteur. */
function byAge(a: RoomPhase, b: RoomPhase): number {
  return a.setAt.localeCompare(b.setAt) || a.author.localeCompare(b.author);
}

/** Phrases actives de la salle (lecture seule), triées. */
export function activePhases(state: RoomPhaseState, room: number, nowMs: number): RoomPhase[] {
  return Object.values(state[String(room)] ?? {})
    .filter((p) => !expired(p, nowMs))
    .sort(byAge);
}

/** Phrase active d'un auteur dans la salle ; sans auteur, la plus récente ; sinon `null`. */
export function activePhase(state: RoomPhaseState, room: number, nowMs: number, author?: string): RoomPhase | null {
  if (author !== undefined) {
    const phase = state[String(room)]?.[authorKey(author)];
    return phase === undefined || expired(phase, nowMs) ? null : phase;
  }
  return activePhases(state, room, nowMs).at(-1) ?? null;
}

export interface PhaseWrite {
  readonly line: string;
  readonly state: "posée" | "remplacée" | "retirée" | "aucune" | "refusée";
  readonly phase?: RoomPhase;
  readonly error?: string;
}

/**
 * Applique les lignes d'un bloc ```phase``` à la salle, dans l'ordre : chaque phrase valide
 * remplace la précédente du même auteur (une seule active par auteur), `fin` retire la sienne.
 * Les phrases des autres auteurs ne sont jamais touchées.
 */
export function setRoomPhase(
  dataDir: string,
  room: number,
  author: string,
  lines: readonly string[],
  nowMs: number,
): PhaseWrite[] {
  if (lines.length === 0) return [];
  const state = readRoomPhases(dataDir);
  const roomKey = String(room);
  const key = authorKey(author);
  const phases: RoomPhases = (state[roomKey] ??= {});
  const out: PhaseWrite[] = [];
  for (const line of lines) {
    const parsed = parsePhaseLine(line);
    if ("error" in parsed) {
      out.push({ line, state: "refusée", error: parsed.error });
      continue;
    }
    const current = phases[key] !== undefined && !expired(phases[key], nowMs) ? phases[key] : undefined;
    if ("end" in parsed) {
      Reflect.deleteProperty(phases, key);
      out.push({ line, state: current === undefined ? "aucune" : "retirée" });
      continue;
    }
    const setAt = new Date(nowMs).toISOString();
    const base = { text: parsed.text, author, setAt, ...(parsed.scale === undefined ? {} : { scale: parsed.scale }) };
    const phase: RoomPhase =
      "minutes" in parsed
        ? { ...base, until: new Date(nowMs + parsed.minutes * 60_000).toISOString() }
        : { ...base, wakes: parsed.wakes, wakesLeft: parsed.wakes };
    phases[key] = phase;
    out.push({ line, state: current === undefined ? "posée" : "remplacée", phase });
  }
  if (Object.keys(phases).length === 0) Reflect.deleteProperty(state, roomKey);
  savePhases(dataDir, state);
  return out;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** Reste en minutes (arrondi au-dessus, au moins 1). */
function minutesLeft(phase: RoomPhase, nowMs: number): number {
  return Math.max(1, Math.ceil((Date.parse(phase.until!) - nowMs) / 60_000));
}

/** Reste lisible d'une phase en minutes : minutes, puis heures, puis jours. */
function durationLeft(phase: RoomPhase, nowMs: number): string {
  const m = minutesLeft(phase, nowMs);
  if (m <= 120) return plural(m, "minute", "minutes");
  if (m <= 2 * DAY_MINUTES) return plural(Math.round(m / 60), "heure", "heures");
  return plural(Math.round(m / DAY_MINUTES), "jour", "jours");
}

/** Le reste ajouté par le runtime : « budget restant 6 minutes », « dernier réveil de la phase »… */
export function phaseRemainder(phase: RoomPhase, nowMs: number, wakesShown?: number): string {
  if (phase.until !== undefined) return `budget restant ${durationLeft(phase, nowMs)}`;
  const left = wakesShown ?? phase.wakesLeft ?? 0;
  return left <= 1 ? "dernier réveil de la phase" : `budget restant ${plural(left, "réveil", "réveils")}`;
}

/** Qui a posé la phrase, et à quelle échelle si l'auteur l'a déclarée : « Narration, la journée ». */
function phaseOrigin(phase: RoomPhase): string {
  return phase.scale === undefined ? phase.author : `${phase.author}, ${phase.scale}`;
}

/** Ligne ajoutée au réveil d'un agent de la salle. */
export function phaseWakeText(room: number, phase: RoomPhase, nowMs: number, wakesShown?: number): string {
  return `Phase de la salle ${roomLabel(room)} (posée par ${phaseOrigin(phase)}) : ${phase.text} — ${phaseRemainder(phase, nowMs, wakesShown)}.`;
}

/**
 * Phrases à ajouter au réveil des agents de la salle pour le tour `turn` (une ligne par phrase
 * active, la plus ancienne d'abord), ou `null`. Retire les phrases échues ; décompte chaque
 * phrase en réveils une seule fois par tour (les agents d'un même tour voient le même reste).
 * Ne lève jamais : un état illisible ne bloque pas un réveil.
 */
export function roomPhaseWakeLine(dataDir: string, room: number, turn: number, nowMs = Date.now()): string | null {
  try {
    const state = readRoomPhases(dataDir);
    const roomKey = String(room);
    const phases = state[roomKey];
    if (phases === undefined) return null;
    let changed = false;
    const shown: { phase: RoomPhase; wakesShown?: number }[] = [];
    for (const [key, phase] of Object.entries(phases)) {
      if (phase.until !== undefined) {
        if (Date.parse(phase.until) > nowMs) shown.push({ phase });
        else {
          Reflect.deleteProperty(phases, key);
          changed = true;
        }
        continue;
      }
      const left = phase.wakesLeft ?? 0;
      // Tour déjà compté (autre agent du même tour) : même reste qu'au premier.
      if (phase.lastTurn === turn) {
        shown.push({ phase, wakesShown: left + 1 });
        continue;
      }
      if (left <= 0) {
        Reflect.deleteProperty(phases, key);
        changed = true;
        continue;
      }
      phase.wakesLeft = left - 1;
      phase.lastTurn = turn;
      changed = true;
      shown.push({ phase, wakesShown: left });
    }
    if (Object.keys(phases).length === 0) Reflect.deleteProperty(state, roomKey);
    if (changed) savePhases(dataDir, state);
    if (shown.length === 0) return null;
    return shown
      .sort((a, b) => byAge(a.phase, b.phase))
      .map((s) => phaseWakeText(room, s.phase, nowMs, s.wakesShown))
      .join("\n");
  } catch {
    return null;
  }
}

/** Ligne publiée dans le fil pour un bloc ```phase``` (le bloc lui-même ne l'est pas). */
export function phasePublicNote(w: PhaseWrite, nowMs: number): string {
  if (w.state === "refusée") return `(phase non posée : ${w.error ?? "refusée"})`;
  if (w.state === "retirée") return "(phase retirée)";
  if (w.state === "aucune") return "(aucune phase active à retirer)";
  const p = w.phase!;
  const end = p.until !== undefined
    ? `jusqu'à ${alarmClock(Date.parse(p.until), nowMs)}`
    : `pour ${plural(p.wakes ?? 0, "réveil", "réveils")} de la salle`;
  return `(phase ${w.state} : ${p.text} ${end})`;
}

function phaseEnd(phase: RoomPhase, nowMs: number): string {
  return phase.until !== undefined
    ? `jusqu'à ${alarmClock(Date.parse(phase.until), nowMs)} (encore ${durationLeft(phase, nowMs)})`
    : `encore ${plural(phase.wakesLeft ?? 0, "réveil", "réveils")} de la salle sur ${String(phase.wakes ?? 0)}`;
}

/** Rappel au gardien des phases d'une salle sans phrase active : en poser une, et sous quelle forme. */
export function phaseKeeperReminder(room: number): string {
  return `Rappel : tu tiens les phases de la salle ${roomLabel(room)}, et elle n'a aucune phrase de phase active (aucune posée, ou toutes échues). Pose-en une dans cette réponse avec un bloc \`\`\`phase\`\`\` d'une ligne : la durée, l'échelle entre parenthèses, puis la phrase — par ex. « 1 j (la journée) : … » ou « 2 semaines (l'arc) : … ».`;
}

/**
 * Rappel au holder, dans sa note de réveil : les phrases actives de sa salle et leurs échéances.
 * Avec `author`, sa propre phrase est distinguée de celles des autres auteurs. Avec `keeper`
 * (holder gardien des phases, champ `phaseKeeper` de son en-tête), une salle sans phrase active
 * — vide ou toutes échues — devient un rappel d'en poser une, avec le format attendu.
 */
export function phaseStatusNote(
  dataDir: string,
  room: number,
  nowMs: number,
  author?: string,
  options: { readonly keeper?: boolean } = {},
): string {
  const phases = activePhases(readRoomPhases(dataDir), room, nowMs);
  const r = roomLabel(room);
  if (phases.length === 0)
    return options.keeper === true ? phaseKeeperReminder(room) : `Aucune phrase de phase active dans la salle ${r}. Tu peux en poser une avec un bloc \`\`\`phase\`\`\`.`;
  const describe = (p: RoomPhase) =>
    `posée par ${phaseOrigin(p)} à ${alarmClock(Date.parse(p.setAt), nowMs)} : « ${p.text} » — ${phaseEnd(p, nowMs)}`;
  const mine = author === undefined ? undefined : phases.find((p) => authorKey(p.author) === authorKey(author));
  const others = phases.filter((p) => p !== mine);
  const parts: string[] = [];
  if (author !== undefined)
    parts.push(
      mine === undefined
        ? `Tu n'as pas de phrase de phase active dans la salle ${r}.`
        : `Ta phrase de phase active dans la salle ${r}, ${describe(mine)}.`,
    );
  if (others.length > 0)
    parts.push(
      `${author === undefined ? "Phrases de phase actives" : "Autres phrases de phase actives"} dans la salle ${r} : ${others.map(describe).join(" ; ")}.`,
    );
  parts.push(
    "Pour remplacer ta phrase, pose-en une autre ; pour la retirer, `fin` dans un bloc ```phase```. Les phrases des autres holders restent.",
  );
  return parts.join(" ");
}

/** Consigne commune aux holders (ajoutée au prompt système, à côté de celle des réveils). */
export const HOLDER_PHASE_NOTE =
  "Tu peux poser une phrase de phase dans ta salle : elle s'ajoute au message de réveil de tous les agents de la salle. Un holder du fil principal pose la sienne dans la salle 1 (le fil principal) : elle s'ajoute aux réveils de l'agent principal. Elle décrit où en est la salle, elle ne commande pas (par ex. « Phase de tri : nous regardons quels travaux méritent l'heure »). Dans ta réponse, un bloc ```phase``` avec une ligne : la durée puis la phrase (une phrase de " + String(TEXT_MAX_CHARS) + " caractères au plus, sinon elle est refusée), « 15 min : … », « 1 h : … », « 3 jours : … », « 2 semaines : … » ou « 3 réveils : … ». Tu peux déclarer l'échelle à laquelle ta phrase joue, entre parenthèses après la durée : « 1 h (l'heure) : … », « 1 j (la journée) : … », « 2 semaines (l'arc) : … » ; les agents la liront avec ton nom. Le runtime ajoute lui-même le reste à chaque réveil (« budget restant 6 minutes », « dernier réveil de la phase ») : ne compte pas à la main. Chaque holder a sa propre phrase dans la salle (par ex. le chef de projet pour l'heure, une Narration pour l'arc des jours et semaines) : toutes sont injectées ensemble ; ta nouvelle phrase remplace la tienne, jamais celle d'un autre holder ; « fin » retire la tienne ; elle expire seule. Le bloc n'est pas publié ; le fil annonce la phase posée et son échéance.";
