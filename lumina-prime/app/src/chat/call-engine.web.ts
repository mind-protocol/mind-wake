import * as Crypto from 'expo-crypto';
import { ChatClientError, chatErrorMessage, type ChatSession } from './client.ts';
import { callReplies, callSpeech, callSessionState, openCallSession, endCall, joinCallParticipants, removeCallParticipants, sendCallUtterance, cancelCallMessage, type CallSession, type CallReply } from './call-client.ts';
import { createBargeIn, createCallVad, levelDb, muteTransition, MUTED_DB, type BargeMode } from './call-vad.ts';
import { setCaptureSpeaking } from './voice-intent.ts';
import type { CallCapture } from './call-frames.ts';
import { createHumanHost } from './human-call-host.ts';
import { createHumanGuest } from './human-call-guest.ts';

export type CallLine = { key: string; who: 'me' | 'them' | 'info'; text: string; detail: string; error?: boolean; speaker?: string; /** Capture partagée (image ou ASCII), affichée dans le fil. */ capture?: CallCapture; /** Retirer la bulle (parole incompréhensible : rien affiché, rien envoyé). */ drop?: boolean };
export type CallPhase = 'connecting' | 'listening' | 'speaking' | 'playing' | 'ended';
export type CallTuning = { silenceMs?: number; bargeMode?: BargeMode; floorDb?: number };
type Events = { onLine: (line: CallLine) => void; onPhase: (phase: CallPhase) => void; onLevel: (db: number, threshold: number) => void };
// Silence très court : WAV minimal joué dans le geste « Appeler » pour déverrouiller la lecture.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const OLD = () => new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Speech = Awaited<ReturnType<typeof callSpeech>>;
type TargetReply = CallReply & {target:string};

/**
 * Un appel. Micro continu avec détection de parole : une prise de parole finit après
 * `silenceMs` de silence et part à l'interlocuteur. Ses nouvelles réponses sont lues au
 * haut-parleur ; le micro reste ouvert pendant la lecture (NLR, 18:02) et une voix nette
 * (seuil plus haut, ~300 ms) coupe la lecture, vide la file et devient une prise de parole.
 * `start` doit être appelé dans le geste utilisateur (micro, son, AudioContext).
 */
export function createCallEngine({ session, targets, announce, voice = () => false, silenceMs, bargeMode, floorDb, onLine, onPhase, onLevel, inviteHumans = false, humanInvite }: Events & {
  session: ChatSession; targets: string[]; announce: boolean; silenceMs: number; bargeMode: BargeMode; floorDb?: number;
  /** Voix des réponses (NLR, 16 nov. : off par défaut) ; off, aucune synthèse n'est demandée au desktop. */
  voice?: () => boolean; inviteHumans?:boolean; humanInvite?:{id:string;label:string} }) {
  if(humanInvite)return createHumanGuest({session,invite:humanInvite,silenceMs,floorDb,onLine,onPhase,onLevel});
  targets = [...new Set(targets)];
  let joining = false;
  let membershipRevision = 1;
  const scope:CallSession={id:Crypto.randomUUID(),epoch:1};
  const abort = new AbortController(); let ended = false;
  const audio = new Audio(); let objectUrl: string | null = null;
  let context: AudioContext | null = null; let stream: MediaStream | null = null;
  let analyser: AnalyserNode | null = null; let ticker: ReturnType<typeof setInterval> | undefined;
  let recorder: MediaRecorder | null = null; let chunks: Blob[] = []; let mime = '';
  let wakeLock: { release: () => Promise<void> } | null = null;
  let muted = false;
  let humans:ReturnType<typeof createHumanHost>|null=null;
  const vad = createCallVad({ silenceMs, floorDb }); const barge = createBargeIn(bargeMode);
  const uploads: { blob: Blob; mime: string; spokeAt: number; targets: string[] }[] = []; let uploading = false;
  const seen = new Set<string>(); const playQueue: { reply: TargetReply; audio: Promise<Speech> }[] = [];
  /** Réponses de tous les participants, dans l'ordre d'arrivée (un même fil n'est lu qu'une fois). */
  let sessionOpened = false;
  const allReplies = async () => (await Promise.all(targets.map(async target =>
    (await callReplies(session, target, OLD(), abort.signal, sessionOpened ? scope : undefined)).map(reply => ({ ...reply, target })))))
    .flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const shown = (reply: CallReply) => (announce && reply.speaker ? `${reply.speaker} : ${reply.text}` : reply.text);
  let playing: { reply: TargetReply; stop: () => void } | null = null; let pumping = false;
  const line = (value: CallLine) => { if (!ended) {onLine(value);humans?.broadcast(value);} };
  const fail = (key: string, who: CallLine['who'], text: string, error: unknown, speaker?: string) =>
    line({ key, who, text, detail: error instanceof ChatClientError ? chatErrorMessage(error) : String((error as Error)?.message ?? error), error: true, speaker });

  /** Nouveau segment d'enregistrement ; l'ancien est jeté ou envoyé par `endSegment`. */
  function beginSegment() {
    if (!stream || ended || muted) return;
    chunks = []; const own: Blob[] = chunks;
    recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 48_000 });
    recorder.ondataavailable = event => { if (event.data.size) own.push(event.data); };
    recorder.start(250); vad.reset(Date.now());
  }
  function endSegment(keep: boolean) {
    const current = recorder; const own = chunks; const spokeAt = vad.lastVoiceAt; const recipients = [...targets];
    recorder = null;
    if (current && current.state !== 'inactive') {
      if (keep) current.onstop = () => {
        const blob = new Blob(own, { type: mime });
        if (blob.size > 4 * 1024 * 1024) { line({ key: `big-${spokeAt}`, who: 'info', text: 'Prise de parole trop longue (4 Mo).', detail: '', error: true }); return; }
        uploads.push({ blob, mime: mime.split(';')[0], spokeAt, targets: recipients }); void pumpUploads();
      };
      current.stop();
    }
    beginSegment();
  }
  function tick() {
    if (!analyser || ended) return;
    // Micro coupé : rien n'est mesuré ni détecté, la lecture des réponses continue.
    if (muted) { onLevel(MUTED_DB, vad.threshold); if (playing && !voice()) { playing.stop(); playQueue.length = 0; } return; }
    const buffer = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buffer);
    const db = levelDb(buffer); const now = Date.now();
    onLevel(db, vad.threshold);
    if (playing && !voice()) { playing.stop(); playQueue.length = 0; }
    if (playing) {
      // Pendant la lecture : seule une interruption nette compte ; l'écho n'est jamais envoyé.
      if (barge.step(db, vad.threshold, now)) interrupt(now);
      return;
    }
    const action = vad.step(db, now);
    if (action === 'speech') onPhase('speaking');
    else if (action === 'utterance' || action === 'cut') { endSegment(true); onPhase('listening'); void pumpPlayback(); }
    else if (action === 'discard') endSegment(false);
  }
  /** NLR coupe la parole : lecture arrêtée, file vidée, sa phrase est enregistrée normalement. */
  function interrupt(now: number) {
    const current = playing; if (!current) return;
    line({ key: current.reply.id, who: 'them', text: shown(current.reply), detail: 'interrompu', speaker: current.reply.speaker ?? undefined });
    for (const { reply } of playQueue.splice(0)) line({ key: reply.id, who: 'them', text: shown(reply), detail: 'interrompu · non lu', speaker: reply.speaker ?? undefined });
    current.stop();
    // Segment neuf : l'écho enregistré pendant la lecture n'est pas transcrit (~0,3 s de début perdu).
    endSegment(false); vad.forceSpeech(now); onPhase('speaking');
  }
  async function pumpUploads() {
    if (uploading) return; uploading = true;
    try {
      while (uploads.length && !ended) {
        const item = uploads.shift()!; const id = `chat-${Crypto.randomUUID()}`;
        line({ key: id, who: 'me', text: '…', detail: 'transcription sur le desktop' });
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await sendCallUtterance(session, item.targets, id, item.blob, item.mime, abort.signal,scope);
            const latency = ((Date.now() - item.spokeAt) / 1000).toFixed(1);
            line(result.status === 'empty'
              ? { key: id, who: 'me', text: '', detail: '', drop: true }
              : { key: id, who: 'me', text: result.text, detail: `envoyé · transcription ${(result.transcribeMs / 1000).toFixed(1)} s · ${latency} s après ta phrase` });
            break;
          } catch (error) {
            if (ended) return;
            if (error instanceof ChatClientError && error.code === 'transcription_busy' && attempt < 40) { await sleep(1500); continue; }
            fail(id, 'me', 'Prise de parole non envoyée.', error); break;
          }
        }
      }
    } finally { uploading = false; }
  }
  async function pollReplies() {
    while (!ended) {
      try {
        const state=await callSessionState(session,scope,abort.signal);
        if(state.status==='ended'){stop();return;}
        if(state.revision)membershipRevision=state.revision;
        for (const reply of await allReplies()) {
          if (!targets.includes(reply.target) || seen.has(reply.id)) continue;
          seen.add(reply.id);
          if (!voice()) { line({ key: reply.id, who: 'them', text: shown(reply), detail: '', speaker: reply.speaker ?? undefined }); continue; }
          line({ key: reply.id, who: 'them', text: shown(reply), detail: 'voix en préparation sur le desktop…', speaker: reply.speaker ?? undefined });
          const pending = callSpeech(session, reply.target, reply.id, abort.signal, announce,scope); pending.catch(() => {});
          playQueue.push({ reply, audio: pending }); void pumpPlayback();
        }
      } catch (error) { if (ended) return;
        if(error instanceof ChatClientError && ['call_ended','call_session_unknown','unauthorized'].includes(error.code)){stop();return;}
        fail('poll', 'info', 'Lecture des réponses interrompue, nouvel essai…', error); }
      await sleep(1500);
    }
  }
  function play(reply: TargetReply, speech: Speech) {
    return new Promise<'ended' | 'stopped'>((resolve, reject) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(speech.blob); audio.src = objectUrl;
      const stop = () => { audio.pause(); resolve('stopped'); };
      playing = { reply, stop }; barge.reset();
      audio.onended = () => resolve('ended'); audio.onerror = () => reject(new Error('Lecture audio impossible.'));
      abort.signal.addEventListener('abort', stop, { once: true });
      audio.play().catch(reject);
    }).finally(() => { playing = null; });
  }
  async function pumpPlayback() {
    // On ne coupe pas NLR au milieu d'une phrase : la réponse attend la fin de sa prise de parole.
    if (!voice()) { playQueue.length = 0; return; }
    if (pumping || ended || vad.speaking || !playQueue.length) return;
    pumping = true;
    try {
      while (playQueue.length && !ended && !vad.speaking) {
        const { reply, audio: pending } = playQueue.shift()!;
        let speech: Speech;
        try { speech = await pending; } catch (error) { fail(reply.id, 'them', shown(reply), error, reply.speaker ?? undefined); continue; }
        if (!targets.includes(reply.target)) continue;
        if (ended || vad.speaking) { playQueue.unshift({ reply, audio: Promise.resolve(speech) }); break; }
        const delay = ((Date.now() - Date.parse(reply.at)) / 1000).toFixed(1);
        line({ key: reply.id, who: 'them', text: shown(reply), detail: `lecture · voix ${speech.provider} en ${(speech.ms / 1000).toFixed(1)} s · ${delay} s après la réponse`, speaker: reply.speaker ?? undefined });
        onPhase('playing');
        try {
          const outcome = await play(reply, speech);
          if (outcome === 'stopped') break;
          line({ key: reply.id, who: 'them', text: shown(reply), detail: `lu · voix ${speech.provider}`, speaker: reply.speaker ?? undefined });
          // Le segment pendant la lecture ne contient que l'écho : on repart d'un segment neuf.
          if (!ended) { endSegment(false); onPhase('listening'); }
        } catch (error) {
          fail(reply.id, 'them', shown(reply), error instanceof DOMException && error.name === 'NotAllowedError'
            ? new Error('Le navigateur a bloqué le son : raccroche puis rappelle.') : error, reply.speaker ?? undefined);
        }
      }
    } finally { pumping = false; }
  }
  async function keepAwake() {
    try { wakeLock = await (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null; }
    catch { wakeLock = null; }
  }
  const visibility = () => { if (document.visibilityState === 'visible' && !ended) void keepAwake();
    else if (!ended) line({ key: 'hidden', who: 'info', text: 'Écran quitté : le navigateur peut suspendre le micro et le son.', detail: '' }); };
  /** Coupe ou rouvre le micro (NLR, 17 nov.) ; renvoie l'état effectif. */
  function setMuted(next: boolean) {
    const change = ended ? 'none' : muteTransition(muted, next, vad.speaking);
    if (change === 'none') return muted;
    if (change === 'resume') { muted = false; stream?.getAudioTracks().forEach(track => { track.enabled = true; }); beginSegment(); if (!playing) onPhase('listening'); return muted; }
    // Phrase commencée : envoyée ; sinon segment jeté. Puis plus aucun enregistrement.
    muted = true; endSegment(change === 'send');
    stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    vad.reset(Date.now()); barge.reset(); onLevel(MUTED_DB, vad.threshold);
    if (!playing) onPhase('listening');
    void pumpPlayback();
    return muted;
  }
  return {
    /** Identifiant de l'appel (captures relayées par le desktop). */
    get callId() { return scope.id; },
    cancelMessage(id: string, text: string) { return cancelCallMessage(session, scope, id, text, abort.signal); },
    setMuted,
    get muted() { return muted; },
    /** Réglages modifiables pendant l'appel (NLR, 17 nov.) : appliqués à la mesure suivante. */
    configure(next: CallTuning) {
      vad.configure({ silenceMs: next.silenceMs, floorDb: next.floorDb });
      if (next.bargeMode) barge.setMode(next.bargeMode);
    },
    /** Dans le geste : déverrouille le son et l'AudioContext avant tout await. */
    async start() {
      onPhase('connecting');
      audio.src = SILENT_WAV; const unlocked = audio.play().catch(() => {});
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      context = new Ctx(); void context.resume();
      setCaptureSpeaking(true); // Le micro « Parler à Marco » du chat reste coupé pendant l'appel.
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Le micro exige HTTPS ou localhost (liaison USB).');
      if (typeof MediaRecorder === 'undefined') throw new Error('Ce navigateur n’enregistre pas l’audio.');
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
      catch (error) { throw new Error(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Accès au micro refusé.' : 'Micro indisponible.'); }
      if (ended) { stream.getTracks().forEach(track => track.stop()); return; }
      if (muted) stream.getAudioTracks().forEach(track => { track.enabled = false; });
      mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) ?? '';
      if (!mime) throw new Error('Aucun format audio compatible.');
      await unlocked;
      if (ended) return;
      analyser = context.createAnalyser(); analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      void keepAwake(); document.addEventListener('visibilitychange', visibility);
      // Les réponses déjà présentes ne sont pas relues : seules les nouvelles le seront.
      for (const reply of await allReplies()) seen.add(reply.id);
      if (ended) return;
      await openCallSession(session,scope,targets,abort.signal);
      sessionOpened = true;
      if(ended)return;
      if(inviteHumans) {
        humans=createHumanHost({session,scope,context,stream,audio,onLine});
        try{await humans.start();}catch(error){fail('human-invitation','info','Invitation de l’humain non envoyée.',error);}
        if(ended)return;
      }
      if (window.location?.pathname === '/desktop-call' && window.parent !== window) {
        window.parent.postMessage({type:'mind.call.vision', id:scope.id}, '*');
      }
      beginSegment(); onPhase('listening'); ticker = setInterval(tick, 100); void pollReplies();
    },
    async addTargets(additions: string[]) {
      if (ended || joining) throw new Error('Ajout de participant indisponible.');
      const next = [...new Set([...targets, ...additions])];
      if (next.length > 8) throw new Error('Huit participants au maximum.');
      const fresh = next.filter(target => !targets.includes(target));
      if (!fresh.length) return [...targets];
      joining = true;
      try {
        // Existing replies of the new participant are baseline, never replayed aloud.
        const baseline = await Promise.all(fresh.map(target => callReplies(session, target, OLD(), abort.signal)));
        if (ended) throw new Error('Appel terminé.');
        const state=await joinCallParticipants(session, scope,next, membershipRevision,abort.signal);
        if(state.revision)membershipRevision=state.revision;
        if (ended) throw new Error('Appel terminé.');
        for (const replies of baseline) for (const reply of replies) seen.add(reply.id);
        targets = next;
        return [...targets];
      } finally { joining = false; }
    },
    async removeTargets(removals: string[]) {
      if(ended||joining)throw new Error('Modification des participants indisponible.');
      joining=true;
      try {
        const state=await removeCallParticipants(session,scope,removals,membershipRevision,abort.signal);
        if(ended)return [];
        if(state.status==='ended'){targets=[];stop();return [];}
        targets=state.handles;if(state.revision)membershipRevision=state.revision;
        // Removed participants cannot continue queued playback after the explicit removal.
        for(let i=playQueue.length-1;i>=0;i--)if(!targets.includes(playQueue[i].reply.target))playQueue.splice(i,1);
        if(playing&&!targets.includes(playing.reply.target)){playing.stop();endSegment(false);if(!vad.speaking)onPhase('listening');}
        return [...targets];
      }finally{joining=false;}
    },
    stop,
  };
  function stop() {
      if (ended) return; ended = true; abort.abort(); clearInterval(ticker);
      humans?.stop();
      void endCall(session,targets,undefined,true,scope).catch(()=>{});
      document.removeEventListener('visibilitychange', visibility);
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* Déjà arrêté. */ }
      stream?.getTracks().forEach(track => track.stop()); void context?.close().catch(() => {});
      audio.pause(); audio.removeAttribute('src'); if (objectUrl) URL.revokeObjectURL(objectUrl);
      void wakeLock?.release().catch(() => {}); setCaptureSpeaking(false); onPhase('ended');
  }
}
