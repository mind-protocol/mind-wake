import * as Speech from 'expo-speech';
import type { SpeechEngine } from './speech-types';
export function createSpeechEngine(): SpeechEngine {
  return {
    available: () => true,
    speak(text, events) {
      void Speech.stop().then(() => {
        Speech.speak(text.slice(0, Speech.maxSpeechInputLength), { language: 'fr-FR', rate: 1, volume: 1,
          onStart: events.start, onDone: events.done, onError: () => events.error('La synthèse vocale du téléphone n’a pas abouti.') });
      }).catch(() => events.error('La synthèse vocale n’est pas prête.'));
    },
    stop() { void Speech.stop(); },
  };
}
