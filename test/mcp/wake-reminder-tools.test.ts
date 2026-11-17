/**
 * Outils MCP des rappels (mandat NLR du 17 nov. 2026, 19:34Z) : `set_reminder`, `ack_reminder`,
 * `list_wake_reminders`. Serveur simulé : schéma d'entrée (exactement un délai, `why` d'une
 * ligne) et réponse (id + échéance).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWakeReminderTools } from "../../services/mcp/wake-reminder-tools.js";
import { takeWakeReminders } from "../../src/daemon/wake-reminders.js";

type Handler = (a: Record<string, unknown>) => { isError?: boolean; content: { text: string }[] };
interface Tool {
  config: { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } };
  cb: Handler;
}

let dir: string;
let tools: Map<string, Tool>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-reminder-tools-"));
  tools = new Map();
  const server = {
    registerTool: (name: string, config: Tool["config"], cb: Handler) => tools.set(name, { config, cb }),
  } as unknown as McpServer;
  registerWakeReminderTools(server, { MIND_WAKE_DATA_DIR: dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): unknown {
  const tool = tools.get(name)!;
  const parsed = tool.config.inputSchema.safeParse(args);
  if (!parsed.success) return { schemaError: true };
  const out = tool.cb(parsed.data as Record<string, unknown>);
  return { isError: out.isError === true, ...(JSON.parse(out.content[0]!.text) as object) };
}

describe("outils MCP set_reminder / ack_reminder", () => {
  it("enregistrés avec les outils martelés", () => {
    expect([...tools.keys()]).toEqual([
      "add_wake_reminder",
      "set_reminder",
      "ack_reminder",
      "list_wake_reminders",
      "remove_wake_reminder",
    ]);
  });

  it("pose en réveils et en minutes : id + échéance", () => {
    takeWakeReminders(dir, 20);
    expect(call("set_reminder", { text: "t", why: "w", in_wakes: 2 })).toMatchObject({
      isError: false,
      id: expect.stringMatching(/^ponctuel-/),
      due: { wake: 22, inWakes: 2 },
      label: "le réveil n° 22",
    });
    const m = call("set_reminder", { text: "t", why: "w", in_minutes: 15 }) as { due: { at: string } };
    expect(Date.parse(m.due.at) - Date.now()).toBeGreaterThan(14 * 60_000);
    const list = call("list_wake_reminders", {}) as { oneShots: unknown[] };
    expect(list.oneShots).toHaveLength(2);
  });

  it("refus : ni délai, les deux, why absent ou multiligne, délai non entier", () => {
    expect(call("set_reminder", { text: "t", why: "w" })).toMatchObject({ isError: true });
    expect(call("set_reminder", { text: "t", why: "w", in_wakes: 1, in_minutes: 1 })).toMatchObject({ isError: true });
    expect(call("set_reminder", { text: "t", in_wakes: 1 })).toEqual({ schemaError: true });
    expect(call("set_reminder", { text: "t", why: "a\nb", in_wakes: 1 })).toEqual({ schemaError: true });
    expect(call("set_reminder", { text: "t", why: "w", in_minutes: 0 })).toEqual({ schemaError: true });
    expect(call("set_reminder", { text: "t", why: "w", in_wakes: 1.5 })).toEqual({ schemaError: true });
  });

  it("ack_reminder", () => {
    takeWakeReminders(dir, 1);
    const { id } = call("set_reminder", { text: "t", why: "w", in_wakes: 1 }) as { id: string };
    takeWakeReminders(dir, 2);
    expect(call("ack_reminder", { id })).toEqual({ isError: false, acked: true, wasDelivered: true });
    expect(takeWakeReminders(dir, 3).block).toBe("");
  });
});
