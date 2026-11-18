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
 * (`N min`, `N h` ou `N réveils`, puis la phrase ; `fin` retire la phrase active). Une seule
 * phrase par salle : une nouvelle remplace l'ancienne, jamais d'empilement. Elle expire seule.
 *
 * C'est le runtime qui ajoute le reste, recalculé à chaque réveil : « — budget restant 6
 * minutes », « — budget restant 3 réveils », « — dernier réveil de la phase ». Un décompte en
 * réveils baisse d'un cran par réveil de la salle (un tour de salle, numéro `n` : tous les agents
 * réveillés dans le même tour voient le même reste).
 *
 * État : `salle-phases.json` dans le dossier de données, une entrée par salle.
 */
import fs from "node:fs";
import path from "node:path";
import { alarmClock } from "./holder-alarms.js";

export const ROOM_PHASE_FILE = "salle-phases.json";
const TEXT_MAX_CHARS = 300;
const MAX_MINUTES = 24 * 60;
const MAX_WAKES = 200;

export interface RoomPhase {
  readonly text: string;
  /** Holder auteur (nom affiché). */
  readonly author: string;
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
export type RoomPhaseState = Record<string, RoomPhase>;

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

const DURATION = /^(?:pour\s+|durant\s+|pendant\s+)?(\d+(?:[.,]\d+)?)\s*(minutes?|min|mn|m|heures?|h|r[ée]veils?)(?![\p{L}\p{N}])\s*(?:[:—–-]\s*)?(.*)$/iu;

/** Une ligne de bloc ```phase``` : durée et phrase, `end`, ou une erreur. */
export function parsePhaseLine(
  line: string,
): { text: string; minutes: number } | { text: string; wakes: number } | { end: true } | { error: string } {
  const t = line.trim();
  if (/^(fin|retirer|aucune|annuler)(\s+(de\s+)?(la\s+)?phase)?\.?$/iu.test(t)) return { end: true };
  const m = DURATION.exec(t);
  if (m === null) return { error: `durée illisible : « ${t.slice(0, 60)} » (attendu : 15 min : …, 1 h : … ou 3 réveils : …)` };
  const n = Number(m[1]!.replace(",", "."));
  const unit = m[2]!.toLowerCase();
  const text = (m[3] ?? "").trim().replace(/^[«"]\s*|\s*[»"]$/gu, "").replace(/\s*\.$/u, "").trim();
  if (text === "") return { error: "phrase vide" };
  if (text.length > TEXT_MAX_CHARS) return { error: `phrase de plus de ${String(TEXT_MAX_CHARS)} caractères` };
  if (/^r/u.test(unit)) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_WAKES) return { error: `nombre de réveils invalide (1 à ${String(MAX_WAKES)})` };
    return { text, wakes: n };
  }
  const minutes = /^h/u.test(unit) ? n * 60 : n;
  if (!(minutes >= 1) || minutes > MAX_MINUTES) return { error: `durée invalide (1 minute à ${String(MAX_MINUTES / 60)} h)` };
  return { text, minutes };
}

export function readRoomPhases(dataDir: string): RoomPhaseState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, ROOM_PHASE_FILE), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RoomPhaseState) : {};
  } catch {
    return {};
  }
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

/** Phrase active de la salle (lecture seule), ou `null`. */
export function activePhase(state: RoomPhaseState, room: number, nowMs: number): RoomPhase | null {
  const phase = state[String(room)];
  return phase === undefined || expired(phase, nowMs) ? null : phase;
}

export interface PhaseWrite {
  readonly line: string;
  readonly state: "posée" | "remplacée" | "retirée" | "aucune" | "refusée";
  readonly phase?: RoomPhase;
  readonly error?: string;
}

/**
 * Applique les lignes d'un bloc ```phase``` à la salle, dans l'ordre : chaque phrase valide
 * remplace la précédente (une seule active), `fin` la retire.
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
  const key = String(room);
  const out: PhaseWrite[] = [];
  for (const line of lines) {
    const parsed = parsePhaseLine(line);
    if ("error" in parsed) {
      out.push({ line, state: "refusée", error: parsed.error });
      continue;
    }
    const current = state[key] !== undefined && !expired(state[key], nowMs) ? state[key] : undefined;
    if ("end" in parsed) {
      delete state[key];
      out.push({ line, state: current === undefined ? "aucune" : "retirée" });
      continue;
    }
    const setAt = new Date(nowMs).toISOString();
    const phase: RoomPhase =
      "minutes" in parsed
        ? { text: parsed.text, author, setAt, until: new Date(nowMs + parsed.minutes * 60_000).toISOString() }
        : { text: parsed.text, author, setAt, wakes: parsed.wakes, wakesLeft: parsed.wakes };
    state[key] = phase;
    out.push({ line, state: current === undefined ? "posée" : "remplacée", phase });
  }
  savePhases(dataDir, state);
  return out;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** Reste en minutes (arrondi au-dessus, au moins 1). */
function minutesLeft(phase: RoomPhase, nowMs: number): number {
  return Math.max(1, Math.ceil((Date.parse(phase.until!) - nowMs) / 60_000));
}

/** Le reste ajouté par le runtime : « budget restant 6 minutes », « dernier réveil de la phase »… */
export function phaseRemainder(phase: RoomPhase, nowMs: number, wakesShown?: number): string {
  if (phase.until !== undefined) return `budget restant ${plural(minutesLeft(phase, nowMs), "minute", "minutes")}`;
  const left = wakesShown ?? phase.wakesLeft ?? 0;
  return left <= 1 ? "dernier réveil de la phase" : `budget restant ${plural(left, "réveil", "réveils")}`;
}

/** Ligne ajoutée au réveil d'un agent de la salle. */
export function phaseWakeText(room: number, phase: RoomPhase, nowMs: number, wakesShown?: number): string {
  return `Phase de la salle ${String(room)} (posée par ${phase.author}) : ${phase.text} — ${phaseRemainder(phase, nowMs, wakesShown)}.`;
}

/**
 * Phrase à ajouter au réveil des agents de la salle pour le tour `turn`, ou `null`. Retire une
 * phrase échue ; décompte une phrase en réveils une seule fois par tour (les agents d'un même
 * tour voient le même reste). Ne lève jamais : un état illisible ne bloque pas un réveil.
 */
export function roomPhaseWakeLine(dataDir: string, room: number, turn: number, nowMs = Date.now()): string | null {
  try {
    const state = readRoomPhases(dataDir);
    const key = String(room);
    const phase = state[key];
    if (phase === undefined) return null;
    if (phase.until !== undefined) {
      if (Date.parse(phase.until) > nowMs) return phaseWakeText(room, phase, nowMs);
      delete state[key];
      savePhases(dataDir, state);
      return null;
    }
    const left = phase.wakesLeft ?? 0;
    // Tour déjà compté (autre agent du même tour) : même reste qu'au premier.
    if (phase.lastTurn === turn) return phaseWakeText(room, phase, nowMs, left + 1);
    if (left <= 0) {
      delete state[key];
      savePhases(dataDir, state);
      return null;
    }
    phase.wakesLeft = left - 1;
    phase.lastTurn = turn;
    savePhases(dataDir, state);
    return phaseWakeText(room, phase, nowMs, left);
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

/** Rappel au holder, dans sa note de réveil : phrase active de sa salle et quand elle finit. */
export function phaseStatusNote(dataDir: string, room: number, nowMs: number): string {
  const phase = activePhase(readRoomPhases(dataDir), room, nowMs);
  if (phase === null)
    return `Aucune phrase de phase active dans la salle ${String(room)}. Tu peux en poser une avec un bloc \`\`\`phase\`\`\`.`;
  const since = alarmClock(Date.parse(phase.setAt), nowMs);
  const end = phase.until !== undefined
    ? `jusqu'à ${alarmClock(Date.parse(phase.until), nowMs)} (encore ${plural(minutesLeft(phase, nowMs), "minute", "minutes")})`
    : `encore ${plural(phase.wakesLeft ?? 0, "réveil", "réveils")} de la salle sur ${String(phase.wakes ?? 0)}`;
  return `Phrase de phase active dans la salle ${String(room)}, posée par ${phase.author} à ${since} : « ${phase.text} » — ${end}. Pour la remplacer, pose-en une autre ; pour la retirer, \`fin\` dans un bloc \`\`\`phase\`\`\`.`;
}

/** Consigne commune aux holders (ajoutée au prompt système, à côté de celle des réveils). */
export const HOLDER_PHASE_NOTE =
  "Si tu es rattaché à une salle, tu peux poser une phrase de phase : elle s'ajoute au message de réveil de tous les agents de la salle. Elle décrit où en est la salle, elle ne commande pas (par ex. « Phase de tri : nous regardons quels travaux méritent l'heure »). Dans ta réponse, un bloc ```phase``` avec une ligne : la durée puis la phrase, « 15 min : … », « 1 h : … » ou « 3 réveils : … ». Le runtime ajoute lui-même le reste à chaque réveil (« budget restant 6 minutes », « dernier réveil de la phase ») : ne compte pas à la main. Une seule phrase par salle : une nouvelle remplace l'ancienne ; « fin » la retire ; elle expire seule. Le bloc n'est pas publié ; le fil annonce la phase posée et son échéance.";
