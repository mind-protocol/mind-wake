import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileConversationStore } from "./conversation.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-conversations-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileConversationStore", () => {
  it("relit la consommation du dernier réveil et la dernière demande de compaction", () => {
    const store = new FileConversationStore(path.join(dir, "conversations.json"));
    store.put({
      key: "k",
      generation: 2,
      started: true,
      promptDigest: "abc",
      lastWakeTokens: 7_811_474,
      lastCompactRequest: "compact-1",
    });
    expect(new FileConversationStore(path.join(dir, "conversations.json")).get("k")).toEqual({
      key: "k",
      generation: 2,
      started: true,
      promptDigest: "abc",
      lastWakeTokens: 7_811_474,
      lastCompactRequest: "compact-1",
    });
  });

  it("ignore des champs facultatifs mal formés sans perdre le reste", () => {
    const file = path.join(dir, "conversations.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        k: {
          key: "k",
          generation: 0,
          started: true,
          promptDigest: null,
          lastWakeTokens: "beaucoup",
        },
      }),
    );
    expect(new FileConversationStore(file).get("k")).toEqual({
      key: "k",
      generation: 0,
      started: true,
      promptDigest: null,
    });
  });
});
