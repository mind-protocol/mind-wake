/**
 * Holders cadencés (NLR, 18 nov. 2026 15:59–16:02Z : « le manager du budget », un pattern holder
 * qui vit sur une temporalité plus longue, réveillé tous les X réveils ou toutes les X minutes).
 *
 * Déclaration dans l'en-tête ```json pattern-holder``` :
 *   "cadence": { "everyWakes": 5 }        réveillé tous les 5 tours de la salle (ou du principal)
 *   "cadence": { "everyMinutes": 30 }     réveillé toutes les 30 minutes
 *   les deux ensemble : le premier seuil atteint réveille, et remet les deux compteurs à zéro
 *   "room": 6                             rattaché à la salle 6 : compteur et fil de la salle
 * 0 ou absent = désactivé. Aucun plancher, aucun quota.
 *
 * Pas de registre (NLR, 18 nov. 2026 16:13Z : « pas de registre, c'est des holders qui sont des
 * agents ») : le plan du holder vit dans ses propres sections, relues depuis le disque à chaque
 * réveil et qu'il réécrit par des blocs ```section```.
 *
 * Réveil cadencé = revue avec appel (NLR 16:15Z : « tu dois m'appeler, faire un call à chaque
 * 30 minutes ») : le holder appelle NLR avec `call_human`, ou se joint à l'appel en cours avec
 * `invite_to_call` ; le runtime vérifie ensuite que l'appel est parti (`checkReviewCall`).
 *
 * Réveils programmés (NLR 16:14Z : « tu es le manager du temps, … te mettre des réveils pour
 * sous-découper ») : bloc ```reveil``` dans une réponse, une ligne par réveil (`holder-alarms.ts`).
 *
 * État : `pattern-holders-cadence.json` dans le dossier de données, une entrée par holder. Le
 * premier passage pose la référence sans réveiller ; un réveil remet la référence au présent
 * avant l'appel (pas de double réveil, pas de rafale de rattrapage après une longue pause).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FORK_IDS, forkDir, forkEnabled } from "../daemon/forks.js";
import { CONTROL_DB_FILE } from "../daemon/paths.js";
import { SecondThreadStore, SECOND_THREAD_DB } from "../daemon/second-thread.js";

export const HOLDER_CADENCE_STATE = "pattern-holders-cadence.json";

export interface HolderCadence {
  /** Tours de la salle (ou réveils du principal) entre deux réveils cadencés ; 0 = désactivé. */
  readonly everyWakes: number;
  /** Minutes entre deux réveils cadencés ; 0 = désactivé. */
  readonly everyMinutes: number;
}

/** Lit `cadence` et `room` d'un en-tête de holder. `undefined` : pas de cadence. */
export function parseCadence(
  cadence: unknown,
  room: unknown,
): { cadence?: HolderCadence; room?: number } | { error: string } {
  let parsedRoom: number | undefined;
  if (room !== undefined && room !== null) {
    if (typeof room !== "number" || (room !== 1 && !FORK_IDS.includes(room as (typeof FORK_IDS)[number])))
      return { error: `\`room\` invalide : ${JSON.stringify(room)} (salle 1, ${FORK_IDS.join(", ")})` };
    parsedRoom = room;
  }
  if (cadence === undefined || cadence === null) return parsedRoom === undefined ? {} : { room: parsedRoom };
  if (typeof cadence !== "object" || Array.isArray(cadence))
    return { error: "`cadence` : objet attendu, par ex. {\"everyWakes\":5} ou {\"everyMinutes\":30}" };
  const c = cadence as Record<string, unknown>;
  const unknownKey = Object.keys(c).find((k) => k !== "everyWakes" && k !== "everyMinutes");
  if (unknownKey !== undefined) return { error: `\`cadence\` : clé inconnue ${unknownKey}` };
  const read = (key: string): number | { error: string } => {
    const v = c[key];
    if (v === undefined || v === null) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      return { error: `\`cadence.${key}\` : nombre positif ou 0 attendu` };
    return v;
  };
  const everyWakes = read("everyWakes");
  if (typeof everyWakes !== "number") return everyWakes;
  const everyMinutes = read("everyMinutes");
  if (typeof everyMinutes !== "number") return everyMinutes;
  const enabled = everyWakes > 0 || everyMinutes > 0;
  return {
    ...(enabled ? { cadence: { everyWakes: Math.floor(everyWakes), everyMinutes } } : {}),
    ...(parsedRoom === undefined ? {} : { room: parsedRoom }),
  };
}

/** Fil d'un holder cadencé : sa salle, ou le principal. */
export function cadenceThread(room: number | undefined): "principal" | `fork:${number}` {
  return room === undefined || room === 1 ? "principal" : (`fork:${String(room)}` as `fork:${number}`);
}

/** La salle est-elle active ? (Sans salle : toujours.) */
export function cadenceRoomActive(dataDir: string, room: number | undefined): boolean {
  return room === undefined || room === 1 || forkEnabled(dataDir, room);
}

/**
 * Compteur de réveils : tours de la salle (table `turns` de son fil), ou réveils du principal
 * (`wake_prompts` de la base de contrôle). `null` : illisible, la cadence en réveils attend.
 */
export function wakeCounter(dataDir: string, room: number | undefined): number | null {
  try {
    if (room !== undefined && room !== 1) {
      const dir = forkDir(dataDir, room);
      if (!fs.existsSync(path.join(dir, SECOND_THREAD_DB))) return 0;
      const store = new SecondThreadStore(dir, { readOnly: true });
      try {
        return store.lastTurn()?.n ?? 0;
      } finally {
        store.close();
      }
    }
    const file = path.join(dataDir, CONTROL_DB_FILE);
    if (!fs.existsSync(file)) return null;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM wake_prompts").get() as { n: number }).n;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- état et échéance

export interface CadenceEntry {
  /** Fil visé lors de la référence ; un changement de salle repose la référence. */
  thread: string;
  /** Dernier réveil cadencé (ou première référence), ISO. */
  lastAt: string;
  /** Compteur de réveils à ce moment (`null` : illisible). */
  lastWakes: number | null;
  /** Vrai une fois le holder réellement réveillé au moins une fois. */
  woke?: boolean;
  lastResult?: { at: string; state: string; call?: "joined" | "rang" | "missing"; detail?: string };
}
export type CadenceState = Record<string, CadenceEntry>;

export function readCadenceState(dataDir: string): CadenceState {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, HOLDER_CADENCE_STATE), "utf8")) as CadenceState;
  } catch {
    return {};
  }
}

export function saveCadenceState(dataDir: string, state: CadenceState): void {
  const file = path.join(dataDir, HOLDER_CADENCE_STATE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export interface CadenceDue {
  /** Réveils écoulés depuis le dernier passage (`null` : compteur illisible). */
  readonly wakes: number | null;
  readonly minutes: number;
  readonly by: "wakes" | "minutes";
}

/**
 * Échéance d'un holder cadencé. Rend `null` si rien n'est dû. Un compteur qui recule (fil de la
 * salle recréé) ne réveille pas : l'appelant repose la référence.
 */
export function cadenceDue(
  cadence: HolderCadence,
  entry: CadenceEntry,
  wakes: number | null,
  nowMs: number,
): CadenceDue | null {
  const elapsedWakes = wakes !== null && entry.lastWakes !== null ? wakes - entry.lastWakes : null;
  const minutes = (nowMs - Date.parse(entry.lastAt)) / 60_000;
  if (cadence.everyWakes > 0 && elapsedWakes !== null && elapsedWakes >= cadence.everyWakes)
    return { wakes: elapsedWakes, minutes, by: "wakes" };
  if (cadence.everyMinutes > 0 && minutes >= cadence.everyMinutes)
    return { wakes: elapsedWakes, minutes, by: "minutes" };
  return null;
}

// ---------------------------------------------------------------- appel de revue

/**
 * Situation d'appel au moment d'un réveil cadencé, lue dans `mobile-call-control.sqlite` (tenu
 * par le serveur de l'app) : aucun appel actif, un appel où le holder (ou sa salle) est déjà, ou
 * un appel en cours sans lui. Lecture seule ; base absente ou illisible : `none`.
 */
export type CallSituation =
  | { readonly state: "none" }
  | { readonly state: "joined"; readonly callId: string }
  | { readonly state: "other"; readonly callId: string };

/** Même fenêtre que le magasin de l'app (`idleMs` de openCallControls). */
const CALL_IDLE_MS = 120_000;

/** Identifiants sous lesquels un holder figure dans un appel : son slug, son handle d'appelant, sa salle. */
export function holderCallKeys(slug: string, callerHandle: string | null, room: number | undefined): string[] {
  return [
    slug,
    ...(callerHandle === null ? [] : [callerHandle]),
    ...(room === undefined ? [] : [`room${String(room)}`, `room-${String(room)}`]),
  ].map((k) => k.toLowerCase());
}

export function callSituation(dataDir: string, keys: readonly string[], nowMs = Date.now()): CallSituation {
  const file = path.join(dataDir, "mobile-call-control.sqlite");
  if (!fs.existsSync(file)) return { state: "none" };
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const rows = db
      .prepare("SELECT id, participants FROM call_control_sessions WHERE state='active' AND last_seen>? ORDER BY last_seen DESC")
      .all(nowMs - CALL_IDLE_MS) as { id: string; participants: string }[];
    let other: string | null = null;
    for (const row of rows) {
      let participants: unknown;
      try { participants = JSON.parse(row.participants); } catch { continue; }
      if (Array.isArray(participants) && participants.some((p) => typeof p === "string" && wanted.has(p.toLowerCase())))
        return { state: "joined", callId: row.id };
      other ??= row.id;
    }
    return other === null ? { state: "none" } : { state: "other", callId: other };
  } catch {
    return { state: "none" };
  } finally {
    db?.close();
  }
}

/**
 * Après le réveil : l'appel de revue est-il parti ? `joined` : le holder est (ou était déjà) dans
 * un appel actif ; `rang` : une sonnerie a été mise en file par lui (`invitations` de
 * `mobile-calls.sqlite`, appelant = son handle) depuis `sinceMs` ; sinon `missing`.
 */
export function checkReviewCall(
  dataDir: string,
  keys: readonly string[],
  callerHandle: string | null,
  sinceMs: number,
  nowMs = Date.now(),
): "joined" | "rang" | "missing" {
  if (callSituation(dataDir, keys, nowMs).state === "joined") return "joined";
  const file = path.join(dataDir, "mobile-calls.sqlite");
  if (callerHandle === null || !fs.existsSync(file)) return "missing";
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    // Une invitation dure 45 s : `until` = heure de mise en file + 45 s.
    const row = db
      .prepare("SELECT 1 FROM invitations WHERE caller=? AND until>=?")
      .get(callerHandle, sinceMs + 45_000 - 1_000);
    return row === undefined ? "missing" : "rang";
  } catch {
    return "missing";
  } finally {
    db?.close();
  }
}

/** Consigne d'appel remise au holder à un réveil cadencé. */
export function reviewCallNote(slug: string, situation: CallSituation): string {
  if (situation.state === "joined")
    return "Tu es déjà dans l'appel en cours avec NLR : ne fais pas sonner, ta réponse y sera lue.";
  if (situation.state === "other")
    return `Un appel est en cours avec NLR : ne fais pas sonner. Avant d'écrire ta réponse, joins-toi à l'appel avec l'outil invite_to_call (target "${slug}", reason "revue de la demi-heure") : ta réponse y sera lue.`;
  return "Avant d'écrire ta réponse, appelle NLR avec l'outil call_human (sans handle), une seule fois : « en file » ne veut pas dire qu'il a décroché, ne refais pas sonner. Ta revue part dans le fil de la salle ; s'il décroche, redis-la de vive voix.";
}

/** Texte remis au holder à un réveil cadencé et/ou programmé (avant le fil de la salle). */
export function cadenceWakeNote(options: {
  /** Cadence échue : revue avec appel. Absent : réveil programmé seulement. */
  cadence?: { cadence: HolderCadence; due: CadenceDue; first: boolean; call: string };
  room: number | undefined;
  /** Réveils programmés échus (`holder-alarms.ts`), déjà mis en forme. */
  alarms?: readonly string[];
}): string {
  const { room } = options;
  const where = room === undefined ? "le fil principal" : `la salle ${String(room)}`;
  const lines: string[] = [];
  if (options.cadence !== undefined) {
    const { cadence, due, first, call } = options.cadence;
    const rhythm = [
      cadence.everyWakes > 0 ? `tous les ${String(cadence.everyWakes)} réveils` : "",
      cadence.everyMinutes > 0 ? `toutes les ${String(cadence.everyMinutes)} minutes` : "",
    ].filter((s) => s !== "").join(" ou ");
    const since = first ? "depuis la mise en place de ta cadence" : "depuis ton dernier passage cadencé";
    lines.push(
      `Réveil cadencé (${rhythm}) : personne ne t'a appelé, c'est ton rythme. Tu interviens dans ${where}.`,
      `${due.wakes === null ? "Nombre de réveils illisible" : `${String(due.wakes)} réveil(s)`} et ${String(Math.round(due.minutes))} minute(s) ${since}.`,
      "C'est la revue avec NLR : ce qui a été envoyé, l'écart avec le partage du temps prévu dans tes sections, ce que la salle a décidé de changer. Si rien n'a bougé, dis-le et dis ce qui bloque : c'est court, mais ce n'est pas un SILENCE.",
      call,
    );
  } else {
    lines.push(`Réveil que tu t'es programmé. Tu interviens dans ${where}.`);
  }
  if (options.alarms !== undefined && options.alarms.length > 0)
    lines.push("Tes notes de réveil (écrites par toi plus tôt) :", ...options.alarms.map((a) => `- ${a}`));
  lines.push(
    "Pas de registre : ton plan est dans tes sections. Pour le noter ou le corriger, réécris la section avec un bloc ```section```. Pour découper la suite, programme-toi des réveils avec un bloc ```reveil```. Pour dire à la salle où elle en est, pose une phrase de phase avec un bloc ```phase``` (elle s'ajoute au réveil de tous ses agents).",
    "Tu proposes, la salle tranche. Ta réponse (ta proposition de découpage) part dans le fil de la salle, remise à tous ses agents ; mentionne NLR explicitement seulement si elle doit aussi lui parvenir dans le fil principal.",
  );
  if (options.cadence === undefined) lines.push("Si rien ne mérite d'être dit, réponds SILENCE.");
  return lines.join("\n");
}
