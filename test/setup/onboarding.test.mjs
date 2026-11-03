import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  conversationProgress,
  onboardingService,
  prepareOnboarding,
} from "../../scripts/onboarding.mjs";
import { nativeCodexPolicy } from "../../scripts/codex-policy.mjs";
import { validateDraft } from "../../dist/policy/validate.js";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(process.env.MIND_WAKE_TEST_TMP ?? os.tmpdir(), "wake-welcome-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "installation"));
  const manifest = path.join(root, "installation/manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ version: 1, dataDir: root, repoDir: process.cwd(), node: process.execPath }),
  );
  const state = {
    profile: { state: "disabled", activePolicyRevisionId: null, emergencyStopLocked: false },
    daemon: { state: "never", mode: null },
    lastSession: null,
  };
  const calls = [];
  let launches = 0,
    failEnable = false;
  const cli = (args) => {
    calls.push(args);
    if (args[0] === "status") return structuredClone(state);
    if (args[0] === "messages") return {};
    if (args[0] === "wake-history")
      return { locations: { workspace: path.join(root, "workspace") } };
    if (args[0] === "policy" && args[1] === "show") return { revisionCount: 0 };
    if (args[0] === "policy") {
      const draft = JSON.parse(fs.readFileSync(args[2], "utf8"));
      const validation = validateDraft(
        { ...draft, identity: { profileId: "default", agentId: "local-agent" } },
        "default",
      );
      assert.equal(validation.ok, true, JSON.stringify(validation));
      return { revisionId: "revision-local" };
    }
    if (args[0] === "enable") {
      if (failEnable) throw Error("activation interrompue");
      assert.deepEqual(args, ["enable", "--revision", "revision-local"]);
      state.profile.activePolicyRevisionId = "revision-local";
      state.profile.state = "ready";
      return { enabled: true };
    }
    if (args[0] === "wake") return { status: "requested" };
    throw Error("Unexpected command " + args);
  };
  const service = onboardingService(manifest, {
    cli,
    requestWake: async () => {
      calls.push(["wake-request"]);
    },
    startEngine: async () => {
      launches++;
      state.daemon = { state: "running", mode: "real" };
    },
  });
  return {
    root,
    state,
    calls,
    service,
    launches: () => launches,
    failEnable: (value) => {
      failEnable = value;
    },
  };
}
test("preparing the welcome grants nothing, preserves chosen settings on rerun", (t) => {
  const f = fixture(t);
  const source = path.join(f.root, "shared source");
  fs.mkdirSync(source);
  const first = prepareOnboarding(f.root, {
    sources: [source],
    model: "gpt-6.1-sol",
    timeZone: "Europe/Paris",
  });
  assert.deepEqual(prepareOnboarding(f.root, { sources: [] }), first);
  assert.equal(fs.existsSync(path.join(f.root, "workspace/AUTORISATIONS.json")), false);
  assert.equal(f.calls.length, 0);
  assert.equal(nativeCodexPolicy(first.settings).runtime.nativeCapabilities, true);
});
test("no native consent: no command, activation or memory write", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.start(), /accord/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "workspace")), false);
});
test("consent prepares a valid policy, authorizations, enables actual revision, requests one real wake", async (t) => {
  const f = fixture(t);
  prepareOnboarding(f.root);
  const progress = await f.service.start({ acceptNative: true });
  assert.equal(progress.stage, "starting"); // A launched daemon is not evidence of an agent reply.
  assert.equal(f.launches(), 1);
  const authorizations = JSON.parse(
    fs.readFileSync(path.join(f.root, "workspace/AUTORISATIONS.json"), "utf8"),
  );
  assert.equal(authorizations.entries.length, 3);
  assert.equal(authorizations.entries[1].scope, path.join(f.root, "workspace"));
  await f.service.start({ acceptNative: true });
  assert.equal(f.calls.filter((args) => args[0] === "enable").length, 1);
  assert.equal(f.calls.filter((args) => args[0] === "wake-request").length, 1);
  assert.equal(f.launches(), 1);
});
test("an interrupted activation resumes the same proposed revision without overwriting data", async (t) => {
  const f = fixture(t);
  f.failEnable(true);
  await assert.rejects(f.service.start({ acceptNative: true }), /interrompue/);
  f.failEnable(false);
  await f.service.start({ acceptNative: true });
  assert.equal(f.calls.filter((args) => args[0] === "policy" && args[1] === "configure").length, 1);
  assert.equal(f.launches(), 1);
});
for (const state of ["paused", "stopped", "blocked"])
  test(`preserves ${state}, never enables or launches`, async (t) => {
    const f = fixture(t);
    f.state.profile.state = state;
    await assert.rejects(f.service.start({ acceptNative: true }), /pause/);
    assert.equal(f.launches(), 0);
    assert.equal(
      f.calls.some((args) => args[0] === "enable" || args[0] === "wake"),
      false,
    );
  });
test("an existing policy and personal authorizations are never replaced", async (t) => {
  const f = fixture(t);
  f.state.profile.activePolicyRevisionId = "existing";
  await assert.rejects(f.service.start({ acceptNative: true }), /déjà une configuration/);
  f.state.profile.activePolicyRevisionId = null;
  fs.mkdirSync(path.join(f.root, "workspace"));
  const file = path.join(f.root, "workspace/AUTORISATIONS.json");
  fs.writeFileSync(file, '{"personal":"keep"}');
  await assert.rejects(f.service.start({ acceptNative: true }), /personnelles/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"personal":"keep"}');
});
const record = {
  requestedAt: "2026-11-03T10:00:00Z",
  baselineSessionId: null,
  settings: { model: "gpt-6.1-sol", timeZone: "Europe/Paris", sources: [] },
};
const running = { profile: { state: "running" }, daemon: { mode: "real" }, lastSession: null };
const greeting = { id: "greeting", createdAt: "2026-11-03T10:00:01Z" };
test("complete requires a real runtime, greeting, human message, delivery and subsequent agent answer", () => {
  const messages = {
    agentMessages: [greeting],
    replies: [{ id: "human", at: "2026-11-03T10:00:02Z" }],
  };
  assert.equal(conversationProgress(record, running, {}).stage, "working");
  assert.equal(
    conversationProgress(record, running, { agentMessages: [greeting] }).stage,
    "awaiting_human",
  );
  assert.equal(conversationProgress(record, running, messages).stage, "reply_pending");
  messages.agentMessages.push({
    id: "unrelated-before-delivery",
    createdAt: "2026-11-03T10:00:03Z",
  });
  messages.deliveryReceipts = { human: "2026-11-03T10:00:04Z" };
  assert.equal(conversationProgress(record, running, messages).stage, "reply_pending");
  messages.agentMessages.push({ id: "answer", createdAt: "2026-11-03T10:00:05Z" });
  assert.equal(conversationProgress(record, running, messages).stage, "complete");
  assert.equal(
    conversationProgress(record, { ...running, daemon: { mode: "simulated" } }, messages).stage,
    "starting",
  );
  assert.equal(
    conversationProgress(record, { ...running, profile: { state: "paused" } }, messages).stage,
    "held",
  );
});
test("old replies, delegated outputs and commentary do not count as the first exchange", () => {
  const messages = {
    agentMessages: [{ id: "old", createdAt: "2026-11-02T10:00:00Z" }],
    publicActivity: [
      { id: "comment", at: "2026-11-03T10:00:01Z", text: "hello" },
      {
        id: "delegate",
        at: "2026-11-03T10:00:01Z",
        text: "hello",
        kind: "final",
        source: "worker",
      },
    ],
  };
  assert.equal(conversationProgress(record, running, messages).stage, "working");
});
test("a failed real session produces a recoverable error instead of a success", () => {
  const status = {
    profile: { state: "hibernating" },
    daemon: { mode: "real" },
    lastSession: {
      sessionId: "failed",
      outcome: "failed",
      simulated: false,
      reason: "model_unavailable",
    },
  };
  assert.equal(conversationProgress(record, status, {}).stage, "error");
});

test("real CLI integration configures and enables a fresh profile, queues a wake without running a model", async (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    ["dist/cli/main.js", "init", "--data-dir", f.root, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  let launched = 0;
  const service = onboardingService(path.join(f.root, "installation/manifest.json"), {
    startEngine: async () => {
      launched++;
    },
  });
  const progress = await service.start({ acceptNative: true });
  assert.equal(launched, 1);
  assert.equal(progress.stage, "starting");
  assert.equal(fs.existsSync(path.join(f.root, "human-wake-request.json")), true);
  const record = JSON.parse(
    fs.readFileSync(path.join(f.root, "installation/onboarding.json"), "utf8"),
  );
  assert.ok(record.revisionId);
  const current = spawnSync(
    process.execPath,
    ["dist/cli/main.js", "status", "--data-dir", f.root, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(current.stdout).data.profile.activePolicyRevisionId, record.revisionId);
  const read = spawnSync(
    process.execPath,
    ["scripts/onboarding.mjs", "status", "--json", "--data-dir", f.root],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(JSON.parse(read.stdout).data.stage, "starting");
});

test("a lock left by an exited installer is recovered without resetting progress", async (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pid = Number(child.stdout.trim());
  assert.ok(pid > 0);
  const lock = path.join(f.root, "installation/onboarding.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid }));
  await f.service.start({ acceptNative: true });
  assert.equal(f.launches(), 1);
  assert.equal(fs.existsSync(lock), false);
});
