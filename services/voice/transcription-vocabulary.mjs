import fs from "node:fs";
import path from "node:path";
// Desktop-only hints: no provider change and no transcript replacement.
export function vocabularyArguments(dataDir) {
  const file = path.join(dataDir, "desktop-transcription-vocabulary.json");
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.terms) || value.terms.length > 32 || value.terms.some(term => typeof term !== "string" || !term.trim() || term.length > 64 || /[\r\n\x00]/.test(term)))
    throw Error("Vocabulaire de dictée invalide.");
  const terms = [...new Set(value.terms.map(term => term.trim()))];
  return terms.length ? ["--hotwords", terms.join(", ")] : [];
}
