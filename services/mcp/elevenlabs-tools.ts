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
      return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] };
    } catch (error) {
      const message =
        error instanceof Error &&
        /^(ElevenLabs |Wake |Configurer |Configuration |Clé API |Audio |Réponse audio )/.test(
          error.message,
        )
          ? error.message
          : "ElevenLabs: request failed; check connection and settings.";
      return { isError: true, content: [{ type: "text" as const, text: message }] };
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
    "elevenlabs_generate_speech",
    {
      description:
        "Send text to ElevenLabs and generate speech using the selected default voice or voice_id. Consumes account credits; requires human-enabled integration and authorized content. Returns a local MP3 and queues playback in the Wake desktop when available. Queued does not mean heard. Respects Pause/stop. No voice cloning or design.",
      inputSchema: speechSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    (args) => run(() => service.generate(args)),
  );
}
