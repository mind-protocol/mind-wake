/**
 * Vocabulaire personnalisé de transcription vocale (mandat NLR du 18 nov. 2026 : « il ne connaît
 * pas Codex ou ChatGPT »). Un seul fichier par profil : `<dataDir>/stt-vocabulary.json`,
 * éditable dans Réglages (une ligne par mot) ou à la main.
 *
 *   { "version": 1, "terms": ["Codex", …], "elevenlabsKeyterms": false }
 *
 * - `terms` : biais natif du fournisseur. faster-whisper → `hotwords` (gratuit, local) ;
 *   ElevenLabs Scribe → `keyterms`, seulement si `elevenlabsKeyterms` est vrai (+20 % facturés
 *   par ElevenLabs, donc choix explicite).
 * - Aucune réécriture du texte transcrit (invariant déjà posé pour la dictée et ElevenLabs) :
 *   le biais rend un mot plus probable, il ne décide rien ; un mot douteux se fait confirmer.
 *
 * Fichier absent → liste initiale ci-dessous. Fichier illisible → liste initiale aussi (la
 * transcription ne doit jamais tomber à cause du vocabulaire) ; `error` le signale.
 */
import fs from "node:fs";
import path from "node:path";

export const STT_VOCABULARY_FILE = "stt-vocabulary.json";
const LEGACY_FILE = "desktop-transcription-vocabulary.json";

export const DEFAULT_TERMS = Object.freeze([
  "Codex", "ChatGPT", "Claude", "MIND", "MIND Wake", "Marco", "VOX", "Médicis", "Cosimo", "Bassel",
  "FluxBeam", "BNKR", "Lumina", "Colony", "Telegram", "pattern holder", "Room", "Aurore", "Équerre", "Compas",
]);

const MAX_TERMS = 100; // Au-delà, ElevenLabs facture 20 s minimum par requête.
const MAX_TERM = 50;
const FORBIDDEN = /[<>{}[\]\\\r\n\x00]/;

/** Liste initiale (copie modifiable). */
export function defaultSttVocabulary() {
  return { terms: [...DEFAULT_TERMS], elevenlabsKeyterms: false };
}

function cleanTerm(value, what) {
  if (typeof value !== "string") throw Error(`${what} : texte attendu.`);
  const term = value.trim().replace(/\s+/g, " ");
  if (!term) throw Error(`${what} : vide.`);
  if (term.length > MAX_TERM) throw Error(`${what} « ${term.slice(0, 20)}… » : ${MAX_TERM} caractères au plus.`);
  if (FORBIDDEN.test(term)) throw Error(`${what} « ${term} » : caractères < > { } [ ] \\ interdits.`);
  return term;
}

/** Valide et normalise un objet vocabulaire ; lève une erreur lisible en français. */
export function normalizeSttVocabulary(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.terms))
    throw Error("Vocabulaire de transcription invalide (version 1 et terms attendus).");
  const seen = new Set(); // Doublons insensibles à la casse : la première graphie l'emporte.
  const terms = value.terms.map((t) => cleanTerm(t, "Mot")).filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  if (terms.length > MAX_TERMS) throw Error(`Vocabulaire : ${MAX_TERMS} mots au plus.`);
  return { terms, elevenlabsKeyterms: value.elevenlabsKeyterms === true };
}

/**
 * Vocabulaire effectif du profil. Ancien fichier desktop (`desktop-transcription-vocabulary.json`,
 * hotwords seuls) : ses mots s'ajoutent tant que le nouveau fichier n'existe pas.
 */
export function readSttVocabulary(dataDir) {
  const file = path.join(dataDir, STT_VOCABULARY_FILE);
  try {
    if (fs.existsSync(file)) return { ...normalizeSttVocabulary(JSON.parse(fs.readFileSync(file, "utf8"))), source: "file" };
  } catch (error) {
    return { ...defaultSttVocabulary(), source: "default", error: error instanceof Error ? error.message : String(error) };
  }
  const vocabulary = { ...defaultSttVocabulary(), source: "default" };
  try {
    const legacy = path.join(dataDir, LEGACY_FILE);
    if (fs.existsSync(legacy)) {
      const old = JSON.parse(fs.readFileSync(legacy, "utf8"));
      vocabulary.terms = normalizeSttVocabulary({ version: 1, terms: [...vocabulary.terms, ...(old.terms ?? [])] }).terms;
    }
  } catch {}
  return vocabulary;
}

/** Écriture atomique (fichier temporaire puis renommage). */
export function writeSttVocabulary(dataDir, value) {
  const vocabulary = normalizeSttVocabulary({ version: 1, ...value });
  const file = path.join(dataDir, STT_VOCABULARY_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...vocabulary }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return vocabulary;
}

/** Texte du champ Réglages : un mot (ou une expression) par ligne ; « # » commente une ligne. */
export function formatSttVocabularyText(vocabulary) {
  return vocabulary.terms.join("\n");
}

export function parseSttVocabularyText(text) {
  if (typeof text !== "string" || text.length > 20_000) throw Error("Vocabulaire : texte invalide.");
  return { terms: text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")) };
}

/** Arguments de services/telegram/transcribe.py (faster-whisper `hotwords`). */
export function whisperHotwordArguments(vocabulary) {
  const hotwords = whisperHotwords(vocabulary);
  return hotwords ? ["--hotwords", hotwords] : [];
}

/** Chaîne `hotwords` bornée (le prompt Whisper est limité à ~224 jetons au total). */
export function whisperHotwords(vocabulary) {
  let out = "";
  for (const term of vocabulary.terms) {
    const next = out ? `${out}, ${term}` : term;
    if (next.length > 600) break;
    out = next;
  }
  return out;
}

/**
 * Keyterms ElevenLabs Scribe, vides tant que `elevenlabsKeyterms` n'est pas coché.
 * Batch : ≤ 100 termes de ≤ 50 caractères et ≤ 5 mots. Temps réel : ≤ 50 termes de ≤ 20 caractères.
 */
export function elevenLabsKeyterms(vocabulary, { realtime = false } = {}) {
  if (!vocabulary.elevenlabsKeyterms) return [];
  const max = realtime ? 20 : 50;
  return vocabulary.terms.filter((t) => t.length <= max && t.split(" ").length <= 5).slice(0, realtime ? 50 : 100);
}
