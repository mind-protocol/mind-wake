import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileThreadStore } from "../adapters/codex/continuity.js";
import type { UtcTimestamp } from "../contracts/index.js";
import { readOwnerInboxHistory } from "../communication/owner-inbox.js";
import { readRepoConversations } from "../communication/repo-conversations.js";
import {
  coachEnabled,
  configureCoach,
  readCoachState,
  WakeCoach,
  sendToCoach,
  coachEntries,
} from "./coach.js";
import type { ForkTurnInput, ForkTurnResult } from "./fork-runtime.js";
import { coachRuntimeConfig } from "./fork-runtime.js";

let dir: string, workspace: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-coach-"));
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  new FileThreadStore(path.join(dir, "codex-threads")).save("default", {
    threadId: "principal",
    promptFingerprint: "a".repeat(64),
    updatedAt: new Date().toISOString() as UtcTimestamp,
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const completed: ForkTurnResult = {
  outcome: "completed",
  text: "Et si cette scène devenait une rencontre ?",
  tokens: 50,
  accepted: true,
  detail: null,
  retryAtMs: null,
};
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

it("is opt-in, follows main wakes and resumes a separate thread without duplicate deliveries", async () => {
  let calls = 0;
  const turn = (input: ForkTurnInput) => {
    calls++;
    expect(input.sourceThreadId).toBe("principal");
    expect(input.inheritPrincipal).toBe(false);
    expect(input.coachSession).toBeTruthy();
    expect(coachRuntimeConfig(input)["mcp_servers.mind_wake_coach.env"]).toContain(
      input.coachSession,
    );
    expect(input.threadId).toBe(calls === 1 ? null : "coach-thread");
    if (!input.onSourceTurn?.("last-wake"))
      return Promise.resolve({ ...completed, text: "", accepted: false });
    input.onThread("coach-thread");
    return Promise.resolve(completed);
  };
  const create = () => new WakeCoach({ dataDir: dir, workspace, allowed: () => true, turn });
  const first = create();
  first.review("main-1");
  await settle();
  expect(calls).toBe(0);
  configureCoach(dir, true);
  expect(coachEnabled(dir)).toBe(true);
  first.review("main-1");
  first.review("main-concurrent");
  await settle();
  await first.close();
  expect(calls).toBe(1);
  expect(readOwnerInboxHistory(dir)).toMatchObject([
    { text: completed.text, origin: { kind: "peer_message", author: "Coach" } },
  ]);
  expect(readRepoConversations(dir)[0]?.messages).toHaveLength(1);
  const restarted = create();
  restarted.review("main-2");
  await settle();
  await restarted.close();
  expect(readOwnerInboxHistory(dir)).toHaveLength(1);
  expect(readCoachState(dir).source).toBe("principal:last-wake");
});

it("drops a result when Pause or Off arrives during coaching, and close cancels the runtime", async () => {
  configureCoach(dir, true);
  let allowed = true,
    release!: (result: ForkTurnResult) => void;
  let input!: ForkTurnInput;
  const coach = new WakeCoach({
    dataDir: dir,
    workspace,
    allowed: () => allowed,
    turn: (i) => {
      input = i;
      i.onSourceTurn?.("source");
      i.onThread("coach-thread");
      return new Promise<ForkTurnResult>((resolve) => {
        release = resolve;
      });
    },
  });
  coach.review("main");
  await settle();
  allowed = false;
  expect(input.control()).toBe("stop");
  release(completed);
  await settle();
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
  expect(readCoachState(dir).source).toBeNull();
  allowed = true;
  coach.review("main-2");
  await settle();
  configureCoach(dir, false);
  expect(input.control()).toBe("stop");
  const closing = coach.close();
  expect(input.control()).toBe("stop");
  release(completed);
  await closing;
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
});

it("keeps silence when appropriate and waits after a provider refusal", async () => {
  configureCoach(dir, true);
  let calls = 0;
  const coach = new WakeCoach({
    dataDir: dir,
    workspace,
    allowed: () => true,
    turn: (i) => {
      calls++;
      i.onSourceTurn?.(`wake-${String(calls)}`);
      i.onThread("coach-thread");
      return Promise.resolve<ForkTurnResult>(
        calls === 1
          ? { ...completed, text: "COACH_NO_MESSAGE" }
          : { ...completed, outcome: "rate_limited" },
      );
    },
  });
  coach.review("main-1");
  await settle();
  coach.review("main-2");
  await settle();
  coach.review("main-3");
  await settle();
  await coach.close();
  expect(calls).toBe(2);
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
  expect(readCoachState(dir).retryAt).toBeGreaterThan(Date.now());
});
it("delivers a direct human conversation without forwarding the reply to the principal", async () => {
  configureCoach(dir, true);
  sendToCoach(dir, "Peux-tu m'expliquer ton nouveau cap ?");
  const coach = new WakeCoach({
    dataDir: dir,
    workspace,
    allowed: () => true,
    turn: (i) => {
      expect(i.message).toContain("Peux-tu m'expliquer ton nouveau cap ?");
      expect(i.allowMissingSource).toBe(true);
      i.onThread("coach-thread");
      return Promise.resolve({ ...completed, text: "Voici pourquoi je propose ce cap." });
    },
  });
  coach.review("human-message");
  await settle();
  await coach.close();
  expect(coachEntries(dir)).toMatchObject([
    { role: "human", delivered: true },
    { role: "agent", text: "Voici pourquoi je propose ce cap." },
  ]);
  expect(readOwnerInboxHistory(dir)).toHaveLength(0);
});
