import type { SpeechEngine } from './speech-types';
/** TypeScript/SSR fallback; Metro selects the matching platform implementation. */
export function createSpeechEngine(): SpeechEngine {
  return { available: () => false, speak: (_, events) => events.error('La synthèse vocale n’est pas disponible ici.'), stop: () => {} };
}
