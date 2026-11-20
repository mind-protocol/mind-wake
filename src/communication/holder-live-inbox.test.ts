import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createHolderLiveInbox, holderLiveHook, holderLiveClaudeArgs, prepareHolderLiveInbox } from "./holder-live-inbox.js";
import { enqueueOwnerMessage, takeOwnerMessages } from "./owner-inbox.js";
import { preparePrincipalCorpus } from "./fil-continuity.js";
import { fastReplyArgs } from "./fast-reply.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "holder-injection-"));
  fs.mkdirSync(path.join(dir, "workspace"));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it("broadcasts once to each holder independently, without consuming the principal queue or broadcasting peers", () => {
  enqueueOwnerMessage(dir, { id: "old", at: "2026-11-20T10:00:00Z", text: "Déjà dans le fil" });
  const baseline = preparePrincipalCorpus(dir, path.join(dir, "workspace"), "principal");
  const a = createHolderLiveInbox(dir, path.join(dir, "alpha"), baseline);
  const b = createHolderLiveInbox(dir, path.join(dir, "beta"), baseline);
  enqueueOwnerMessage(dir, { id: "fresh", at: "2026-11-20T10:01:00Z", text: "Correction immédiate" });
  enqueueOwnerMessage(dir, { id: "peer", at: "2026-11-20T10:02:00Z", text: "Autre agent", origin: {
    kind: "peer_message", channel: "pattern-holder", author: "Coach", senderRef: "coach", recipientRef: "principal",
    threadId: "principal", messageId: "peer", correlationId: "peer",
  } });
  fs.writeFileSync(path.join(dir, "human-messages.jsonl"), JSON.stringify({ id: "fresh", at: "2026-11-20T10:01:00Z", text: "Correction immédiate" }) + "\n");
  const first = prepareHolderLiveInbox(a);
  expect(first?.context).toContain("Correction immédiate");
  expect(first?.context).not.toContain("Autre agent");
  first?.confirm();
  expect(prepareHolderLiveInbox(a)).toBeNull();
  const second = prepareHolderLiveInbox(b);
  expect(second?.context).toBe(first?.context);
  second?.confirm();
  expect(prepareHolderLiveInbox(b)).toBeNull();
  expect(takeOwnerMessages(dir, "principal").some(message => message.id === "fresh")).toBe(true);
});

it("does not replay old human messages outside the 200-turn window", () => {
  fs.writeFileSync(path.join(dir, "human-messages.jsonl"), Array.from({ length: 230 }, (_, n) =>
    JSON.stringify({ id: `m-${String(n)}`, at: new Date(1800000000000 + n).toISOString(), text: "ancien" })).join("\n"));
  const baseline = preparePrincipalCorpus(dir, path.join(dir, "workspace"), "principal");
  expect(baseline).toHaveLength(230);
  const inbox = createHolderLiveInbox(dir, path.join(dir, "alpha"), baseline);
  expect(prepareHolderLiveInbox(inbox)).toBeNull();
});

it("injects at tool boundaries and blocks Stop for a late message, guarding session identity", () => {
  const inbox = createHolderLiveInbox(dir, path.join(dir, "alpha"), []);
  enqueueOwnerMessage(dir, { id: "first", at: "2026-11-20T10:00:00Z", text: "Pendant le passage" });
  expect(holderLiveHook(inbox, { session_id: "other", hook_event_name: "PostToolUse" })).toBeNull();
  expect(holderLiveHook(inbox, { session_id: inbox.sessionId, agent_id: "child", hook_event_name: "Stop" })).toBeNull();
  const toolOutput = holderLiveHook(inbox, { session_id: inbox.sessionId, hook_event_name: "PostToolUse" });
  expect(toolOutput).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  expect(JSON.stringify(toolOutput)).toContain("Pendant le passage");
  enqueueOwnerMessage(dir, { id: "late", at: "2026-11-20T10:01:00Z", text: "Avant de terminer" });
  const stopOutput = holderLiveHook(inbox, { session_id: inbox.sessionId, hook_event_name: "Stop" });
  expect(stopOutput).toMatchObject({ decision: "block" });
  expect(JSON.stringify(stopOutput)).toContain("Avant de terminer");
  expect(holderLiveHook(inbox, { session_id: inbox.sessionId, hook_event_name: "Stop" })).toBeNull();
});

it("runs the actual configured Claude hook executable, including source-mode loading", () => {
  const inbox = createHolderLiveInbox(dir, path.join(dir, "alpha"), []);
  const args = holderLiveClaudeArgs(fastReplyArgs("unused", "prompt.md"), inbox);
  const settingsText = args[args.indexOf("--settings") + 1];
  if (!settingsText) throw Error("No hook settings");
  const settings = JSON.parse(settingsText) as { disableAllHooks: boolean; hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> };
  expect(settings.disableAllHooks).toBe(false);
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  const hook = settings.hooks["PostToolUse"]?.[0]?.hooks[0];
  if (!hook) throw Error("Missing tool hook");
  enqueueOwnerMessage(dir, { id: "live", at: "2026-11-20T10:00:00Z", text: "Injecté dans le processus" });
  const result = spawnSync(hook.command, hook.args, { encoding: "utf8", windowsHide: true,
    input: JSON.stringify({ session_id: inbox.sessionId, hook_event_name: "PostToolUse" }), timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout) as unknown).toHaveProperty("hookSpecificOutput.additionalContext");
  expect(result.stdout).toContain("Injecté dans le processus");
});
