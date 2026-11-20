/**
 * Filtre des fins de tour du principal avant leur relais (`principal-outputs.ts`) : ce qui
 * n'est pas enregistré n'entre ni dans le fil lu par les pattern holders (`readFil`), ni dans
 * leurs réveils `wakeOnPrincipalOutput`, ni dans l'historique des coachs.
 *
 * Trois motifs, et seulement ceux-là (NLR, 20 nov. 2026 : « . », « — », « rien de nouveau » et
 * redites du message que l'agent vient de poster lui-même) :
 * - `vide` : moins de 15 lettres après nettoyage (ponctuation, emoji, tiret seul) ;
 * - `remplissage` : message court (< 200 caractères) contenant une formule de remplissage ;
 * - `repetition` : reformulation d'un message posté par l'agent dans le fil depuis moins de
 *   5 minutes. Mesure : part des mots de contenu de la fin de tour présents dans ce message
 *   (≥ 0,55), ou Jaccard des mots de contenu (≥ 0,6). Réglée sur les paires réelles du
 *   20 nov. 13:30–13:50 (rapport `filtre-fin-de-tour/RAPPORT.md` du workspace).
 *
 * Chaque saut est journalisé (journal du daemon) et compté dans `principal-output-filter.json`.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type PrincipalOutputSkipReason = "vide" | "remplissage" | "repetition";
export interface PrincipalOutputSkip { reason: PrincipalOutputSkipReason; detail: string }
export interface OwnPost { at: string; text: string }

export const MIN_LETTERS = 15;
export const FILLER_MAX_CHARS = 200;
export const REPEAT_WINDOW_MS = 5 * 60_000;
export const REPEAT_CONTAINMENT = 0.55;
export const REPEAT_JACCARD = 0.6;
const MIN_CONTENT_WORDS = 4;
const STEM = 7;
export const FILTER_STATUS_FILE = "principal-output-filter.json";
const RECENT_KEPT = 20;

const FILLERS: readonly { label: string; re: RegExp }[] = [
  { label: "rien de nouveau", re: /\brien de (nouveau|neuf)\b/u },
  { label: "rien à ajouter", re: /\brien a (\p{L}+ ni a )?ajouter\b/u },
  { label: "pas de changement", re: /\bpas de changement\b/u },
  { label: "je n'écris plus", re: /\bje n'?ecris plus\b/u },
];

const STOPWORDS = new Set(
  ("les des une un le la de du et en est pas que qui dans pour sur par avec ce cette ces se sa son ses ton ta tes " +
    "mon ma mes je tu il elle on nous vous ils elles au aux ne plus ou mais donc car si deja encore tout tous toute " +
    "toutes sans comme lui leur leurs qu ete etre fait faire avoir avant apres entre ca cela ceci reste aussi bien tres " +
    "meme ai as avait sont sera seront doit peut via the and of to marco principal").split(" "),
);

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’ʼ`]/gu, "'");
}

/** Préfixes de signature (« Marco : », « Principal : @cockpit Marco : ») et mentions retirés. */
function body(text: string): string {
  return text.replace(/^\s*(?:(?:principal|marco)\s*:\s*(?:@[\w-]+\s*)*)+/iu, "").replace(/@[\w-]+/gu, " ");
}

/** Mots de contenu : sans accents ni mots-outils, tronqués à 7 lettres (pluriels, conjugaisons). */
export function contentWords(text: string): Set<string> {
  return new Set(
    fold(body(text))
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map((w) => w.slice(0, STEM)),
  );
}

/** Part des mots de la fin de tour présents dans le message, et Jaccard des deux ensembles. */
export function overlap(output: string, post: string): { containment: number; jaccard: number; words: number } {
  const a = contentWords(output);
  const b = contentWords(post);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return { containment: a.size === 0 ? 0 : shared / a.size, jaccard: union === 0 ? 0 : shared / union, words: a.size };
}

/** Motif de non-relais d'une fin de tour, ou `null` : elle est relayée. */
export function principalOutputSkip(text: string, at: string, ownPosts: readonly OwnPost[]): PrincipalOutputSkip | null {
  const trimmed = text.trim();
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return { reason: "vide", detail: `${String(letters)} lettre(s)` };
  if (trimmed.length < FILLER_MAX_CHARS) {
    const folded = fold(trimmed);
    const filler = FILLERS.find((f) => f.re.test(folded));
    if (filler !== undefined) return { reason: "remplissage", detail: `« ${filler.label} », ${String(trimmed.length)} caractères` };
  }
  if (contentWords(trimmed).size < MIN_CONTENT_WORDS) return null;
  const t = Date.parse(at);
  for (const p of ownPosts) {
    const dt = t - Date.parse(p.at);
    if (!(dt >= 0 && dt <= REPEAT_WINDOW_MS)) continue;
    const o = overlap(trimmed, p.text);
    if (o.containment >= REPEAT_CONTAINMENT || o.jaccard >= REPEAT_JACCARD)
      return {
        reason: "repetition",
        detail: `reprend le message du fil de ${p.at} (contenu repris ${o.containment.toFixed(2)}, Jaccard ${o.jaccard.toFixed(2)})`,
      };
  }
  return null;
}

/**
 * Messages de l'agent dans le fil (owner-messages) dans les 5 minutes qui précèdent `at`.
 * Les interventions des pattern holders (`pattern-holder:…`) ne sont pas les siennes.
 */
export function recentOwnPosts(dataDir: string, at: string): OwnPost[] {
  const file = path.join(dataDir, "owner-messages.sqlite");
  if (!fs.existsSync(file)) return [];
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        "SELECT created_at AS at, text FROM messages WHERE deleted=0 AND created_at >= ? AND created_at <= ? AND request_key NOT LIKE 'pattern-holder:%' ORDER BY created_at DESC LIMIT 50",
      )
      .all(new Date(t - REPEAT_WINDOW_MS).toISOString(), new Date(t).toISOString()) as OwnPost[];
  } finally {
    db.close();
  }
}

export interface FilterStatus {
  skipped: number;
  byReason: Record<PrincipalOutputSkipReason, number>;
  lastAt: string | null;
  recent: { id: string; at: string; reason: PrincipalOutputSkipReason; detail: string; excerpt: string }[];
}

export function readFilterStatus(dataDir: string): FilterStatus {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILTER_STATUS_FILE), "utf8")) as Partial<FilterStatus>;
    return {
      skipped: typeof raw.skipped === "number" ? raw.skipped : 0,
      byReason: { vide: 0, remplissage: 0, repetition: 0, ...(raw.byReason ?? {}) },
      lastAt: typeof raw.lastAt === "string" ? raw.lastAt : null,
      recent: Array.isArray(raw.recent) ? raw.recent.slice(0, RECENT_KEPT) : [],
    };
  } catch {
    return { skipped: 0, byReason: { vide: 0, remplissage: 0, repetition: 0 }, lastAt: null, recent: [] };
  }
}

/** Compte le saut dans le fichier d'état et l'écrit au journal. */
export function noteSkip(
  dataDir: string,
  output: { id: string; at: string; text: string },
  skip: PrincipalOutputSkip,
  log?: (line: string) => void,
): void {
  const excerpt = output.text.trim().replace(/\s+/gu, " ").slice(0, 80);
  log?.(`fin de tour non relayée (${skip.reason}) ${output.id} — ${skip.detail} : « ${excerpt} »`);
  try {
    const status = readFilterStatus(dataDir);
    status.skipped++;
    status.byReason[skip.reason]++;
    status.lastAt = output.at;
    status.recent = [{ id: output.id, at: output.at, reason: skip.reason, detail: skip.detail, excerpt }, ...status.recent].slice(0, RECENT_KEPT);
    const file = path.join(dataDir, FILTER_STATUS_FILE);
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    log?.(`fin de tour non relayée : compteur non écrit — ${String(error)}`);
  }
}
