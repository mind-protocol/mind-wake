import { ElevenLabs } from "./service.js";
import { resolveDataDir } from "../../src/cli/paths.js";
import { processContext } from "../../src/cli/context.js";
import * as z from "zod";

try {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 16384) throw Error("Entrée trop longue.");
  }
  const input = z
    .object({
      action: z.enum([
        "status",
        "configure",
        "voices",
        "pending",
        "audio",
        "ack",
        "generate",
        "speak_desktop",
        "claim",
        "event",
        "enable_pending",
        "transcribe",
        "stt_preflight",
        "realtime_transcription_token",
        "cancel_transcription",
        "configure_transcription",
        "voice_mode_state",
      ]),
      payload: z.unknown().optional(),
    })
    .parse(JSON.parse(text));
  const service = new ElevenLabs(
    resolveDataDir(processContext(), undefined).path,
  );
  let data: unknown;
  switch (input.action) {
    case "voice_mode_state":
      data=service.voiceModeState(input.payload);
      break;
    case "status":
      data = service.status();
      break;
    case "configure":
      data = service.configure(input.payload);
      break;
    case "voices":
      data = await service.voices(
        input.payload == null ? undefined : z.string().parse(input.payload),
      );
      break;
    case "pending":
      data = service.pending();
      break;
    case "audio":
      data = service.audio(z.uuid().parse(input.payload));
      break;
    case "ack":
      data = service.acknowledge(z.uuid().parse(input.payload));
      break;
    case "speak_desktop":
      data = await service.speakDesktop(input.payload);
      break;
    case "claim":
      data = service.claim(z.uuid().parse(input.payload));
      break;
    case "enable_pending":
      data = service.enablePending(z.uuid().parse(input.payload));
      break;
    case "stt_preflight":
      data = await service.transcriptionPermission();
      break;
    case "realtime_transcription_token":
      data = await service.realtimeTranscriptionToken();
      break;
    case "cancel_transcription":
      data = service.cancelTranscription(z.string().parse(input.payload));
      break;
    case "configure_transcription":
      data = service.configureTranscription(z.boolean().parse(input.payload));
      break;
    case "transcribe":
      data = await service.transcribeDesktop(input.payload);
      break;
    case "event": {
      const event = z
        .strictObject({ id: z.uuid(), phase: z.string() })
        .parse(input.payload);
      data = service.event(event.id, event.phase);
      break;
    }
    case "generate":
      data = await service.generate(input.payload);
      break;
  }
  process.stdout.write(JSON.stringify({ ok: true, data }));
} catch (error) {
  // Provider/network exceptions can contain request headers. Do not expose their details.
  const message =
    error instanceof Error &&
    /^(ElevenLabs |Wake |Configurer |Configuration |Clé API |Audio |Réponse audio )/.test(
      error.message,
    )
      ? error.message
      : "ElevenLabs : appel échoué. Vérifier la connexion et les réglages.";
  process.stdout.write(JSON.stringify({ ok: false, error: { message } }));
  process.exitCode = 1;
}
