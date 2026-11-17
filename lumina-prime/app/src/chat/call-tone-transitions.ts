/** One pair of cues per actual call lifecycle, independent of renders and polling. */
export function createCallToneTransitions(play: (tone: 'connected' | 'disconnected') => void) {
  let connected = false;
  let ended = false;
  function emit(tone: 'connected' | 'disconnected') { try { play(tone); } catch { /* A cue must never break the call. */ } }
  return {
    reset() { connected = false; ended = false; },
    phase(phase: string) {
      if (ended) return;
      if (phase === 'ended') { ended = true; if (connected) emit('disconnected'); return; }
      if (!connected && ['listening', 'speaking', 'playing'].includes(phase)) {
        connected = true; emit('connected');
      }
    },
  };
}
