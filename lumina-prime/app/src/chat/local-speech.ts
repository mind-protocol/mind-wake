export type SpeechResultEvent = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
export type LocalRecognition = {
  processLocally: boolean; lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null; onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
export type LocalSpeechConstructor = {
  new(): LocalRecognition;
  available(options: { langs: string[]; processLocally: true; quality?: string }): Promise<string>;
  install(options: { langs: string[]; quality?: string }): Promise<boolean>;
};
export type LocalSpeechState = { phase: 'idle' | 'checking' | 'download' | 'recording' | 'unsupported'; message: string };

/** Device-only ASR. No audio fetch, upload, remote recognition fallback or hidden permission request. */
export function createLocalSpeech(options: {
  constructor: LocalSpeechConstructor | undefined; secure: boolean; visible: () => boolean;
  onState: (state: LocalSpeechState) => void; onTranscript: (text: string) => void;
  segmentMs?: number;
}) {
  let active = false; let generation = 0; let recognition: LocalRecognition | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined; let restart: ReturnType<typeof setTimeout> | undefined;
  const state = (phase: LocalSpeechState['phase'], message: string) => options.onState({ phase, message });
  const clear = () => { clearTimeout(timer); clearTimeout(restart); };
  function pause(message = 'Micro en pause') {
    active = false; generation++; clear(); const previous = recognition; recognition = null;
    previous?.abort(); state('idle', message);
  }
  function record(version: number) {
    if (!active || version !== generation || !options.visible()) { pause('Micro en pause · app masquée'); return; }
    const Constructor = options.constructor!; const current = new Constructor();
    if (!('processLocally' in current)) { pause(); state('unsupported', 'Reconnaissance locale indisponible sur ce navigateur. Aucun audio envoyé au PC.'); return; }
    current.processLocally = true; current.lang = 'fr-FR'; current.continuous = true; current.interimResults = false;
    recognition = current; const seen = new Set<number>(); let failed = false;
    current.onresult = event => {
      if (!active || version !== generation || recognition !== current) return;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal && !seen.has(index)) { seen.add(index); const text = result[0].transcript.trim(); if (text) options.onTranscript(text); }
      }
    };
    current.onerror = event => {
      if (version !== generation) return;
      if (event.error === 'no-speech') return;
      failed = true; pause(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Micro refusé. Autorise-le dans les réglages du navigateur.' : `Reconnaissance locale arrêtée (${event.error}).`);
    };
    current.onend = () => {
      clearTimeout(timer);
      if (recognition === current) recognition = null;
      if (active && !failed && version === generation) restart = setTimeout(() => record(version), 150);
    };
    current.onstart = () => {
      if (!active || version !== generation) { current.abort(); return; }
      state('recording', 'Micro ON · local · 30 s enchaînées');
      timer = setTimeout(() => { if (recognition === current) current.stop(); }, options.segmentMs ?? 30_000);
    };
    try { state('checking', 'Autorisation et démarrage du micro local…'); current.start();
    } catch { pause('Impossible de démarrer le micro local. Réessaie avec le bouton.'); }
  }
  async function start(install = false) {
    if (active) return;
    const Constructor = options.constructor;
    if (!options.secure || !Constructor?.available) { state('unsupported', 'Transcription sur cet appareil indisponible ici. Aucun repli distant.'); return; }
    active = true; const version = ++generation; state('checking', install ? 'Téléchargement du modèle français sur cet appareil…' : 'Vérification du français local…');
    try {
      let availability = await Constructor.available({ langs: ['fr-FR'], processLocally: true, quality: 'dictation' });
      if (!active || version !== generation) return;
      if (availability !== 'available' && install && Constructor.install) {
        const ok = await Constructor.install({ langs: ['fr-FR'], quality: 'dictation' });
        if (!active || version !== generation) return;
        availability = ok ? await Constructor.available({ langs: ['fr-FR'], processLocally: true, quality: 'dictation' }) : 'unavailable';
      }
      if (!active || version !== generation) return;
      if (availability === 'downloadable' || availability === 'downloading') { active = false; state('download', 'Le modèle français doit être téléchargé sur cet appareil.'); return; }
      if (availability !== 'available') { active = false; state('unsupported', 'Français local indisponible sur ce navigateur. Aucun audio envoyé au PC.'); return; }
      record(version);
    } catch { if (version === generation) pause('Reconnaissance locale indisponible ou permission refusée.'); }
  }
  return { start, pause, dispose: () => pause() };
}
