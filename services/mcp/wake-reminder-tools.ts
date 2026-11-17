/** Rappels martelés : consignes de l'humain réinjectées tous les `every` réveils pendant `hours` heures. */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  addReminder,
  readReminders,
  removeReminder,
  DEFAULT_EVERY,
  DEFAULT_HOURS,
} from "../../src/daemon/wake-reminders.js";

export function registerWakeReminderTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const dataDir = env["MIND_WAKE_DATA_DIR"];
  if (!dataDir) return;
  const reply = (action: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(action()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "add_wake_reminder",
    {
      description: `Hammer a human instruction into the principal's wake-up message: injected every \`every\` wakes (default ${String(DEFAULT_EVERY)}), starting next wake, for \`hours\` hours (default ${String(DEFAULT_HOURS)}). Use only for instructions that come from NLR; cite the source.`,
      inputSchema: z.strictObject({
        text: z.string().trim().min(1).max(2000),
        every: z.number().int().min(1).max(1000).default(DEFAULT_EVERY),
        hours: z.number().positive().max(24 * 365).default(DEFAULT_HOURS),
        source: z.string().trim().min(1).max(300),
      }),
      annotations: { openWorldHint: false },
    },
    (a) => reply(() => addReminder(dataDir, a)),
  );
  server.registerTool(
    "list_wake_reminders",
    {
      description: "List hammered wake reminders (including expired ones not yet pruned).",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => readReminders(dataDir)),
  );
  server.registerTool(
    "remove_wake_reminder",
    {
      description: "Remove a hammered wake reminder by id.",
      inputSchema: z.strictObject({ id: z.string().min(1).max(100) }),
      annotations: { openWorldHint: false },
    },
    (a) => reply(() => ({ removed: removeReminder(dataDir, a.id) })),
  );
}
