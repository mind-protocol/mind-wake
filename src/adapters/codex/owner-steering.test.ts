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
let dir: string;
let steering: CodexOwnerSteering | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-steer-"));
});
afterEach(() => {
  steering?.stop();
  steering = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});
const add = () =>
  enqueueOwnerMessage(dir, { id: "human-1", text: "pitche 2", at: new Date().toISOString() });
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
    steering = new CodexOwnerSteering(dir, "session", "thread", "turn", { request }, () => true);
    await steering.flush();
    await steering.flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(readOwnerReceipts(dir)).toEqual({});
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
