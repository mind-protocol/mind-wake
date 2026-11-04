import type { SpeechEngine, SpeechEvents } from './speech-types';
type SpeechHost = { speechSynthesis: SpeechSynthesis; SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance };
export function createSpeechEngine(host: SpeechHost | null = typeof window === 'undefined' ? null : window): SpeechEngine {
  let current: SpeechSynthesisUtterance | null = null;
  const voices = () => host?.speechSynthesis?.getVoices().filter(voice => voice.localService) ?? [];
  return {
    available: () => !!host?.SpeechSynthesisUtterance && voices().length > 0,
    speak(text: string, events: SpeechEvents) {
      if (!host?.speechSynthesis || !host.SpeechSynthesisUtterance) { events.error('La synthèse vocale n’est pas disponible dans ce navigateur.'); return; }
      const local = voices(); const voice = local.find(item => /^fr(?:-|$)/i.test(item.lang)) ?? local[0];
      if (!voice) { events.error('Aucune voix locale n’est prête. Réessayez après le chargement des voix du téléphone.'); return; }
      if (current) { current.onstart = null; current.onend = null; current.onerror = null; }
      host.speechSynthesis.cancel();
      current = new host.SpeechSynthesisUtterance(text); current.voice = voice; current.lang = voice.lang;
      current.rate = 1; current.volume = 1;
      current.onstart = () => events.start(); current.onend = () => { current = null; events.done(); };
      current.onerror = event => { current = null; events.error(event.error === 'not-allowed' ? 'Touchez le bouton pour autoriser la lecture sur ce téléphone.' : 'La lecture vocale n’a pas abouti.'); };
      host.speechSynthesis.speak(current);
    },
    stop() { if (current) { current.onstart = null; current.onend = null; current.onerror = null; } host?.speechSynthesis?.cancel(); current = null; },
  };
}
