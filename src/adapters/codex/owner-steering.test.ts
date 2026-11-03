import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  enqueueOwnerMessage,
  readOwnerReceipts,
  takeOwnerMessages,
} from "../../communication/owner-inbox.js";
import { CodexOwnerSteering } from "./owner-steering.js";
import { OwnerMessages } from "../../communication/owner-messages.js";
import { OwnerProgressReminder, PROGRESS_REMINDER } from "../../communication/owner-progress-reminder.js";
let dir: string;
let steering: CodexOwnerSteering | undefined;
let progress: OwnerProgressReminder | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-steer-"));
});
afterEach(() => {
  steering?.stop();
  steering = undefined;
  progress?.close();
  progress = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});
const add = () =>
  enqueueOwnerMessage(dir, { id: "human-1", text: "pitche 2", at: new Date().toISOString() });
function queueProgress(): void {
  const messages = new OwnerMessages(dir, "agent");
  try { messages.publish("Bonjour", "hello", new Date(Date.now() - 60_001).toISOString()); }
  finally { messages.close(); }
  progress = new OwnerProgressReminder(dir, () => true);
  progress.tick();
}
it("steers one private progress reminder, giving human messages priority", async () => {
  queueProgress(); add();
  const request = vi.fn(async () => ({turnId: "turn"}));
  steering = new CodexOwnerSteering(dir, "session", "thread", "turn", {request}, () => true);
  await steering.flush();
  expect(JSON.stringify(request.mock.calls[0])).toContain("human-1");
  await steering.flush();
  expect(request).toHaveBeenLastCalledWith("turn/steer", expect.objectContaining({
    input: [{type: "text", text: PROGRESS_REMINDER}],
  }));
  progress!.tick(); await steering.flush();
  expect(request).toHaveBeenCalledTimes(2);
  expect(readOwnerReceipts(dir)).toHaveProperty("human-1");
  expect(Object.keys(readOwnerReceipts(dir))).toHaveLength(1);
});
it("retains a reminder for the next runtime when steering fails", async () => {
  queueProgress();
  const request = vi.fn(async () => { throw Error("unsupported"); });
  steering = new CodexOwnerSteering(dir, "session", "thread", "turn", {request}, () => true);
  await steering.flush();
  steering = new CodexOwnerSteering(dir, "next-session", "thread", "next-turn",
    {request: async () => ({turnId: "next-turn"})}, () => true);
  await steering.flush();
  expect(request).toHaveBeenCalledTimes(1);
});
it("acknowledges delivery only when the active turn accepts the message", async () => {
  add();
  let resolve!: (value: Record<string, unknown>) => void;
  const request = vi.fn(
    () =>
      new Promise<Record<string, unknown>>((r) => {
        resolve = r;
      }),
  );
  steering = new CodexOwnerSteering(dir, "session", "thread", "turn", { request }, () => true);
  const sending = steering.flush();
  expect(readOwnerReceipts(dir)).toEqual({});
  await steering.flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "turn/steer",
    expect.objectContaining({ expectedTurnId: "turn", threadId: "thread" }),
  );
  resolve({ turnId: "turn" });
  await sending;
  expect(readOwnerReceipts(dir)["human-1"]).toBeTruthy();
  await steering.flush();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(["unsupported", "wrong-turn", "missing-ack"])(
  "retains an undelivered message on %s",
  async (mode) => {
    add();
    const request = vi.fn(async () => {
      if (mode === "unsupported") throw Error("unsupported");
      return mode === "wrong-turn" ? { turnId: "other" } : {};
    });
    const deferred = vi.fn();
    steering = new CodexOwnerSteering(
      dir,
      "session",
      "thread",
      "turn",
      { request },
      () => true,
      deferred,
    );
    await steering.flush();
    await steering.flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(readOwnerReceipts(dir)).toEqual({});
    expect(deferred).toHaveBeenCalledTimes(1);
    expect(takeOwnerMessages(dir, "next").map((m) => m.id)).toEqual(["human-1"]);
  },
);
it("does not consume a message after cancellation or a late acknowledgement", async () => {
  add();
  let resolve!: (value: Record<string, unknown>) => void;
  steering = new CodexOwnerSteering(
    dir,
    "session",
    "thread",
    "turn",
    {
      request: () =>
        new Promise<Record<string, unknown>>((r) => {
          resolve = r;
        }),
    },
    () => true,
  );
  const sending = steering.flush();
  steering.stop();
  resolve({ turnId: "turn" });
  await sending;
  expect(readOwnerReceipts(dir)).toEqual({});
  expect(takeOwnerMessages(dir, "next")).toHaveLength(1);
});
it("never steers an inactive turn", async () => {
  add();
  const request = vi.fn(async () => ({ turnId: "turn" }));
  steering = new CodexOwnerSteering(dir, "session", "thread", "turn", { request }, () => false);
  await steering.flush();
  expect(request).not.toHaveBeenCalled();
  expect(readOwnerReceipts(dir)).toEqual({});
});

it("steers screenshot bytes as an image block, including after waiting in the queue", async () => {
  enqueueOwnerMessage(dir, {
    id: "screen",
    at: "2026-01-01T00:00:00Z",
    text: "Regarde",
    image: {
      mediaType: "image/jpeg",
      base64: "/9j/2Q==",
      capturedAt: "2026-01-01T00:00:00Z",
      width: 10,
      height: 10,
      surface: "primary",
    },
  });
  const request = vi.fn(async () => ({ turnId: "turn" }));
  steering = new CodexOwnerSteering(dir, "session", "thread", "turn", { request }, () => true);
  await steering.flush();
  expect(request).toHaveBeenCalledWith(
    "turn/steer",
    expect.objectContaining({
      input: expect.arrayContaining([{ type: "image", url: "data:image/jpeg;base64,/9j/2Q==" }]),
    }),
  );
  expect(readOwnerReceipts(dir)["screen"]).toBeTruthy();
});
