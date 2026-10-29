/**
 * Mise en relation déterministe et explicable (SPEC §17.2) : pour une demande d'aide,
 * classe les parties qui ont un profil de guide selon des critères affichés. Aucun
 * modèle, aucun historique personnel, aucune donnée hors de la demande et des profils.
 *
 * Exclusions : demandeur lui-même, permission de guide absente, langue incompatible,
 * aucun mot de sujet commun, guide déjà en séance, invitation déjà déclinée.
 * Score : 10 par mot de sujet commun ; égalité départagée par la référence (ordre stable).
 * Seul un guide humain peut ouvrir une séance (contributions humaines payables, §17.3).
 */

export interface GuideProfile {
  readonly ref: string;
  readonly kind: "agent" | "human";
  readonly topics: readonly string[];
  readonly languages: readonly string[];
}

export interface MatchQuery {
  readonly requesterRef: string;
  readonly topic: string;
  readonly context: string;
  readonly language: string;
}

export interface MatchProbe {
  busy(ref: string): boolean;
  declined(ref: string): boolean;
}

export interface Candidate {
  readonly ref: string;
  readonly kind: "agent" | "human";
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly sessionPossible: boolean;
  readonly explanation: string;
}

export interface Exclusion {
  readonly ref: string;
  readonly reason: string;
}

export interface MatchOutcome {
  readonly rule: string;
  readonly candidates: readonly Candidate[];
  readonly excluded: readonly Exclusion[];
}

export const MATCHING_RULE =
  "deterministic-v1: language must match; +10 per shared topic word (>= 3 letters, accents ignored); ties by ref";

const STOP_WORDS = new Set(["les", "des", "une", "pour", "avec", "dans", "the", "and", "for"]);

/** Mots normalisés d'un texte : minuscules, sans accents, au moins trois lettres. */
export function terms(text: string): Set<string> {
  const normalized = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function matchGuides(
  query: MatchQuery,
  guides: readonly GuideProfile[],
  probe: MatchProbe,
): MatchOutcome {
  const wanted = terms(`${query.topic} ${query.context}`);
  const candidates: Candidate[] = [];
  const excluded: Exclusion[] = [];
  for (const guide of [...guides].sort((a, b) => a.ref.localeCompare(b.ref))) {
    if (guide.ref === query.requesterRef) continue;
    if (!guide.languages.includes(query.language)) {
      excluded.push({ ref: guide.ref, reason: `language ${query.language} not offered` });
      continue;
    }
    const offered = terms(guide.topics.join(" "));
    const matched = [...offered].filter((t) => wanted.has(t)).sort();
    if (matched.length === 0) {
      excluded.push({ ref: guide.ref, reason: "no shared topic word" });
      continue;
    }
    if (probe.declined(guide.ref)) {
      excluded.push({ ref: guide.ref, reason: "already declined this request" });
      continue;
    }
    if (probe.busy(guide.ref)) {
      excluded.push({ ref: guide.ref, reason: "already in an open session" });
      continue;
    }
    const sessionPossible = guide.kind === "human";
    candidates.push({
      ref: guide.ref,
      kind: guide.kind,
      score: matched.length * 10,
      matchedTerms: matched,
      sessionPossible,
      explanation:
        `language ${query.language}; shared topic words: ${matched.join(", ")}` +
        (sessionPossible ? "" : "; agent guide: messages only, no paid session"),
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  return { rule: MATCHING_RULE, candidates, excluded };
}
