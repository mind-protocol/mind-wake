import { AudioModule, createAudioPlayer, RecordingPresets, setAudioModeAsync, type AudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { callReplies, callSessionState, openCallSession, endCall, joinCallParticipants, removeCallParticipants, sendCallUtterance, type CallSession, type CallReply } from './call-client';
import { chatErrorMessage, chatUrl, ChatClientError } from './client';
import { createBargeIn, createCallVad, muteTransition, MUTED_DB } from './call-vad';
import type { createCallEngine as webEngine, CallTuning } from './call-engine.web';
export type { CallLine, CallPhase, CallTuning } from './call-engine.web';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// eslint-disable-next-line import/namespace -- Expo exposes this typed constructor on its native module.
const { AudioRecorder: NativeRecorder } = AudioModule;
const preset = RecordingPresets.HIGH_QUALITY;
const options = { ...preset, isMeteringEnabled: true, numberOfChannels: 1, bitRate: 64000,
  android: { ...preset.android, audioSource: 'voice_communication' as const } };

export const createCallEngine: typeof webEngine = ({ session, targets, announce, voice = () => false, silenceMs, bargeMode, floorDb, onPhase, onLevel, onLine }) => {
  targets = [...new Set(targets)];
  let joining = false;
  let membershipRevision = 1;
  let playerTarget: string | null = null;
  const scope:CallSession={id:randomUUID(),epoch:1};
  const abort = new AbortController();
  const { signal } = abort;
  const vad = createCallVad({ silenceMs, floorDb });
  const barge = createBargeIn(bargeMode);
  const since = new Date().toISOString();
  const seen = new Set<string>();
  const queue: (CallReply & { target: string })[] = [];
  let player: ReturnType<typeof createAudioPlayer> | null = null;
  let playingSince = 0;
  let playbackStarted = false;
  let discardEcho = false;
  let muted = false;
  let uploads = Promise.resolve();
  let appState: ReturnType<typeof AppState.addEventListener> | undefined;
  const report = (key: string, error: unknown) => {
    if (!signal.aborted) onLine({ key, who: 'info', text: chatErrorMessage(error), detail: String((error as Error)?.message ?? error), error: true });
  };
  function endPlayback() {
    if (!player) return;
    player.remove(); player = null;playerTarget=null;
    discardEcho = true;
    if (!signal.aborted) onPhase('listening');
  }
  function stop() {
    if (signal.aborted) return;
    abort.abort(); appState?.remove();
    void endCall(session,targets,undefined,true,scope).catch(()=>{}); endPlayback(); onPhase('ended');
  }
  function startPlayback() {
    const next = queue.shift();
    if (!next) return;
    const uri = chatUrl(session.url) + '/chat/call/speech?target=' + encodeURIComponent(next.target)
      + '&item=' + encodeURIComponent(next.id) + (announce ? '&announce=1' : '');
    player = createAudioPlayer({ uri, headers: { Authorization: 'Bearer ' + session.token } });
    const current = player;playerTarget=next.target;
    player.addListener('playbackStatusUpdate', state => {
      if (current !== player) return;
      if (state.playbackState === 'error') report(next.id, new Error('Lecture de la réponse impossible.'));
      if (state.didJustFinish || state.playbackState === 'error') endPlayback();
    });
    barge.reset(); playingSince = Date.now(); playbackStarted = false;
  }
  async function poll() {
    while (!signal.aborted) {
      try {const state=await callSessionState(session,scope,signal);if(state.status==='ended'){stop();return;}if(state.revision)membershipRevision=state.revision;}
      catch(error){if(signal.aborted)return;report('call-state',error);stop();return;}
      const batches = await Promise.allSettled(targets.map(async target =>
        (await callReplies(session, target, since, signal)).map(reply => ({ ...reply, target }))));
      if (signal.aborted) return;
      const fresh = batches.flatMap(batch => {
        if (batch.status === 'fulfilled') return batch.value;
        report('poll', batch.reason); return [];
      }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (const reply of fresh) {
        if (!targets.includes(reply.target) || seen.has(reply.id)) continue;
        // Voix off (défaut) : la réponse s'affiche, rien n'est synthétisé ni joué.
        seen.add(reply.id); if (voice()) queue.push(reply);
        onLine({ key: reply.id, who: 'them', text: reply.text, detail: '', speaker: reply.speaker ?? undefined });
      }
      await wait(1500);
    }
  }
  function upload(bytes: ArrayBuffer) {
    const id = 'chat-' + randomUUID();
    const recipients = [...targets];
    onLine({ key: id, who: 'me', text: '…', detail: 'Transcription sur le desktop' });
    uploads = uploads.then(async () => {
      while (!signal.aborted) {
        try {
          const result = await sendCallUtterance(session, recipients, id, bytes, 'audio/mp4', signal,scope);
          if (!signal.aborted) onLine(result.status === 'empty' || !result.text.trim() ? { key: id, who: 'me', text: '', detail: '', drop: true }
            : { key: id, who: 'me', text: result.text, detail: '' });
          return;
        } catch (error) {
          if (!(error instanceof ChatClientError && error.code === 'transcription_busy')) throw error;
          await wait(1500);
        }
      }
    }).catch(error => report(id, error));
  }
  async function segment(interrupted: boolean) {
    const recorder: AudioRecorder = new NativeRecorder({ ...options, ...(Platform.OS === 'ios' ? options.ios : options.android) });
    let keep = false;
    try {
      await recorder.prepareToRecordAsync(options);
      if (signal.aborted || muted) return false;
      recorder.record(); vad.reset(Date.now());
      if (interrupted) vad.forceSpeech(Date.now());
      while (!signal.aborted) {
        await wait(100);
        if (signal.aborted) break;
        // Micro coupé (NLR, 17 nov.) : phrase commencée envoyée, sinon segment jeté ; l'enregistreur s'arrête.
        if (muted) { keep = muteTransition(false, true, vad.speaking) === 'send'; if (!player) onPhase('listening'); break; }
        const now = Date.now();
        const status = recorder.getStatus();
        if (!status.isRecording) throw new Error('Le micro a cessé d’enregistrer.');
        const db = status.metering ?? -120;
        onLevel(db, vad.threshold);
        if (discardEcho) { discardEcho = false; break; }
        if (!voice() && (player || queue.length)) { queue.length = 0; if (player) { endPlayback(); discardEcho = false; } }
        if (player && playbackStarted) {
          if (barge.step(db, vad.threshold, now)) {
            queue.length = 0; endPlayback(); discardEcho = false; onPhase('speaking'); return true;
          }
          if (now - playingSince > 50000) { playingSince = now; break; }
          continue;
        }
        if (player && now - playingSince > 150000) { report('play', new Error('La voix ne démarre pas.')); endPlayback(); continue; }
        const action = vad.step(db, now);
        if (action === 'speech') onPhase('speaking');
        if (action === 'utterance' || action === 'cut') { keep = true; onPhase('listening'); break; }
        if (action === 'discard') break;
        if (!vad.speaking && !player && queue.length) startPlayback();
        if (!vad.speaking && player?.isLoaded && !playbackStarted) {
          player.play(); playbackStarted = true; playingSince = now; onPhase('playing');
        }
      }
    } finally {
      try {
        if (recorder.isRecording) await recorder.stop();
        if (recorder.uri) {
          const file = new File(recorder.uri);
          try { if (keep && !signal.aborted) upload(await file.arrayBuffer()); }
          finally { if (file.exists) file.delete(); }
        }
      } finally { recorder.release(); }
    }
    return false;
  }
  /** Micro coupé : aucun enregistreur ouvert, aucune détection ; les réponses sont encore lues. */
  async function whileMuted() {
    vad.reset(Date.now()); barge.reset();
    while (muted && !signal.aborted) {
      const now = Date.now();
      onLevel(MUTED_DB, vad.threshold);
      if (!voice() && (player || queue.length)) { queue.length = 0; if (player) endPlayback(); }
      if (!player && queue.length) startPlayback();
      if (player?.isLoaded && !playbackStarted) { player.play(); playbackStarted = true; playingSince = now; onPhase('playing'); }
      else if (player && !playbackStarted && now - playingSince > 150000) { report('play', new Error('La voix ne démarre pas.')); endPlayback(); }
      await wait(100);
    }
    discardEcho = false;
  }
  async function listen() {
    let interrupted = false;
    try {
      while (!signal.aborted) {
        if (muted) { await whileMuted(); interrupted = false; continue; }
        interrupted = await segment(interrupted);
      }
    } catch (error) { report('micro', error); stop(); }
  }
  return {
    get callId() { return scope.id; },
    /** Coupe ou rouvre le micro (NLR, 17 nov.) ; renvoie l'état effectif. */
    setMuted(next: boolean) {
      const change = signal.aborted ? 'none' : muteTransition(muted, next, vad.speaking);
      if (change === 'none') return muted;
      muted = next; onLevel(MUTED_DB, vad.threshold);
      return muted;
    },
    get muted() { return muted; },
    /** Réglages modifiables pendant l'appel (NLR, 17 nov.) : appliqués à la mesure suivante. */
    configure(next: CallTuning) {
      vad.configure({ silenceMs: next.silenceMs, floorDb: next.floorDb });
      if (next.bargeMode) barge.setMode(next.bargeMode);
    },
    async start() {
      onPhase('connecting');
      if (!(await AudioModule.requestRecordingPermissionsAsync()).granted) throw new Error('Autorise le micro pour appeler.');
      if (signal.aborted) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
      if (signal.aborted) return;
      appState = AppState.addEventListener('change', state => { if (state === 'background') stop(); });
      await openCallSession(session,scope,targets,signal);
      if(signal.aborted)return;
      onPhase('listening'); void poll(); void listen();
    },
    async addTargets(additions: string[]) {
      if (signal.aborted || joining) throw new Error('Ajout de participant indisponible.');
      const next = [...new Set([...targets, ...additions])];
      if (next.length > 8) throw new Error('Huit participants au maximum.');
      const fresh = next.filter(target => !targets.includes(target));
      if (!fresh.length) return [...targets];
      joining = true;
      try {
        const baseline = await Promise.all(fresh.map(target => callReplies(session, target, since, signal)));
        if (signal.aborted) throw new Error('Appel terminé.');
        const state=await joinCallParticipants(session, scope,next,membershipRevision,signal);
        if(state.revision)membershipRevision=state.revision;
        if (signal.aborted) throw new Error('Appel terminé.');
        for (const replies of baseline) for (const reply of replies) seen.add(reply.id);
        targets = next;
        return [...targets];
      } finally { joining = false; }
    },
    async removeTargets(removals: string[]) {
      if(signal.aborted||joining)throw new Error('Modification des participants indisponible.');
      joining=true;
      try {
        const state=await removeCallParticipants(session,scope,removals,membershipRevision,signal);
        if(signal.aborted)return [];
        if(state.status==='ended'){targets=[];stop();return [];}
        targets=state.handles;if(state.revision)membershipRevision=state.revision;
        for(let i=queue.length-1;i>=0;i--)if(!targets.includes(queue[i].target))queue.splice(i,1);
        if(playerTarget&&!targets.includes(playerTarget))endPlayback();
        return [...targets];
      }finally{joining=false;}
    },
    stop,
  };
};
