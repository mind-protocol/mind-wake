import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  enqueueOwnerMessage,
  ownerMessagePending,
  readOwnerReceipts,
  restoreOwnerMessages,
  takeOwnerMessages,
  claimOwnerMessages,
  confirmOwnerClaim,
  releaseOwnerClaims,
} from "./owner-inbox.js";
import { ownerInboxHook } from "./owner-inbox-hook.js";
import { claudeRunArgs } from "../adapters/claude/command.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-hook-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const input = (name = "PostToolUse") => ({ session_id: "session-1", hook_event_name: name });
const send = (id = "human-1") =>
  enqueueOwnerMessage(dir, { id, at: "2026-10-29T16:30:00Z", text: `Bonjour ${id}` });

it("stream reservations cannot be stolen by a hook and become receipts only on runtime acknowledgement", () => {
  send();
  expect(claimOwnerMessages(dir, "runtime", "claim")).toHaveLength(1);
  expect(readOwnerReceipts(dir)).toEqual({});
  expect(takeOwnerMessages(dir, "hook")).toEqual([]);
  expect(claimOwnerMessages(dir, "runtime", "other")).toEqual([]);
  confirmOwnerClaim(dir, "wrong-runtime", "claim");
  expect(readOwnerReceipts(dir)).toEqual({});
  confirmOwnerClaim(dir, "runtime", "claim");
  expect(readOwnerReceipts(dir)["human-1"]).toBeTruthy();
});
it("requeues unacknowledged stream messages after process death, without undoing confirmed receipts", () => {
  send();
  claimOwnerMessages(dir, "dead-runtime", "claim");
  releaseOwnerClaims(dir, "another-runtime");
  expect(takeOwnerMessages(dir, "hook")).toEqual([]);
  releaseOwnerClaims(dir, "dead-runtime");
  expect(takeOwnerMessages(dir, "next-runtime")).toHaveLength(1);
  releaseOwnerClaims(dir);
  expect(readOwnerReceipts(dir)["human-1"]).toBeTruthy();
});

it("restores undelivered messages if the runtime input fails, without touching another session's delivery", () => {
  send();
  takeOwnerMessages(dir, "runtime");
  restoreOwnerMessages(dir, "other-runtime", ["human-1"]);
  expect(ownerMessagePending(dir)).toBe(false);
  restoreOwnerMessages(dir, "runtime", ["human-1"]);
  expect(ownerMessagePending(dir)).toBe(true);
  expect(readOwnerReceipts(dir)).toEqual({});
  expect(takeOwnerMessages(dir, "next-runtime")).toHaveLength(1);
});

it("injects desktop messages once, in order, and retains deduplication across wakes", () => {
  expect(readOwnerReceipts(dir)).toEqual({});
  send();
  send();
  send("human-2");
  expect(ownerMessagePending(dir)).toBe(true);
  expect(readOwnerReceipts(dir)).toEqual({});
  const result = ownerInboxHook(dir, "session-1", input()) as {
    hookSpecificOutput: { additionalContext: string };
  };
  expect(result).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  expect(result.hookSpecificOutput.additionalContext).toContain("Bonjour human-1");
  expect(result.hookSpecificOutput.additionalContext.indexOf("human-1")).toBeLessThan(
    result.hookSpecificOutput.additionalContext.indexOf("human-2"),
  );
  expect(ownerMessagePending(dir)).toBe(false);
  expect(Object.keys(readOwnerReceipts(dir))).toEqual(["human-1", "human-2"]);
  expect(ownerInboxHook(dir, "session-1", input())).toBeNull();
  send();
  expect(ownerInboxHook(dir, "session-1", input("SessionStart"))).toBeNull();
});

it("keeps pending messages for a wake if the previous session ended before a tool hook", () => {
  send();
  expect(
    ownerInboxHook(dir, "next-session", {
      session_id: "next-session",
      hook_event_name: "SessionStart",
    }),
  ).toMatchObject({ hookSpecificOutput: { hookEventName: "SessionStart" } });
});

it("ignores other sessions, subagents and unsupported events without consuming messages", () => {
  send();
  expect(ownerInboxHook(dir, "other", input())).toBeNull();
  expect(ownerInboxHook(dir, "session-1", { ...input(), agent_id: "subagent" })).toBeNull();
  expect(ownerInboxHook(dir, "session-1", input("PreToolUse"))).toBeNull();
  expect(ownerMessagePending(dir)).toBe(true);
});

it("catches a message at the end of the response without creating a Stop loop", () => {
  send();
  expect(ownerInboxHook(dir, "session-1", input("Stop"))).toMatchObject({ decision: "block" });
  expect(ownerInboxHook(dir, "session-1", input("Stop"))).toBeNull();
  send("human-2");
  expect(ownerInboxHook(dir, "session-1", input("PostToolUseFailure"))).toMatchObject({
    hookSpecificOutput: { hookEventName: "PostToolUseFailure" },
  });
});

it("configures executable args without interpolating paths or message content into a shell", () => {
  const args = claudeRunArgs({
    model: "opus",
    systemPromptFile: "prompt",
    tools: [],
    nativeCapabilities: true,
    permission: "skip_permissions_unsandboxed",
    session: { mode: "new", id: "session-1" },
    ownerInboxHook: {
      node: "C:/Node space/node.exe",
      script: "C:/Wake's dir/hook.js",
      dataDir: dir,
    },
  });
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
  expect(settings.disableAllHooks).toBe(false);
  expect(settings.hooks.PostToolUse[0].hooks[0]).toEqual({
    type: "command",
    command: "C:/Node space/node.exe",
    args: ["C:/Wake's dir/hook.js", "--deliver-owner-inbox", dir, "session-1"],
  });
  expect(args).not.toContain("--setting-sources");
});
