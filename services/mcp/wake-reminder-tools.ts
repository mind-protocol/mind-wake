/** Rappels martelés : consignes de l'humain réinjectées tous les `every` réveils pendant `hours` heures. */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  ackOneShotReminder,
  addReminder,
  oneShotDueLabel,
  readReminders,
  setOneShotReminder,
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
    "set_reminder",
    {
      description:
        "Set a one-shot reminder for yourself (the principal agent), delivered once: either in the wake-up message of wake N+in_wakes (in_wakes=1 = next wake), or, with in_minutes, pushed into the running session as soon as it falls due (or in the first wake after the due time). Give exactly one of in_wakes / in_minutes, and a one-line `why`. A delivered reminder keeps coming back as « en souffrance » at each wake until you call ack_reminder(id). Stored in the runtime data dir: survives restarts.",
      inputSchema: z.strictObject({
        text: z.string().trim().min(1).max(2000),
        why: z.string().trim().min(1).max(300).regex(/^[^\r\n]+$/, "why: one line"),
        in_wakes: z.number().int().min(1).max(10_000).optional(),
        in_minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
      }),
      annotations: { openWorldHint: false },
    },
    (a) =>
      reply(() => {
        const r = setOneShotReminder(dataDir, {
          text: a.text,
          why: a.why,
          inWakes: a.in_wakes,
          inMinutes: a.in_minutes,
          source: "set_reminder",
        });
        return {
          id: r.id,
          due: r.dueAt !== null ? { at: r.dueAt } : { wake: r.dueWake, inWakes: r.inWakes },
          label: oneShotDueLabel(r),
        };
      }),
  );
  server.registerTool(
    "ack_reminder",
    {
      description:
        "Acknowledge a one-shot reminder (set_reminder) once handled, so it stops coming back as « en souffrance ». On a not-yet-delivered reminder this cancels it.",
      inputSchema: z.strictObject({ id: z.string().min(1).max(100) }),
      annotations: { openWorldHint: false },
    },
    (a) => reply(() => ackOneShotReminder(dataDir, a.id)),
  );
  server.registerTool(
    "list_wake_reminders",
    {
      description:
        "List hammered wake reminders (including expired ones not yet pruned) and one-shot reminders (`oneShots`: pending, delivered, acknowledged).",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => readReminders(dataDir)),
  );
  server.registerTool(
    "remove_wake_reminder",
    {
      description: "Remove a hammered or one-shot reminder by id.",
      inputSchema: z.strictObject({ id: z.string().min(1).max(100) }),
      annotations: { openWorldHint: false },
    },
    (a) => reply(() => ({ removed: removeReminder(dataDir, a.id) })),
  );
}
