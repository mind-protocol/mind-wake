import { createAudioPlayer } from 'expo-audio';
const SOURCES = {connected:require('../../assets/call-connected.wav'),disconnected:require('../../assets/call-disconnected.wav')};
// Players outlive a departing view for their 200 ms cue, but never beyond one second.
const active = new Set<{player:ReturnType<typeof createAudioPlayer>;timer:ReturnType<typeof setTimeout>}>();
function release(entry:{player:ReturnType<typeof createAudioPlayer>;timer:ReturnType<typeof setTimeout>}) {
  clearTimeout(entry.timer);try {entry.player.remove();}catch {} active.delete(entry);
}
/** Best effort: no await, no mode/micro changes, bounded lifetime and capped output volume. */
export function createCallTonePlayer() {
  return {
    play(tone: keyof typeof SOURCES) {
      let player:ReturnType<typeof createAudioPlayer> | null = null;
      try {
        // A connection and disconnection may overlap; cap unusual repeated callers as well.
        while(active.size>=2) release(active.values().next().value!);
        player = createAudioPlayer(SOURCES[tone]); player.volume = 0.25; player.loop = false;
        const owned = player;
        const entry = {player:owned,timer:setTimeout(() => release(entry),1000)};
        active.add(entry);owned.play();
      } catch { try { player?.remove(); } catch {} }
    },
  };
}
