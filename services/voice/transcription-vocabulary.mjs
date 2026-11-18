// Compatibilité : le vocabulaire de dictée vit désormais dans stt-vocabulary.mjs
// (stt-vocabulary.json, partagé par la dictée desktop, Telegram et les appels Lumina).
import { readSttVocabulary, whisperHotwordArguments } from "./stt-vocabulary.mjs";
export function vocabularyArguments(dataDir) {
  return whisperHotwordArguments(readSttVocabulary(dataDir));
}
