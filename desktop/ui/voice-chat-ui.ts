import type { VoiceCaptureSegment } from "./voice-input.js";
/** Local presentation only: never a conversation entry or transport payload. */
export function voiceChatControls(button: HTMLButtonElement, cancel: HTMLButtonElement) {
  button.className = "voice-chat-button";
  cancel.className = "voice-chat-button voice-chat-cancel";
  button.type = cancel.type = "button";
  button.title =
    "Extrait toutes les 30 secondes, fenêtre audio de 35 secondes. Si l’écran est partagé, les changements inédits sont joints à la transcription.";
  cancel.textContent = "Annuler Voice";
  return (recording: boolean, processing: boolean, starting = false, unavailable = false) => {
    button.textContent = recording ? "⏹ Stop Voice" : processing ? "◌ Voice" : "🎙 Voice";
    button.setAttribute("aria-pressed", String(recording));
    button.setAttribute("aria-busy", String(starting));
    button.dataset["recording"] = String(recording);
    button.disabled = starting || (processing && !recording) || (unavailable && !recording);
    cancel.disabled = !(recording || processing || starting);
  };
}
/** A reserved line at the foot of the conversation; updates never touch messages/input/scroll. */
export function voiceTranscriptStatus(parent: HTMLElement, initialScope = "principal") {
  const status = document.createElement("div");
  status.className = "voice-transcript-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const rings = document.createElement("span"),
    label = document.createElement("span");
  rings.className = "voice-capture-rings";
  rings.setAttribute("aria-hidden", "true");
  status.append(rings, label);
  parent.append(status);
  let scope = initialScope;
  const captures = new Map<string, Map<string, VoiceCaptureSegment>>();
  const render = () => {
    rings.replaceChildren(
      ...[...(captures.get(scope)?.values() ?? [])].map((event) => {
        const ring = document.createElement("span");
        ring.className = "voice-capture-ring";
        ring.dataset["requestId"] = event.requestId;
        ring.title = "Extrait vocal · fenêtre audio 35 s";
        ring.setAttribute(
          "style",
          `--voice-segment-duration:${String(event.durationMs)}ms;--voice-segment-delay:-${String(Math.max(0, event.startedMonotonicMs === undefined ? Date.now() - Date.parse(event.capturedAt) : performance.now() - event.startedMonotonicMs))}ms`,
        );
        ring.innerHTML =
          '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><circle cx="10" cy="10" r="8" pathLength="100"/></svg>';
        return ring;
      }),
    );
  };
  const update = (pending: number) => {
    status.dataset["pending"] = String(pending > 0);
    label.textContent = pending > 0 ? "Transcription en cours…" : "";
  };
  return Object.assign(update, {
    segment: (target: string, event: VoiceCaptureSegment) => {
      const active = captures.get(target) ?? new Map<string, VoiceCaptureSegment>();
      captures.set(target, active);
      if (event.kind === "start") active.set(event.requestId, event);
      else active.delete(event.requestId);
      if (target === scope) render();
    },
    select: (target: string) => {
      scope = target;
      render();
    },
  });
}
