import type {VoiceCaptureSegment} from "./voice-input.js";
import { voiceChatController } from "./voice-chat-controller.js";
import { voiceScreenComposer, type VoiceScreenDraft } from "./voice-screen-composer.js";
import {
  type VoiceScreenshots,
  voiceScreenshotAttachments,
} from "./voice-screenshots.js";
import {
  selectedDictationProvider,
} from "./dictation-provider.js";
import { roomName } from "./room-name.js";

/** Each capture owns its target and epoch, including permission and transcription latency. */
export function forkVoice(options: {
  screenshots: VoiceScreenshots;
  visualSnapshot?(): Promise<string>;
  invoke(
    command: string,
    args: Record<string, unknown>,
  ): Promise<{ ok?: unknown; data?: unknown; error?: { message?: unknown } }>;
  importImage(raw: string): Promise<{ reference: string; capturedAt: string }>;
  send(id: number, text: string, voiceScreenRefs?: string[]): Promise<void>;
  recover(id: number, text: string): void;
  status(id: number, note: string): void;
  transcribing?(id: number, pending: number): void;
  captureSegment?(id:number,event:VoiceCaptureSegment):void;
  presentation?(recording: boolean, processing: boolean, starting: boolean): void;
}) {
  let controller: ReturnType<typeof voiceChatController> | undefined,
    target: number | undefined,
    busy = false, recording = false, pendingSegments = 0;
  const composers = new Map<number, ReturnType<typeof voiceScreenComposer>>();
  const clearComposers=()=>{for(const composer of composers.values())composer.clear();composers.clear();};
  options.screenshots.subscribe(clearComposers);
  const call = async (command: string, args: Record<string, unknown>) => {
    const r = await options.invoke(command, args);
    if (r.ok !== true)
      throw Error(
        typeof r.error?.message === "string"
          ? r.error.message
          : "Dictée refusée",
      );
    return r.data as { text?: string };
  };
  async function start(id: number) {
    if (busy || controller?.active()) return;
    target = id;
    busy = true;
    const provider = selectedDictationProvider(
      (
        document.getElementById(
          "chat-transcription-provider",
        ) as HTMLSelectElement | null
      )?.value,
    );
    const captured = id;
    const composer = composers.get(id) ?? voiceScreenComposer();
    if (options.visualSnapshot) composers.set(id, composer);
    const input = voiceChatController({
      owner: roomName(captured),
      provider: () => provider,
      invoke: call,
      screenshots: options.screenshots,
      ...(options.visualSnapshot ? { visualSnapshot: options.visualSnapshot } : {}),
      snapshot: async () =>
        JSON.stringify(await call("voice_input", { action: "snapshot" })),
      send: async (text, images, metadata) => {
        if (!text.trim() || input.cancelled(metadata.requestId)) return;
        let suffix = "";
        let draft: VoiceScreenDraft | undefined;
        const imageReferences: string[] = [];
        const allowed=()=>input.screenshotsAllowed(metadata.requestId)&&!input.cancelled(metadata.requestId);
        try {
          if (options.visualSnapshot && images.length) draft = await composer.compose(images, metadata.capturedAt, allowed);
          suffix = await voiceScreenshotAttachments(draft?.images ?? images, {
            control: options.screenshots,
            allowed,
            cancelled: () => input.cancelled(metadata.requestId),
            composed: !!draft,
            importImage: async raw => {
              const imported = await options.importImage(raw);
              if (draft) imageReferences.push(imported.reference);
              return imported;
            },
          });
          if (draft && allowed()) suffix=draft.references+suffix;
        } catch {
          draft=undefined;
          options.status(
            captured,
            "Captures indisponibles ; transcription conservée.",
          );
        }
        if (input.cancelled(metadata.requestId)) return;
        if (!allowed()) suffix="";
        const body = `[Dictée vocale]
${text}${suffix}`;
        // Fork send has no idempotency key: never retry automatically or truncate silently.
        if (body.length > 4000) {
          options.recover(captured, body);
          options.status(
            captured,
            "Transcription conservée en brouillon : dépasserait 4000 caractères.",
          );
          throw Error(
            "Transcription conservée en brouillon ; aucun envoi : limite de 4000 caractères.",
          );
        }
        try {
          if (suffix && imageReferences.length) await options.send(captured, body, imageReferences);
          else await options.send(captured, body);
          if (suffix) draft?.commit();
        } catch (error) {
          options.recover(captured, body);
          options.status(
            captured,
            `Échec ${roomName(captured)} : ${String(error)} · transcription en brouillon, aucun retry automatique`,
          );
          throw error;
        }
      },
      captureSegment: event => options.captureSegment?.(captured,event),
      transcribing: pending => options.transcribing?.(captured, pending),
      state: (active, note) => {
        recording = active;
        options.presentation?.(recording, pendingSegments > 0, !recording && input.active());
        options.status(captured, `${roomName(captured)} · ${note}`);
      },
      processing: (pending, note) => {
        pendingSegments = pending;
        options.presentation?.(recording, pending > 0, !recording && input.active());
        if (pending)
          options.status(captured, `${roomName(captured)} · ${note}`);
      },
    });
    controller = input;
    try {
      await input.start();
    } finally {
      if(controller === input) {
        busy = false;
        if (!input.active() && !input.processing()) {controller=undefined;target=undefined;options.presentation?.(false,false,false);}
      }
    }
  }
  async function stop(discard = false) {
    const previous = controller,
      stoppedTarget = target;
    if (discard) clearComposers();
    previous?.stop(discard);
    busy = true;
    try {
      await previous?.settled();
    } finally {
      if (controller === previous) {
        controller = undefined;
        target = undefined;
      }
      busy = false;
      options.presentation?.(false, false, false);
      if (stoppedTarget !== undefined)
        options.status(
          stoppedTarget,
          discard
            ? "Capture annulée ; aucun nouvel envoi après annulation."
            : "Micro arrêté ; extraits traités.",
        );
    }
  }
  return {
    start,
    stop,
    active: () => !!controller?.active(),
    target: () => target,
    busy: () => busy,
  };
}
