/**
 * Mots-clés et similarité (tf-idf, cosinus) entre le message de l'agent et les sessions
 * Claude Code / Codex autorisées. Aucune dépendance : jetons sans accents, mots courts et
 * mots vides (français, anglais, jargon d'outillage) écartés.
 */

const STOPWORDS = new Set(
  `
alors aussi autre avant avec avoir bien cela celle celui cette comme dans depuis donc dont elle elles encore entre etre faire fait faut leur leurs mais meme mieux moins nous notre peut plus pour pourquoi quand quel quelle quelque sans selon sera sont sous tout toute tous tres vers voici votre vous juste ensuite chose choses parce comment quoi oui non merci bonjour ceci celles ceux

about above after again against also because been before being below between both could does doing down during each from further have having here into just more most only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours make made like want need please thanks okay yeah

file files code line lines function const return true false null undefined import export type string number json text test tests error errors output input value values data result results path paths node npm run using used use
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Jetons normalisés : minuscules, sans accents, 4 à 30 caractères, sans chiffres seuls. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length >= 4 && t.length <= 30 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

export type TermFrequencies = ReadonlyMap<string, number>;

export function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Fréquence documentaire inverse lissée sur un corpus de documents. */
export function inverseDocumentFrequency(docs: readonly TermFrequencies[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, n] of df) idf.set(term, Math.log((1 + docs.length) / (1 + n)) + 1);
  return idf;
}

function weights(tf: TermFrequencies, idf: ReadonlyMap<string, number>): Map<string, number> {
  const w = new Map<string, number>();
  for (const [term, n] of tf) w.set(term, (1 + Math.log(n)) * (idf.get(term) ?? 1));
  return w;
}

/** Cosinus des poids tf-idf et termes communs les plus porteurs. */
export function similarity(
  a: TermFrequencies,
  b: TermFrequencies,
  idf: ReadonlyMap<string, number>,
): { score: number; shared: string[] } {
  const wa = weights(a, idf);
  const wb = weights(b, idf);
  let dot = 0;
  const shared: [string, number][] = [];
  for (const [term, x] of wa) {
    const y = wb.get(term);
    if (y !== undefined) {
      dot += x * y;
      shared.push([term, x * y]);
    }
  }
  const norm = (w: Map<string, number>): number =>
    Math.sqrt([...w.values()].reduce((s, v) => s + v * v, 0));
  const denominator = norm(wa) * norm(wb);
  return {
    score: denominator === 0 ? 0 : dot / denominator,
    shared: shared
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([term]) => term),
  };
}

/** Termes les plus caractéristiques d'un document (pour l'affichage). */
export function topTerms(tf: TermFrequencies, idf: ReadonlyMap<string, number>, n = 10): string[] {
  return [...weights(tf, idf).entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([term]) => term);
}
