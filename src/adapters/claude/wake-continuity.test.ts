import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { wakeConversationKey } from "./registration.js";

it("reprend une clé stable sans expérience et conserve l’ancrage d’un fil existant", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-continuity-"));
  try {
    expect(wakeConversationKey(dir, null)).toBe("wake-default");
    expect(wakeConversationKey(dir, null)).toBe("wake-default");
    fs.writeFileSync(
      path.join(dir, "default-conversation.json"),
      JSON.stringify({ key: "previous-session" }),
    );
    expect(wakeConversationKey(dir, null)).toBe("previous-session");
    expect(wakeConversationKey(dir, "chosen-experiment")).toBe("chosen-experiment");
    fs.writeFileSync(path.join(dir, "default-conversation.json"), "{}");
    expect(() => wakeConversationKey(dir, null)).toThrow("Invalid default Wake conversation key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
