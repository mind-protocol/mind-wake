import {voiceScreenshotsPreference,screenshotWork,type VoiceScreenshots} from './voice-screenshots.js';
import type {VoiceSelection} from "./voice-conversations.js";
export const VOICE_INTERVAL_MS = 30_000;
export const VOICE_OVERLAP_MS = 5_000;
export const SCREEN_INTERVAL_MS = 10_000;
const VISUAL_SAMPLE_INTERVAL_MS = 200;
const VISUAL_BUFFER_CHARS = 32 * 1024 * 1024;
export const MAX_VOICE_SCREENSHOTS = 3;
export function voiceScreenshots<T>(frames: readonly T[]): T[] {
  if (frames.length <= MAX_VOICE_SCREENSHOTS) return [...frames];
  return [frames[0]!, frames[Math.round((frames.length - 1) / 2)]!, frames[frames.length - 1]!];
}
export function removeVoiceOverlap(previous: string, current: string): string {
  const before = previous.trim().split(/\s+/),
    after = current.trim().split(/\s+/);
  const normalized = (word: string): string =>
    word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let length = Math.min(60, before.length, after.length); length >= 3; length--) {
    if (
      before.slice(-length).every((word, index) => normalized(word) === normalized(after[index]!))
    )
      return after.slice(length).join(" ");
  }
  return current.trim();
}
export interface VoiceRecorder {
  start: MediaRecorder["start"];
  stop: MediaRecorder["stop"];
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  transcript?: Promise<string>;
}
export interface VoiceCaptureSegment { kind: 'start'|'stop'; requestId:string; capturedAt:string; durationMs:number; plannedDurationMs?:number; elapsedMs?:number; startedMonotonicMs?:number }
export interface VoiceMetadata {capturedAt:string;requestId:string;voiceSelection?:VoiceSelection;transcriptionProvider?:'current'|'elevenlabs'}
interface SilenceWatch { hasSpeech(): boolean; reset(): void; stop(): void }
interface Microphone {stop(discard?:boolean):void;activate?():void;recorder?():VoiceRecorder;watchSilence?(finalize:()=>void):SilenceWatch|undefined;transcriptionProvider?:'current'|'elevenlabs'}
interface Options {
  screenshots?:VoiceScreenshots;
  captureContext?(capturedAt:string):VoiceSelection;
  microphone(): Promise<Microphone>;
  recorder(): VoiceRecorder;
  snapshot(): Promise<string>;
  visualSnapshot?(): Promise<string>;
  transcribe(audio: Blob, metadata: VoiceMetadata): Promise<string>;
  cancelTranscription?(): void;
  send(text: string, images: string[], metadata:VoiceMetadata): Promise<void>;
  state(recording: boolean, note: string): void;
  processing?(pending:number,note:string):void;
  transcribing?(pending:number):void;
  captureSegment?(event:VoiceCaptureSegment):void;
  monotonicNow?():number;
  timer?(callback: () => void, ms: number): number | ReturnType<typeof setTimeout>;
  clearTimer?(id: number | ReturnType<typeof setTimeout>): void;
}
/** Independent complete audio files per slice; capture belongs to the slice's start. */
export function voiceInput(options: Options) {
  let running = false,
    starting = false,
    discarded = false;
  const screenshots=options.screenshots??voiceScreenshotsPreference();
  const requestScreenshots=new Map<string,number>();
  let mic: Microphone | undefined;
  let silenceWatch: SilenceWatch | undefined;
  let rotateOnSilence: (() => void) | undefined;
  let attempt=0, epoch=0;
  let session={epoch,previous:""};
  const requests=new Map<string,typeof session>();
  const recorders = new Set<VoiceRecorder>();
  const stoppingRecorders = new Map<VoiceRecorder,{promise:Promise<void>;resolve:()=>void}>();
  const stopRecorder=(recorder:VoiceRecorder):void=>{
    if(stoppingRecorders.has(recorder))return;
    let resolve!:()=>void;
    const promise=new Promise<void>(done=>{resolve=done;});
    stoppingRecorders.set(recorder,{promise,resolve});
    recorder.stop();
  };
  const timers = new Set<number | ReturnType<typeof setTimeout>>();
  let queue = Promise.resolve();
  let pendingSegments=0;
  const transcriptionWaiters = new Map<string, () => void>();
  const notifyTranscribing = () => options.transcribing?.(transcriptionWaiters.size);
  const transcribe = async (audio: Blob, metadata: VoiceMetadata): Promise<string> => {
    let cancel!: () => void;
    const cancelled = new Promise<string>(resolve => { cancel = () => { resolve(''); }; });
    transcriptionWaiters.set(metadata.requestId, cancel);
    notifyTranscribing();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.transcribe(audio, metadata), cancelled,
        new Promise<string>((_resolve, reject) => {
          timeout = setTimeout(() => {
            options.cancelTranscription?.();
            reject(Error('Transcription expirée ; aucun nouvel envoi. Reprendre la dictée.'));
          }, 120_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      transcriptionWaiters.delete(metadata.requestId);
      notifyTranscribing();
    }
  };
  type Frame = { revision:number; at: number; value: Promise<{ reference: string; error: unknown }> };
  let frames: Frame[] = [],
    lastFrame: Frame | undefined;
  const visualBuffers = new Set<() => void>();
  let visualBusy = false;
  const cancelledFinals = new Set<() => void>();
  const blankFrame=():Frame=>({at:Date.now(),revision:screenshots.revision(),value:Promise.resolve({reference:"",error:null})});
  const frame = (): Frame => {
    if(!screenshots.enabled())return blankFrame();
    if (lastFrame && Date.now() - lastFrame.at < SCREEN_INTERVAL_MS) return lastFrame;
    const current = {
      revision:screenshots.revision(),at: Date.now(),
      value: options.snapshot().then(
        (reference) => ({ reference, error: null }),
        (error) => ({ reference: "", error }),
      ),
    };
    frames.push(current);
    lastFrame = current;
    return current;
  };
  const finalFrame = (): Promise<Frame> => {
    if(!screenshots.enabled())return Promise.resolve(blankFrame());
    const delay = lastFrame ? Math.max(0, SCREEN_INTERVAL_MS - (Date.now() - lastFrame.at)) : 0;
    if (!delay) return Promise.resolve(frame());
    return new Promise((resolve) => {
      const finish = (): void => {
        cancelledFinals.delete(cancel);
        resolve(discarded ? lastFrame??blankFrame() : frame());
      };
      const id = (options.timer ?? setTimeout)(finish, delay);
      const cancel = (): void => {
        if(options.clearTimer) options.clearTimer(id); else clearTimeout(id as ReturnType<typeof setTimeout>);
        cancelledFinals.delete(cancel);
        resolve(lastFrame??blankFrame());
      };
      cancelledFinals.add(cancel);
    });
  };
  screenshots.subscribe(()=>{
    frames=[];lastFrame=undefined;
    for(const discard of visualBuffers)discard();
    if(!screenshots.enabled())for(const cancel of cancelledFinals)cancel();
    else if(running&&!options.visualSnapshot)frame();
  });
  const schedule = (callback: () => void, ms: number): void => {
    const id = (options.timer ?? setTimeout)(() => {
      timers.delete(id);
      callback();
    }, ms);
    timers.add(id);
  };
  const clear = () => {
    for (const timer of timers) if(options.clearTimer) options.clearTimer(timer); else clearTimeout(timer as ReturnType<typeof setTimeout>);
    timers.clear();
  };
  const visualWindow = () => {
    const capture = options.visualSnapshot;
    if (!capture || !screenshots.enabled()) return undefined;
    const revision = screenshots.revision();
    const samples: string[] = [];
    let bytes = 0, previous = "", truncated = false, closed = false, failed = false;
    const started = options.monotonicNow?.() ?? performance.now();
    const allowed = () => screenshots.enabled() && screenshots.revision() === revision;
    const discard = () => { closed = true; previous = ""; samples.length = 0; };
    visualBuffers.add(discard);
    const sample = () => {
      if (closed || !running || !allowed() ||
          (options.monotonicNow?.() ?? performance.now()) - started >= VOICE_INTERVAL_MS) return;
      if (!visualBusy && !truncated) {
        visualBusy = true;
        void Promise.resolve().then(() => allowed() && !closed && running ? capture() : undefined).then(raw => {
          if (raw === undefined || !allowed() || closed) return;
          const payload = (JSON.parse(raw) as {base64?: string}).base64;
          if (!payload || payload === previous) return;
          if (bytes + raw.length > VISUAL_BUFFER_CHARS) { truncated = true; return; }
          bytes += raw.length;
          samples.push(raw);
          previous = payload;
        }).catch(() => { failed = true; }).finally(() => { visualBusy = false; });
      }
      schedule(sample, VISUAL_SAMPLE_INTERVAL_MS);
    };
    sample();
    return {
      revision,
      finish() { closed = true; },
      images: () => truncated ? [...samples, '{"truncated":true}'] : failed && !samples.length
        ? ['{"unavailable":true}'] : [...samples],
      release() { discard(); visualBuffers.delete(discard); },
    };
  };
  const stop = (discard = false): void => {
    attempt++;
    if (discard) {epoch++;options.cancelTranscription?.();
      for (const cancel of transcriptionWaiters.values()) cancel();
      transcriptionWaiters.clear();notifyTranscribing();
    }
    discarded = discarded || discard;
    running = false;
    starting = false;
    clear();
    if (discard) {
      for (const cancel of cancelledFinals) cancel();
      for (const clearBuffer of visualBuffers) clearBuffer();
    }
    for (const current of recorders) stopRecorder(current);
    recorders.clear();
    silenceWatch?.stop();
    silenceWatch = undefined;
    rotateOnSilence = undefined;
    mic?.stop(discard);
    mic = undefined;
    options.state(
      false,
      discard ? "Dictée interrompue." : "Micro arrêté ; dernier extrait en traitement.",
    );
  };
  const segment = (): void => {
    if (!running) return;
    const context=session;
    const acquired=mic;
    const watch = silenceWatch;
    const cancelled=()=>context.epoch!==epoch;
    const capturedAt=new Date().toISOString();
    const requestId=crypto.randomUUID();
    const voiceSelection=options.captureContext?.(capturedAt);
    const first = options.visualSnapshot ? blankFrame() : frame();
    const visual = visualWindow();
    requests.set(requestId,context);
    const current = acquired?.recorder?.() ?? options.recorder();
    let stoppedForSilence = false;
    let shouldTranscribe: boolean | undefined;
    let started:number|undefined;
    const monotonicNow=()=>options.monotonicNow?.()??performance.now();
    const finishSegment = () => {
      if(started===undefined)return;
      const startedMonotonicMs=started;
      const elapsedMs=Math.max(0,monotonicNow()-started);
      started=undefined;
      options.captureSegment?.({kind:'stop',requestId,capturedAt,durationMs:elapsedMs,elapsedMs,startedMonotonicMs,plannedDurationMs:VOICE_INTERVAL_MS+VOICE_OVERLAP_MS});
    };
    recorders.add(current);
    const parts: Blob[] = [];
    current.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    current.onerror = () => {
      if(context!==session)return;
      stop(true);
      void current.transcript?.catch((error: unknown) => {
        if(context===session)options.state(false,error instanceof Error ? error.message : String(error));
      });
    };
    current.onstop = () => {
      shouldTranscribe ??= !watch || watch.hasSpeech();
      finishSegment();
      const metadata:VoiceMetadata={capturedAt,requestId,...(acquired?.transcriptionProvider?{transcriptionProvider:acquired.transcriptionProvider}:{}),...(voiceSelection?{voiceSelection}:{})};
      recorders.delete(current);
      const finalCapture = cancelled() || !shouldTranscribe || options.visualSnapshot
        ? Promise.resolve(first)
        : stoppedForSilence ? Promise.resolve(lastFrame ?? first) : finalFrame();
      visual?.finish();
      const audio = new Blob(parts, { type: parts[0]?.type ?? "audio/webm" });
      pendingSegments++;
      options.processing?.(pendingSegments,"Transcription en attente…");
      queue = queue
        .then(async () => {
          if (cancelled() || !shouldTranscribe || (!audio.size && !current.transcript)) return;
          const last = await finalCapture;
          if (cancelled()) return;
          const shotsRevision=visual?.revision??screenshots.revision();
          const allowed=()=>screenshots.enabled()&&screenshots.revision()===shotsRevision&&last.revision===shotsRevision;
          const shots = options.visualSnapshot ? [] : await screenshotWork(Promise.all(
            voiceScreenshots(
              frames.filter((value) => value.revision===shotsRevision&&value.at >= first.at && value.at <= last.at),
            ).map((value) => value.value),
          ),screenshots,allowed,[]);
          if (allowed()&&shots.some((shot) => shot.error))
            throw Error("Capture indisponible : extrait non envoyé.");
          if (cancelled()) return;
          const raw = await (current.transcript ?? transcribe(audio,metadata));
          const text = watch ? raw.trim() : removeVoiceOverlap(context.previous, raw);
          context.previous = raw;
          if (cancelled()) return;
          if (text.trim()){
            requestScreenshots.set(requestId,shotsRevision);
            const images = visual?.images() ?? [...new Set(shots.map(shot => shot.reference).filter(Boolean))];
            await options.send(text, allowed()?images:[],metadata);
          }
          if(context===session)options.state(
            running,
            running
              ? watch ? "Micro actif · envoi après 2 s de silence" : "Micro actif · 30 s + 5 s de chevauchement"
              : "Dictée envoyée ; micro arrêté.",
          );
        })
        .catch((error) => {
          const note=error instanceof Error ? error.message : String(error);
          options.processing?.(pendingSegments,note);
          if(context===session)options.state(running,note);
        }).finally(()=>{frames=frames.filter(value=>value.at>=first.at);visual?.release();pendingSegments--;requests.delete(requestId);requestScreenshots.delete(requestId);options.processing?.(pendingSegments,pendingSegments?"Transcription en cours…":"");});
      stoppingRecorders.get(current)?.resolve();
      stoppingRecorders.delete(current);
      // Preserve all valid captured slices, but stop creating an ever-growing backlog.
      if (pendingSegments >= 2 && running && context===session) {
        stop(false);
        options.state(false,"Dictée en retard : micro arrêté, extraits conservés en traitement. Reprendre après leur envoi.");
      }
    };
    current.start();
    started=monotonicNow();
    options.captureSegment?.({kind:'start',requestId,capturedAt,durationMs:VOICE_INTERVAL_MS+VOICE_OVERLAP_MS,plannedDurationMs:VOICE_INTERVAL_MS+VOICE_OVERLAP_MS,elapsedMs:0,startedMonotonicMs:started});
    if (watch) {
      const rotate = (silence = false) => {
        if (!running || !recorders.has(current) || stoppingRecorders.has(current)) return;
        stoppedForSilence = silence;
        shouldTranscribe = watch.hasSpeech();
        watch.reset();
        clear();
        stopRecorder(current);
        segment();
      };
      rotateOnSilence = () => rotate(true);
      schedule(rotate, VOICE_INTERVAL_MS + VOICE_OVERLAP_MS);
      if (!options.visualSnapshot) {
        const sample = () => { frame(); schedule(sample, SCREEN_INTERVAL_MS); };
        schedule(sample, SCREEN_INTERVAL_MS);
      }
      return;
    }
    schedule(() => {
      if (recorders.has(current)) stopRecorder(current);
    }, VOICE_INTERVAL_MS + VOICE_OVERLAP_MS);
    schedule(() => segment(), VOICE_INTERVAL_MS);
  };
  return {
    active: () => running || starting,
    processing:()=>pendingSegments>0||stoppingRecorders.size>0,
    screenshotsAllowed:(requestId:string)=>screenshots.enabled()&&requestScreenshots.get(requestId)===screenshots.revision(),
    cancelled: (requestId?:string) => requestId ? requests.get(requestId)?.epoch!==epoch : discarded,
    stop,
    async start(): Promise<void> {
      if (running || starting) return;
      // Capture can restart while earlier slices remain serialized for transcription.
      starting = true;
      const revision=++attempt;
      discarded = false;
      session={epoch,previous:""};
      options.state(false, "Autorisation du microphone…");
      try {
        const acquired = await options.microphone();
        if (!starting || revision!==attempt) {
          acquired.stop();
          return;
        }
        mic = acquired;
        acquired.activate?.();
        starting = false;
        running = true;
        silenceWatch = acquired.watchSilence?.(() => rotateOnSilence?.());
        options.state(true, silenceWatch ? "Micro actif · envoi après 2 s de silence" : options.visualSnapshot
          ? screenshots.enabled() ? "Micro actif · écran par fenêtres de 30 s" : "Micro actif · partage écran désactivé"
          : "Micro actif · capture au début · 30 s + 5 s de chevauchement");
        segment();
        const sample = (): void => {
          if (!running) return;
          frame();
          schedule(sample, SCREEN_INTERVAL_MS);
        };
        if (!options.visualSnapshot && !silenceWatch) schedule(sample, SCREEN_INTERVAL_MS);
      } catch (error) {
        if(revision!==attempt)return;
        stop(true);
        options.state(false, error instanceof Error ? error.message : String(error));
      }
    },
    settled: async () => {
      while(stoppingRecorders.size)await Promise.all([...stoppingRecorders.values()].map(value=>value.promise));
      await queue;
    },
  };
}

export async function audioBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

