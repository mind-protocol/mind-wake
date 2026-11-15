import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ElevenLabs, speechSchema } from "../elevenlabs/service.js";

export function registerElevenLabsTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
) {
  const dir = env["MIND_WAKE_DATA_DIR"];
  if (!dir) return;
  const service = new ElevenLabs(dir);
  const run = async (work: () => unknown) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await work()) },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error &&
        /^(ElevenLabs |Wake |Configurer |Configuration |Clé API |Audio |Réponse audio )/.test(
          error.message,
        )
          ? error.message
          : "ElevenLabs: request failed; check connection and settings.";
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  };
  server.registerTool(
    "elevenlabs_list_voices",
    {
      description:
        "List configured ElevenLabs account voices (external data). Requires a key saved by the human in desktop Settings. Paginate using next_page_token.",
      inputSchema: z.strictObject({ cursor: z.string().max(2048).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ cursor }) => run(() => service.voices(cursor)),
  );
  server.registerTool(
    "speak_desktop",
    {
      description:
        "Speak a current short principal response through the configured ElevenLabs desktop voice. Returns immediately with generation: in_progress while audio is being generated in the background. Supply reply:<owner message id> as idempotency_key also used by automatic response reading. Sends only selected prose without rewriting. Never send human/peer/tool/history content. At most 1500 prose characters and 3 queued clips; no automatic paid retry. Respects Pause/Force-off.",
      inputSchema: z.strictObject({
        text: z.string().min(1).max(5000),
        idempotency_key: z.string().min(1).max(200),
        thread_id: z.string().min(1).max(128).optional(),
        agent_ref: z.string().min(1).max(128).optional(),
        cycle_id: z.string().min(1).max(128).optional(),
        expected_voice_revision:z.string().min(1).max(256).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) => run(() => service.queueDesktopSpeech(args)),
  );
  server.registerTool(
    "elevenlabs_generate_speech",
    {
      description:
        "Generate speech in the background using the selected ElevenLabs voice. Consumes account credits; requires human-enabled integration and authorized content. Returns generation: in_progress immediately. Playback is queued in the Wake desktop on success. Supply an idempotency_key to retrieve a completed MP3 on a subsequent call with the same input. Respects Pause/stop. No voice cloning or design.",
      inputSchema: speechSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    (args) => run(() => service.queueGeneration(args)),
  );
}
