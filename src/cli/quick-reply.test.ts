import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedSimulatedProfile } from "../../test/demo/harness.js";
import { processContext } from "./context.js";
import { reply, readReplies } from "./commands/messages.js";
import { claimOwnerMessages, enqueueOwnerMessage, ownerMessagePending } from "../communication/owner-inbox.js";
import type { WakeImage } from "../contracts/wake-image.js";
import { runCli } from "./run.js";
import { recordDaemonStart } from "../daemon/runs.js";
import { recordOwnerAttachmentRuntime } from "../communication/owner-attachment-runtime.js";
import type { AdapterId, ProfileId, UtcTimestamp } from "../contracts/index.js";
import { freshTargetedClick, pointReplyText } from "./point-context.js";
import { BUMPE_CONTEXT_RESERVE, pointBumpText } from "../../desktop/ui/point-bump.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quick-reply-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const location = () => ({ path: dir, source: "option" as const });
const pointEnv = (x="920", y="81", at=Date.now()) => ({MIND_WAKE_CAPTURE_CLICK_X:x,MIND_WAKE_CAPTURE_CLICK_Y:y,MIND_WAKE_CAPTURE_CLICK_AT_MS:String(at),MIND_WAKE_CAPTURE_CLICK_ROOT:"42"});
const context = (text = "Explique cet écran") => ({
  ...processContext(),
  readStdin: () => Promise.resolve(text),
});
const seed = () => {
  seedSimulatedProfile(dir, {
    runtimeAdapterId: "codex",
    hostUnsandboxed: true,
    runtime: { nativeCapabilities: true },
  });
};
const capture = () =>
  vi.fn((): Promise<WakeImage> =>
    Promise.resolve({
      mediaType: "image/jpeg",
      base64: "/9j/2Q==",
      capturedAt: new Date().toISOString(),
      width: 20,
      height: 20,
      surface: "primary",
    }),
  );
it("captures once, persists message plus image, and retries without another capture", async () => {
  seed();
  const grab = capture();
  const first = await reply(context(), location(), "quick-test-1", true, grab);
  expect(first.exitCode).toBe(0);
  expect(first.data.reply?.screenshotAt).toBeTruthy();
  const duplicate = await reply(context(), location(), "quick-test-1", true, grab);
  expect(duplicate.data.status).toBe("duplicate");
  expect(grab).toHaveBeenCalledTimes(1);
  expect(readReplies(location())).toHaveLength(1);
  expect(claimOwnerMessages(dir, "session", "claim")[0]?.image?.base64).toBe("/9j/2Q==");
  expect(fs.readFileSync(path.join(dir, "human-messages.jsonl"), "utf8")).not.toContain("/9j/2Q==");
});
it("does not send text alone when capture fails", async () => {
  seed();
  const result = await reply(context(), location(), "quick-test-2", true, () =>
    Promise.resolve(undefined),
  );
  expect(result.exitCode).not.toBe(0);
  expect(readReplies(location())).toEqual([]);
  expect(ownerMessagePending(dir)).toBe(false);
});
it("requires a live old daemon to restart before accepting image messages", async () => {
  seed();
  const ctx = context();
  const store = ctx.openStore(dir, "write");
  try {
    if (store.db === undefined) throw new Error("SQLite required");
    recordDaemonStart(store.db, {
      id: "old-run",
      profileId: "default" as ProfileId,
      pid: process.pid,
      mode: "real",
      adapterId: "codex" as AdapterId,
      startedAt: new Date().toISOString() as UtcTimestamp,
      endedAt: null,
      endReason: null,
    });
  } finally {
    store.close();
  }
  const grab = capture();
  expect((await reply(ctx, location(), "quick-version", true, grab)).data.detail).toContain(
    "redémarré",
  );
  expect(grab).not.toHaveBeenCalled();
  recordOwnerAttachmentRuntime(dir, "old-run");
  expect((await reply(ctx, location(), "quick-version", true, grab)).exitCode).toBe(0);
});
it("rejects empty input and unsupported runtimes before taking a screenshot", async () => {
  seedSimulatedProfile(dir);
  const grab = capture();
  expect((await reply(context(" "), location(), "quick-empty", true, grab)).exitCode).not.toBe(0);
  expect((await reply(context(), location(), "quick-unsupported", true, grab)).exitCode).not.toBe(
    0,
  );
  expect(grab).not.toHaveBeenCalled();
});
it("queues a screenshot during Pause without resuming the profile", async () => {
  seed();
  const ctx = { ...context(), stdout: () => {}, stderr: () => {} };
  expect(await runCli(["pause", "--data-dir", dir], ctx)).toBe(0);
  expect((await reply(ctx, location(), "quick-paused", true, capture())).exitCode).toBe(0);
  const store = ctx.openStore(dir, "read");
  try {
    expect(
      store.uow.profiles.get("default" as import("../contracts/index.js").ProfileId)?.state,
    ).toBe("paused");
  } finally {
    store.close();
  }
  expect(ownerMessagePending(dir)).toBe(true);
});

it("carries the authentic physical point, keeps its marked image, and deduplicates the whole targeted invitation", async () => {
  seed();
  const ctx = {...context("BUMP: proposition ciblée, avec son contexte et sa valeur"), env:pointEnv()};
  const grab = capture();
  const first = await reply(ctx, location(), "ui-bumpe-point-1", true, grab);
  expect(first.exitCode).toBe(0);
  expect(first.data.reply?.text).toContain("(920, 81)");
  expect(first.data.reply?.text).toContain("ne donnent aucune permission");
  expect((await reply(ctx, location(), "ui-bumpe-point-1", true, grab)).data.status).toBe("duplicate");
  expect(grab).toHaveBeenCalledTimes(1);
  const inbox = claimOwnerMessages(dir, "session", "claim");
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.image?.base64).toBe("/9j/2Q==");
  expect(inbox[0]?.text).toContain("cercle rouge");
  const moved = {...ctx, env:{...ctx.env,MIND_WAKE_CAPTURE_CLICK_X:"921"}};
  expect((await reply(moved, location(), "ui-bumpe-point-1", true, grab)).exitCode).not.toBe(0);
});

it("refuses a failed point capture before inbox and never invents missing coordinates", async () => {
  seed();
  const ctx = {...context("BUMP: ciblé"), env:pointEnv("-1920","5")};
  const failed = await reply(ctx, location(), "ui-bumpe-capture-error", true, () => Promise.resolve(undefined));
  expect(failed.exitCode).not.toBe(0);
  expect(readReplies(location())).toEqual([]);
  expect(ownerMessagePending(dir)).toBe(false);
  expect(pointReplyText("BUMP: libre", {})).toBe("BUMP: libre");
  expect(pointReplyText("BUMP: libre", {MIND_WAKE_CAPTURE_CLICK_X:"garbage",MIND_WAKE_CAPTURE_CLICK_Y:"5"})).toBe("BUMP: libre");
});

it("rejects targeted Bumpe without its native point while leaving ordinary Parler text and length intact", async () => {
  seed();
  const grab = capture();
  expect((await reply({...context("BUMP: ciblé"),env:{}}, location(), "ui-bumpe-no-point", true, grab)).exitCode).not.toBe(0);
  expect(grab).not.toHaveBeenCalled();
  const text = "a".repeat(4000);
  const ctx = {...context(text),env:{MIND_WAKE_CAPTURE_CLICK_X:"920",MIND_WAKE_CAPTURE_CLICK_Y:"81"}};
  const normal = await reply(ctx, location(), "quick-normal-point", true, grab);
  expect(normal.exitCode).toBe(0);
  expect(normal.data.reply?.text).toBe(text);
});

it("rejects a stale click before capture but reconciles a persisted send with its original timestamp", async () => {
  seed();
  const env = pointEnv("20","30",Date.now()-60_000);
  const input = "BUMP: contexte daté";
  const ctx = {...context(input),env};
  const grab = capture();
  expect((await reply(ctx,location(),"ui-bumpe-old",true,grab)).exitCode).not.toBe(0);
  expect(grab).not.toHaveBeenCalled();
  expect(ownerMessagePending(dir)).toBe(false);
  const image = await capture()();
  const original = {id:"ui-bumpe-orphan",at:new Date().toISOString(),text:pointReplyText(input,env),image};
  enqueueOwnerMessage(dir,original);
  const recovered = await reply(ctx,location(),original.id,true,grab);
  expect(recovered.data.status).toBe("duplicate");
  expect(grab).not.toHaveBeenCalled();
  expect(readReplies(location())).toHaveLength(1);
  expect(claimOwnerMessages(dir,"session","claim")).toEqual([original]);
  expect(freshTargetedClick(pointEnv("20","30",1000),31000)).toBe(true);
  expect(freshTargetedClick(pointEnv("20","30",1000),31001)).toBe(false);
});

it("bounds the complete cross-process Bumpe protocol including worst-case coordinates and timestamp", () => {
  const env = pointEnv("-2147483648","-2147483648",253402300799999);
  expect(pointReplyText("",env).length).toBeLessThanOrEqual(BUMPE_CONTEXT_RESERVE);
  expect(pointReplyText(pointBumpText(`BUMP: ${"x".repeat(3994)}`),env).length).toBeLessThanOrEqual(4000);
});
