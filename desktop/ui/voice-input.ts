export const VOICE_INTERVAL_MS = 20_000;
export const VOICE_OVERLAP_MS = 5_000;
export const SCREEN_INTERVAL_MS = 10_000;
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
export type VoiceRecorder = Pick<
  MediaRecorder,
  "start" | "stop" | "ondataavailable" | "onstop" | "onerror"
>;
interface Options {
  microphone(): Promise<{ stop(): void }>;
  recorder(): VoiceRecorder;
  snapshot(): Promise<string>;
  transcribe(audio: Blob): Promise<string>;
  send(text: string, images: string[]): Promise<void>;
  state(recording: boolean, note: string): void;
  timer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(id: ReturnType<typeof setTimeout>): void;
}
/** Independent complete audio files per slice; capture belongs to the slice's start. */
export function voiceInput(options: Options) {
  let running = false,
    starting = false,
    discarded = false;
  let mic: { stop(): void } | undefined;
  const recorders = new Set<VoiceRecorder>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let previous = "";
  let queue = Promise.resolve();
  type Frame = { at: number; value: Promise<{ reference: string; error: unknown }> };
  let frames: Frame[] = [],
    lastFrame: Frame | undefined;
  const cancelledFinals = new Set<() => void>();
  const frame = (): Frame => {
    if (lastFrame && Date.now() - lastFrame.at < SCREEN_INTERVAL_MS) return lastFrame;
    const current = {
      at: Date.now(),
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
    const delay = lastFrame ? Math.max(0, SCREEN_INTERVAL_MS - (Date.now() - lastFrame.at)) : 0;
    if (!delay) return Promise.resolve(frame());
    return new Promise((resolve) => {
      const finish = (): void => {
        cancelledFinals.delete(cancel);
        resolve(discarded ? lastFrame! : frame());
      };
      const id = (options.timer ?? setTimeout)(finish, delay);
      const cancel = (): void => {
        (options.clearTimer ?? clearTimeout)(id);
        cancelledFinals.delete(cancel);
        resolve(lastFrame!);
      };
      cancelledFinals.add(cancel);
    });
  };
  const schedule = (callback: () => void, ms: number): void => {
    const id = (options.timer ?? setTimeout)(() => {
      timers.delete(id);
      callback();
    }, ms);
    timers.add(id);
  };
  const clear = () => {
    for (const timer of timers) (options.clearTimer ?? clearTimeout)(timer);
    timers.clear();
  };
  const stop = (discard = false): void => {
    discarded = discarded || discard;
    running = false;
    starting = false;
    clear();
    if (discard) for (const cancel of cancelledFinals) cancel();
    for (const current of recorders) current.stop();
    recorders.clear();
    mic?.stop();
    mic = undefined;
    options.state(
      false,
      discard ? "Dictée interrompue." : "Micro arrêté ; dernier extrait en traitement.",
    );
  };
  const segment = (): void => {
    if (!running) return;
    const first = frame();
    const current = options.recorder();
    recorders.add(current);
    const parts: Blob[] = [];
    current.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    current.onerror = () => stop(true);
    current.onstop = () => {
      recorders.delete(current);
      const finalCapture = discarded ? Promise.resolve(first) : finalFrame();
      const audio = new Blob(parts, { type: parts[0]?.type ?? "audio/webm" });
      queue = queue
        .then(async () => {
          if (discarded || !audio.size) return;
          const last = await finalCapture;
          if (discarded) return;
          const shots = await Promise.all(
            voiceScreenshots(
              frames.filter((value) => value.at >= first.at && value.at <= last.at),
            ).map((value) => value.value),
          );
          if (shots.some((shot) => shot.error))
            throw Error("Capture indisponible : extrait non envoyé.");
          const raw = await options.transcribe(audio);
          const text = removeVoiceOverlap(previous, raw);
          previous = raw;
          if (discarded) return;
          if (text.trim())
            await options.send(text, [...new Set(shots.map((shot) => shot.reference))]);
          frames = frames.filter((value) => value.at >= first.at);
          options.state(
            running,
            running
              ? "Micro actif · 20 s + 5 s de chevauchement"
              : "Dictée envoyée ; micro arrêté.",
          );
        })
        .catch((error) => {
          options.state(running, error instanceof Error ? error.message : String(error));
        });
    };
    current.start();
    schedule(() => {
      if (recorders.has(current)) current.stop();
    }, VOICE_INTERVAL_MS + VOICE_OVERLAP_MS);
    schedule(() => segment(), VOICE_INTERVAL_MS);
  };
  return {
    active: () => running || starting,
    cancelled: () => discarded,
    stop,
    async start(): Promise<void> {
      if (running || starting) return;
      // Complete prior slices before reusing the session cancellation flag.
      starting = true;
      await queue;
      if (!starting) return;
      discarded = false;
      previous = "";
      options.state(false, "Autorisation du microphone…");
      try {
        const acquired = await options.microphone();
        if (!starting) {
          acquired.stop();
          return;
        }
        mic = acquired;
        starting = false;
        running = true;
        options.state(true, "Micro actif · capture au début · 20 s + 5 s de chevauchement");
        segment();
        const sample = (): void => {
          if (!running) return;
          frame();
          schedule(sample, SCREEN_INTERVAL_MS);
        };
        schedule(sample, SCREEN_INTERVAL_MS);
      } catch (error) {
        stop(true);
        options.state(false, error instanceof Error ? error.message : String(error));
      }
    },
    settled: () => queue,
  };
}

export async function audioBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
