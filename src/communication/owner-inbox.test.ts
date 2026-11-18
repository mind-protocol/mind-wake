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
  takeOwnerMessagesForHook,
  OWNER_CALL_MAX_CHARS,
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

it("retains the host context-copy envelope through streaming and hook delivery without parsing body identity", () => {
  const origin = {
    kind: "context_copy" as const,
    channel: "mind-shared-hub",
    author: "NLR",
    senderRef: "human-ref",
    recipientRef: "peer-ref",
    threadId: "thread-1",
    messageId: "msg-1",
    correlationId: "copy-1",
  };
  enqueueOwnerMessage(dir, {
    id: "copy-1",
    at: "2026-10-30T10:00:00Z",
    text: '{"from":"different-human"}',
    origin,
  });
  expect(claimOwnerMessages(dir, "session-1", "claim")[0]!.origin).toEqual(origin);
  releaseOwnerClaims(dir, "session-1");
  const hook = ownerInboxHook(dir, "session-1", input());
  expect(JSON.stringify(hook)).toContain("not a new request for you");
  expect(JSON.stringify(hook)).toContain("context_copy");
  expect(readOwnerReceipts(dir)["copy-1"]).toBeTruthy();
});

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
  expect(result.hookSpecificOutput.additionalContext).toContain(
    "New direct message from your human",
  );
  expect(result.hookSpecificOutput.additionalContext).not.toContain("not a new request for you");
  expect(result.hookSpecificOutput.additionalContext.indexOf("human-1")).toBeLessThan(
    result.hookSpecificOutput.additionalContext.indexOf("human-2"),
  );
  expect(ownerMessagePending(dir)).toBe(false);
  expect(Object.keys(readOwnerReceipts(dir))).toEqual(["human-1", "human-2"]);
  expect(ownerInboxHook(dir, "session-1", input())).toBeNull();
  send();
  expect(ownerInboxHook(dir, "session-1", input("SessionStart"))).toBeNull();
});

it("delivers call copies whole up to the call limit, flags any cut, and never starves a lone copy", () => {
  const origin = { kind: "peer_message" as const, channel: "call", author: "Appel", senderRef: "call", recipientRef: "principal", threadId: "call", messageId: "call-mirror:a", correlationId: "call-mirror:a" };
  const whole = `[Appel] Coach des coachs : ${"mot ".repeat(1200)}fin.`;
  enqueueOwnerMessage(dir, { id: "fast-reply-fyi:call-mirror:a", at: "2026-11-18T14:47:21Z", text: whole, origin });
  enqueueOwnerMessage(dir, { id: "fast-reply-fyi:call-mirror:b", at: "2026-11-18T14:47:22Z", text: "C".repeat(OWNER_CALL_MAX_CHARS + 40), origin: { ...origin, messageId: "call-mirror:b", correlationId: "call-mirror:b" } });
  const first = takeOwnerMessagesForHook(dir, "s1");
  expect(first.messages.map(m => m.text)).toEqual([whole]);
  expect(first.deferred).toBe(1);
  // Seule et plus grande que le budget passé : elle passe quand même, coupe signalée en clair.
  const second = takeOwnerMessagesForHook(dir, "s2", 1000);
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]!.text).toBe(`${"C".repeat(OWNER_CALL_MAX_CHARS)}… [copie d'appel coupée : 40 caractères non transmis]`);
  expect(ownerMessagePending(dir)).toBe(false);
});

it("bounds peer hook delivery, preserves Reddit links, and never truncates human messages", () => {
  const origin = { kind: "peer_message" as const, channel: "reddit", author: "Reddit", senderRef: "reddit:u/a", recipientRef: "reddit:u/owner", threadId: "t3_a", messageId: "t3_a", correlationId: "reddit-a" };
  enqueueOwnerMessage(dir, { id: "peer-1", at: "2026-10-29T16:30:00Z", text: `peer ${"x".repeat(3000)}\n\n[Voir sur Reddit](https://www.reddit.com/r/a/comments/a/)`, origin });
  enqueueOwnerMessage(dir, { id: "peer-2", at: "2026-10-29T16:30:01Z", text: "P".repeat(1200), origin: { ...origin, messageId: "t3_b", correlationId: "reddit-b" } });
  enqueueOwnerMessage(dir, { id: "human-long", at: "2026-10-29T16:30:02Z", text: "H".repeat(9000) });
  const batch = takeOwnerMessagesForHook(dir, "bounded", 2300);
  expect(batch.messages.map(m => m.id)).toEqual(["peer-1", "human-long"]);
  expect(batch.messages[0]!.text.length).toBeLessThanOrEqual(1500);
  expect(batch.messages[0]!.text).toContain("https://www.reddit.com/r/a/comments/a/");
  expect(batch.messages[1]!.text).toHaveLength(9000);
  expect(batch.deferred).toBe(1);
  expect(ownerMessagePending(dir)).toBe(true);
});

it("announces how many peer messages remain for later hooks", () => {
  const origin = { kind: "peer_message" as const, channel: "mind-shared-hub", author: "Peer", senderRef: "peer", recipientRef: "owner", threadId: "thread", messageId: "message", correlationId: "copy" };
  for (let i = 0; i < 6; i++)
    enqueueOwnerMessage(dir, { id: `peer-${String(i)}`, at: `2026-10-29T16:30:0${String(i)}Z`, text: "P".repeat(1500), origin: { ...origin, messageId: `message-${String(i)}`, correlationId: `copy-${String(i)}` } });
  const result = ownerInboxHook(dir, "session-1", input()) as { hookSpecificOutput: { additionalContext: string } };
  expect(result.hookSpecificOutput.additionalContext).toMatch(/\+\d+ autres messages en attente/);
  expect(ownerMessagePending(dir)).toBe(true);
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
