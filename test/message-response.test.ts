import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { it, expect, vi } from "vitest";
import { seedSimulatedProfile } from "./demo/harness.js";
import { controlDbPath } from "../src/daemon/paths.js";
import * as voice from "../src/communication/fast-reply.js";
import { respondToLocalMessage } from "../src/communication/message-response.js";

it("paused messages get one tool-free reply, retain controls, and deduplicate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "message-response-"));
  const generate = vi.fn(async () => ({ text: "Observation vérifiable." }));
  const spy = vi.spyOn(voice, "agentTextCall").mockReturnValue(generate);
  try {
    seedSimulatedProfile(dir);
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
    const db = new Database(controlDbPath(dir));
    db.prepare("UPDATE profiles SET state='paused'").run();
    db.close();
    const input = { to: "principal", text: "Que sais-tu faire ?", author: "Codex", key: "test-question" };
    expect(await respondToLocalMessage(dir, input)).toMatchObject({ status: "answered" });
    expect(await respondToLocalMessage(dir, input)).toMatchObject({ status: "answered", duplicate: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBeUndefined();
    const args = generate.mock.calls[0] as unknown as [unknown, string[]];
    expect(args[1]).not.toContain("--mcp-config");
    const check = new Database(controlDbPath(dir));
    expect(check.prepare("SELECT state FROM profiles").get()).toMatchObject({ state: "paused" });
    check.prepare("UPDATE profiles SET state='disabled'").run();
    check.close();
    await expect(respondToLocalMessage(dir, { ...input, key: "disabled-question" })).rejects.toThrow("indisponible");
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
