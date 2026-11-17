/**
 * Détection de parole du mode Appel, sans dépendance au navigateur : on lui donne un niveau
 * (dBFS) toutes les ~100 ms, il dit quand une prise de parole est finie (silence de
 * `silenceMs` après de la parole), quand un segment sans parole doit être jeté, et quand un
 * segment trop long doit être coupé (limite de la transcription locale, 65 s).
 */
export type VadOptions = { silenceMs?: number; minSpeechMs?: number; idleResetMs?: number; maxSegmentMs?: number;
  marginDb?: number; floorDb?: number };
/** Écart de seuil (dB) accordé à une voix qui baisse pendant une prise de parole déjà commencée. */
export const SPEAKING_HYSTERESIS_DB = 8;
export type VadAction = 'none' | 'speech' | 'utterance' | 'discard' | 'cut';
/** Seuil minimal de parole (dBFS) réglable dans l'appel (NLR, 17 nov. : le bruit de fond garde le micro « actif »). */
export const FLOOR_DB_DEFAULT = -52;
export const FLOOR_DB_MIN = -70;
export const FLOOR_DB_MAX = -20;
export function clampFloorDb(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(FLOOR_DB_MAX, Math.max(FLOOR_DB_MIN, value))) : FLOOR_DB_DEFAULT;
}
export function createCallVad({ silenceMs = 5000, minSpeechMs = 250, idleResetMs = 20_000, maxSegmentMs = 55_000,
  marginDb = 14, floorDb = FLOOR_DB_DEFAULT }: VadOptions = {}) {
  let segmentStart = 0; let noise = -65; let aboveSince: number | null = null;
  let speaking = false; let lastVoice = 0;
  const threshold = () => Math.max(floorDb, noise + marginDb);
  return {
    /** Réglage en cours d'appel : appliqué dès la mesure suivante. */
    configure(next: { silenceMs?: number; floorDb?: number }) {
      if (next.silenceMs !== undefined && next.silenceMs > 0) silenceMs = next.silenceMs;
      if (next.floorDb !== undefined) floorDb = clampFloorDb(next.floorDb);
    },
    reset(now: number) { segmentStart = now; aboveSince = null; speaking = false; lastVoice = now; },
    get speaking() { return speaking; },
    /** Interruption détectée ailleurs (pendant la lecture) : la prise de parole a déjà commencé. */
    forceSpeech(now: number) { segmentStart = now; speaking = true; lastVoice = now; aboveSince = now; },
    get threshold() { return threshold(); },
    /** Fin réelle de la parole (dernier instant au-dessus du seuil). */
    get lastVoiceAt() { return lastVoice; },
    step(db: number, now: number): VadAction {
      const level = Number.isFinite(db) ? db : -120;
      // NLR, 16 nov. 2026 (« ma phrase se coupe ») : une fois la parole commencée, une voix plus
      // basse (fin de phrase) compte encore comme parole, et le bruit de fond ne monte plus.
      const above = level > threshold() - (speaking ? SPEAKING_HYSTERESIS_DB : 0);
      // Bruit de fond : suit vite vers le bas, lentement vers le haut, jamais pendant la parole.
      if (!above) noise = level < noise ? noise + (level - noise) * 0.3 : speaking ? noise : noise + (level - noise) * 0.02;
      if (above) {
        aboveSince ??= now; lastVoice = now;
        if (!speaking && now - aboveSince >= minSpeechMs) { speaking = true; return 'speech'; }
      } else aboveSince = null;
      if (now - segmentStart >= maxSegmentMs) return speaking ? 'cut' : 'discard';
      if (speaking && now - lastVoice >= silenceMs) return 'utterance';
      if (!speaking && now - segmentStart >= idleResetMs) return 'discard';
      return 'none';
    },
  };
}
/**
 * Micro coupé (NLR, 17 nov. 2026, pendant un appel). Coupé : piste micro désactivée, aucun
 * segment enregistré ni envoyé, la détection de parole ne reçoit plus rien. Au moment de couper,
 * une phrase déjà commencée part (elle a été dite micro ouvert) ; sinon le segment est jeté.
 */
export const MUTED_DB = -120;
export type MuteChange = 'none' | 'send' | 'discard' | 'resume';
export function muteTransition(wasMuted: boolean, next: boolean, speaking: boolean): MuteChange {
  if (wasMuted === next) return 'none';
  return next ? (speaking ? 'send' : 'discard') : 'resume';
}
/** Niveau RMS en dBFS d'un échantillon temporel [-1, 1]. */
export function levelDb(samples: ArrayLike<number>): number {
  let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? 10 * Math.log10(sum / samples.length + 1e-12) : -120;
}

/**
 * Interruption pendant que l'agent parle (NLR, 16 nov. 18:02). Le micro reste ouvert ; le son du
 * haut-parleur repasse en partie malgré l'annulation d'écho, d'où un seuil plus haut que la
 * détection normale et une durée minimale. `off` : jamais d'interruption.
 */
export type BargeMode = 'sensible' | 'normal' | 'off';
export const BARGE_SETTINGS: Record<BargeMode, { marginDb: number; minMs: number } | null> = {
  sensible: { marginDb: 6, minMs: 250 }, normal: { marginDb: 12, minMs: 350 }, off: null };
export function createBargeIn(mode: BargeMode) {
  let setting = BARGE_SETTINGS[mode]; let since: number | null = null;
  return {
    setMode(next: BargeMode) { setting = BARGE_SETTINGS[next] ?? setting; since = null; },
    reset() { since = null; },
    /** `threshold` : seuil de parole de la détection normale (dBFS). */
    step(db: number, threshold: number, now: number): boolean {
      if (!setting || !Number.isFinite(db) || db <= threshold + setting.marginDb) { since = null; return false; }
      since ??= now;
      return now - since >= setting.minMs;
    },
  };
}
