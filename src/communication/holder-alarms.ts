/**
 * Réveils programmés par un holder lui-même (NLR, 18 nov. 2026 16:14Z : « tu es le manager du
 * temps, donc ce que tu peux faire, c'est te mettre des réveils pour sous-découper tes
 * différentes parties »).
 *
 * Le holder n'a pas d'outil fichier : il programme un réveil dans sa réponse, avec un bloc
 *
 *   ```reveil
 *   dans 10 min : fin de l'idéation de l'offre 2, passer à la rédaction
 *   à 16:45 : envoyer les trois offres
 *   ```
 *
 * une ligne par réveil. Heure : `dans N min` / `dans N h` / `+N` (minutes), `à 16:45` / `16h45`
 * (heure locale de la machine, prochaine occurrence), ou une date ISO. Puis une note courte (au
 * plus 300 caractères) qui lui est remise au réveil. `annuler` vide ses réveils en attente.
 *
 * Règles (les mêmes que la cadence) : la salle rattachée doit être active ; un même réveil (même
 * minute, même note) n'est enregistré qu'une fois ; un réveil est retiré du fichier avant l'appel
 * (jamais deux fois) ; plusieurs réveils échus ensemble, ou rattrapés après une pause, donnent un
 * seul réveil qui reçoit toutes les notes. Ni quota ni plancher.
 *
 * État : `pattern-holders-reveils.json` dans le dossier de données, une liste par holder.
 */
import fs from "node:fs";
import path from "node:path";

export const HOLDER_ALARMS_FILE = "pattern-holders-reveils.json";
const NOTE_MAX_CHARS = 300;

export interface HolderAlarm {
  /** Échéance, ISO. */
  readonly at: string;
  readonly note: string;
  /** Date de programmation, ISO. */
  readonly setAt: string;
}
export type AlarmState = Record<string, HolderAlarm[]>;

/** Blocs ```reveil``` d'une réponse (lignes non vides), et le texte restant à publier. */
export function extractAlarms(raw: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const text = raw
    .replace(/```r[ée]veils?[ \t]*\r?\n([\s\S]*?)\r?\n?```/giu, (_m, body: string) => {
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

const SEP = String.raw`\s*(?:[:—–-]\s*)?`;
const ISO = new RegExp(String.raw`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)${SEP}(.*)$`, "iu");
const RELATIVE = new RegExp(String.raw`^(?:\+\s*|dans\s+)(\d+(?:[.,]\d+)?)\s*(minutes?|min|mn|m|heures?|h)?(?![\p{L}\p{N}])${SEP}(.*)$`, "iu");
const CLOCK = new RegExp(String.raw`^(?:[àa]\s+)?(\d{1,2})\s*(?::|h)\s*(\d{2})?(?![\p{N}])${SEP}(.*)$`, "iu");

/** Une ligne de bloc ```reveil``` : échéance (ms) et note, `cancel`, ou une erreur. */
export function parseAlarmLine(
  line: string,
  nowMs: number,
): { at: number; note: string } | { cancel: true } | { error: string } {
  const t = line.trim();
  if (/^annuler( tout| tous| mes r[ée]veils)?\.?$/iu.test(t)) return { cancel: true };
  let at: number | undefined;
  let note = "";
  let m = ISO.exec(t);
  if (m !== null) {
    at = Date.parse(m[1]!);
    note = m[2] ?? "";
  } else if ((m = RELATIVE.exec(t)) !== null) {
    const n = Number(m[1]!.replace(",", "."));
    const hours = /^h/i.test(m[2] ?? "");
    at = nowMs + n * (hours ? 3_600_000 : 60_000);
    note = m[3] ?? "";
  } else if ((m = CLOCK.exec(t)) !== null) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? "0");
    if (h > 23 || min > 59) return { error: `heure invalide : ${t}` };
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    at = d.getTime();
    note = m[3] ?? "";
  }
  if (at === undefined || !Number.isFinite(at))
    return { error: `heure illisible : « ${t.slice(0, 60)} » (attendu : dans 10 min, à 16:45, ou une date ISO)` };
  note = note.trim();
  if (note.length > NOTE_MAX_CHARS) return { error: `note de plus de ${String(NOTE_MAX_CHARS)} caractères` };
  return { at, note };
}

export function readAlarms(dataDir: string): AlarmState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, HOLDER_ALARMS_FILE), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AlarmState) : {};
  } catch {
    return {};
  }
}

function saveAlarms(dataDir: string, state: AlarmState): void {
  for (const slug of Object.keys(state)) if (state[slug]!.length === 0) delete state[slug];
  const file = path.join(dataDir, HOLDER_ALARMS_FILE);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Heure locale courte (« 16:45 », ou « 19/11 08:00 » si ce n'est pas aujourd'hui). */
export function alarmClock(atMs: number, nowMs: number): string {
  const d = new Date(atMs);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(nowMs).toDateString() === d.toDateString()
    ? hm
    : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

export interface AlarmWrite {
  readonly line: string;
  readonly state: "programmé" | "doublon" | "annulés" | "refusé";
  readonly at?: string;
  readonly note?: string;
  readonly error?: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Enregistre les lignes d'un bloc ```reveil``` pour ce holder. */
export function addAlarms(dataDir: string, slug: string, lines: readonly string[], nowMs: number): AlarmWrite[] {
  if (lines.length === 0) return [];
  const state = readAlarms(dataDir);
  const own = [...(state[slug] ?? [])];
  const out: AlarmWrite[] = [];
  for (const line of lines) {
    const parsed = parseAlarmLine(line, nowMs);
    if ("error" in parsed) {
      out.push({ line, state: "refusé", error: parsed.error });
      continue;
    }
    if ("cancel" in parsed) {
      own.length = 0;
      out.push({ line, state: "annulés" });
      continue;
    }
    const at = new Date(parsed.at).toISOString();
    const minute = Math.floor(parsed.at / 60_000);
    if (own.some((a) => Math.floor(Date.parse(a.at) / 60_000) === minute && fold(a.note) === fold(parsed.note))) {
      out.push({ line, state: "doublon", at, note: parsed.note });
      continue;
    }
    own.push({ at, note: parsed.note, setAt: new Date(nowMs).toISOString() });
    out.push({ line, state: "programmé", at, note: parsed.note });
  }
  own.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  state[slug] = own;
  saveAlarms(dataDir, state);
  return out;
}

/** Réveils échus de ce holder, sans les retirer. */
export function dueAlarms(state: AlarmState, slug: string, nowMs: number): HolderAlarm[] {
  return (state[slug] ?? []).filter((a) => Date.parse(a.at) <= nowMs);
}

/** Retire (relu depuis le disque) les réveils échus donnés : appelé avant le réveil, jamais deux fois. */
export function takeAlarms(dataDir: string, slug: string, taken: readonly HolderAlarm[]): void {
  const state = readAlarms(dataDir);
  const keys = new Set(taken.map((a) => `${a.at}|${a.note}|${a.setAt}`));
  state[slug] = (state[slug] ?? []).filter((a) => !keys.has(`${a.at}|${a.note}|${a.setAt}`));
  saveAlarms(dataDir, state);
}

/** Oublie les réveils des holders qui n'existent plus. */
export function pruneAlarms(dataDir: string, slugs: readonly string[]): void {
  const state = readAlarms(dataDir);
  const gone = Object.keys(state).filter((s) => !slugs.includes(s));
  if (gone.length === 0) return;
  for (const s of gone) delete state[s];
  saveAlarms(dataDir, state);
}

/** Ligne remise au holder pour un réveil échu. */
export function alarmWakeLine(alarm: HolderAlarm, nowMs: number): string {
  const at = Date.parse(alarm.at);
  const late = Math.round((nowMs - at) / 60_000);
  return `prévu à ${alarmClock(at, nowMs)}${late >= 2 ? ` (en retard de ${String(late)} min)` : ""} : ${alarm.note === "" ? "(sans note)" : alarm.note}`;
}

/** Ligne publiée dans le fil pour un réveil programmé ou refusé. */
export function alarmPublicNote(w: AlarmWrite, nowMs: number): string {
  if (w.state === "refusé") return `(réveil non programmé : ${w.error ?? "refusé"})`;
  if (w.state === "annulés") return "(réveils en attente annulés)";
  const clock = alarmClock(Date.parse(w.at!), nowMs);
  return `(réveil ${w.state === "doublon" ? "déjà programmé" : "programmé"} à ${clock}${w.note ? ` : ${w.note}` : ""})`;
}

/** Consigne commune aux holders (ajoutée au prompt système, indépendante de `_role-commun.md`). */
export const HOLDER_ALARM_NOTE =
  "Tu peux te programmer des réveils pour découper ton temps : dans ta réponse, un bloc ```reveil``` avec une ligne par réveil, l'heure puis une note courte pour toi-même (par ex. « dans 10 min : passer de l'idéation à la rédaction de l'offre 2 » ou « à 16:45 : envoyer les offres »). La note te sera remise au réveil, dans le fil de ta salle si elle est active. « annuler » vide tes réveils en attente. Le bloc n'est pas publié ; le runtime annonce le réveil programmé.";
