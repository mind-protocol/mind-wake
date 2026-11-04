import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelegramBridge, chunks } from "./bridge.mjs";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"));
  const sent = [],
    received = [];
  let items = [],
    updates = [],
    active = true;
  const options = {
    dataDir,
    username: "nlr_ai",
    ownerId: 1864364329,
    api: {
      call: async (method, input) => {
        if (method === "getUpdates") return updates;
        sent.push({ method, input });
        return {};
      },
      voice: async () => Buffer.from("audio"),
      sendVoice: async () => sent.push({ method: "sendVoice" }),
    },
    readThread: async () => items,
    receive: async (text, id) => received.push({ text, id }),
    transcribe: async () => "Bonjour",
    speak: async () => Buffer.from("voice"),
    active: () => active,
  };
  const bridge = new TelegramBridge(options);
  return {
    bridge,
    options,
    sent,
    received,
    setItems: (value) => {
      items = value;
    },
    setUpdates: (value) => {
      updates = value;
    },
    pause: () => {
      active = false;
    },
    cleanup: () => {
      bridge.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
const message = (id = 1, extra = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: 1864364329, type: "private" },
    from: { id: 1864364329, username: "nlr_ai" },
    text: "Salut",
    ...extra,
  },
});
test("pinned owner only; private messages and voice transcription keep deterministic ids", async () => {
  const f = fixture();
  try {
    f.setUpdates([
      message(1, { from: { id: 12, username: "nlr_ai" } }),
      message(2, { chat: { id: 1864364329, type: "group" } }),
      message(3),
      message(4, { text: undefined, voice: { file_id: "abc" } }),
    ]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 2);
    assert.equal(f.received[0].id, "tg-1864364329-3");
    assert.match(f.received[1].text, /Bonjour/);
    assert.equal(f.bridge.get("offset"), "5");
  } finally {
    f.cleanup();
  }
});
test("baseline, thread types except activity, restart dedup, edits, and no Telegram input echo", async () => {
  const f = fixture();
  try {
    f.setItems([{ from: "agent", id: "old", at: "now", text: "old" }]);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 0);
    f.setItems(
      ["agent", "session", "activity", "received", "context", "sent", "objective", "plan", "human"]
        .map((from) => ({ from, id: from, at: "now", text: "new" }))
        .concat([{ from: "human", id: "tg-1", at: "now", text: "echo" }]),
    );
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 16);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 16);
    f.bridge.close();
    const reopened = new TelegramBridge(f.options);
    await reopened.outgoing();
    reopened.close();
    assert.equal(f.sent.length, 16);
    f.bridge = new TelegramBridge(f.options);
    f.setItems([{ from: "agent", id: "agent", at: "now", text: "edited" }]);
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 18);
  } finally {
    f.bridge.close();
    f.cleanup();
  }
});
test("failed delivery does not advance incoming offset; outgoing audio retry does not resend text", async () => {
  const f = fixture();
  try {
    await f.bridge.outgoing();
    f.setItems([{ from: "agent", id: "a", text: "hello" }]);
    f.bridge.speak = async () => {
      throw Error("failed");
    };
    await assert.rejects(() => f.bridge.outgoing());
    assert.equal(f.sent.length, 1);
    f.bridge.speak = async () => Buffer.from("ok");
    await f.bridge.outgoing();
    assert.equal(f.sent.length, 2);
    f.setUpdates([message()]);
    f.bridge.receive = async () => {
      throw Error("failed");
    };
    await assert.rejects(() => f.bridge.incoming());
    assert.equal(f.bridge.get("offset"), undefined);
    f.pause();
    await f.bridge.outgoing();
    await f.bridge.incoming();
    assert.equal(f.sent.length, 2);
  } finally {
    f.cleanup();
  }
});
test("chunks preserve non-BMP characters and bound Telegram text size", () => {
  const text = "😀".repeat(4001);
  const parts = chunks(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((p) => p.length <= 3900));
});

test("an unintelligible voice reports failure and does not block later text", async () => {
  const f = fixture();
  try {
    f.bridge.transcribe = async () => {
      throw Error("no speech");
    };
    f.setUpdates([message(1, { text: undefined, voice: { file_id: "silent" } }), message(2)]);
    await f.bridge.incoming();
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].id, "tg-1864364329-2");
    assert.match(f.sent[0].input.text, /pas pu être transcrit/);
    assert.equal(f.bridge.get("offset"), "3");
  } finally {
    f.cleanup();
  }
});
