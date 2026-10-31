/** Real CLI processes and fixture SQLite only; Force-off is never lifted. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_AGENT_ID, DEFAULT_PROFILE_ID } from "../cli/context.js";
import { openStore } from "../cli/store/index.js";
import type { ProfileRecord, UtcTimestamp } from "../contracts/index.js";
import { ConversationStore } from "./store.js";
import type { ConversationSnapshot } from "./contracts.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));
const HOOKS = new URL("../../test/fixtures/store-ledger/ts-hooks.ts", import.meta.url).href;
const FIXTURES = path.join(ROOT, ".local", "conversation-cli-process-tests");
let dataDir: string;
let profile: ProfileRecord;
let env: NodeJS.ProcessEnv;
let tripwire: string;

beforeEach(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  // Spaces exercise the structured arguments used by the desktop bridge on Windows.
  dataDir = fs.mkdtempSync(path.join(FIXTURES, "force off "));
  profile = {
    id: DEFAULT_PROFILE_ID,
    agentId: DEFAULT_AGENT_ID,
    state: "stopped",
    activePolicyRevisionId: null,
    nextWakeAt: null,
    emergencyStopLocked: true,
    stateReason: "Synthetic human Force-off; do not activate",
    updatedAt: new Date().toISOString() as UtcTimestamp,
  };
  const control = openStore(dataDir, "write");
  try {
    control.uow.profiles.create(profile);
  } finally {
    control.close();
  }
  tripwire = path.join(dataDir, "provider-was-launched");
  const bin = path.join(dataDir, "fixture-bin");
  const script = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(path.join(bin, "codex.cmd"), "@exit /b 91\r\n");
  fs.writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(tripwire)}, "unexpected provider launch"); process.exit(91);`,
  );
  const privateConfig = path.join(dataDir, "private-config");
  fs.mkdirSync(privateConfig);
  env = {
    ...process.env,
    USERPROFILE: privateConfig,
    APPDATA: privateConfig,
    LOCALAPPDATA: privateConfig,
    CODEX_HOME: path.join(privateConfig, "codex"),
    MIND_WAKE_CODEX_BIN: path.join(bin, "codex.cmd"),
    MIND_WAKE_CLAUDE_EXE: path.join(bin, "absent-claude.exe"),
    MIND_WAKE_CLAUDE_CONFIG_DIR: path.join(privateConfig, "claude"),
  };
});

afterEach(() => {
  if (!dataDir.startsWith(FIXTURES + path.sep)) throw Error("Unexpected CLI fixture path");
  try {
    const control = openStore(dataDir, "read");
    try {
      expect(control.uow.profiles.get(DEFAULT_PROFILE_ID)).toEqual(profile);
      expect(control.uow.sessions.listOpen(DEFAULT_PROFILE_ID)).toEqual([]);
    } finally {
      control.close();
    }
    expect(fs.existsSync(tripwire)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "conversation-runtime"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "conversation-mode.json"))).toBe(false);
    expect(
      fs.readdirSync(dataDir).filter((file) => file.startsWith("conversation-worker")),
    ).toEqual([]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function invoke(action: string, input: unknown, expectedCode = 0): Record<string, unknown> {
  expect(HOOKS).toMatch(/^file:\/\//);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      HOOKS,
      ENTRY,
      action,
      "--data-dir",
      dataDir,
      "--json",
    ],
    {
      cwd: ROOT,
      input: JSON.stringify(input),
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(expectedCode);
  // Exactly one JSON envelope, with no activity or provider output mixed into stdout.
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const parsed: unknown = JSON.parse(result.stdout);
  const envelope = object(parsed);
  expect(envelope).toMatchObject({
    schema: "mind.conversation",
    schemaVersion: 1,
    ok: expectedCode === 0,
  });
  if (expectedCode !== 0) return object(envelope["error"]);
  const data = object(envelope["data"]);
  expect(data["controls"]).toEqual({ allowed: false, reason: "force_off" });
  expect(data["workerRunning"]).toBe(false);
  return data;
}

function snapshot(): ConversationSnapshot {
  const store = new ConversationStore(dataDir);
  try {
    return store.snapshot("main");
  } finally {
    store.close();
  }
}

function expectFullSnapshot(data: Record<string, unknown>): ConversationSnapshot {
  const expected = snapshot();
  for (const [key, value] of Object.entries(expected)) expect(data[key]).toEqual(value);
  return expected;
}

it("reads full messages, changes and canonical history through the actual TS CLI", () => {
  const question = "Une question précise : « mémoire » — € 🧠; $(aucune commande)";
  const original = "Réponse initiale complète. ".repeat(500);
  const improved = "Réponse améliorée et sourcée. ".repeat(500);
  const store = new ConversationStore(dataDir);
  try {
    store.submit("main", question, "seed-question");
    store.addCall({
      id: "seed-lead",
      conversationId: "main",
      revision: 1,
      role: "lead",
      pass: 1,
      systemPrompt: "Synthetic fixture, no model invocation.",
      messages: [{ role: "user", content: question }],
    });
    store.finishCall("seed-lead", {
      status: "succeeded",
      text: original,
      rawOutput: JSON.stringify({ fixture: true, text: original }),
      usage: 0,
    });
    store.setCanonical("lead", "main", 1, [
      { role: "user", content: question },
      { role: "assistant", content: original },
    ]);
    store.publishRewrite("main", 1, "lead", [
      { role: "user", content: question },
      { role: "assistant", content: improved },
    ]);
  } finally {
    store.close();
  }

  const data = invoke("read", { conversationId: "main" });
  const expected = expectFullSnapshot(data);
  expect(expected.messages.map((message) => message.text)).toEqual([question, improved]);
  expect(expected.messageVersions.map((message) => message.text)).toEqual([
    question,
    original,
    improved,
  ]);
  expect(expected.calls[0]?.text).toBe(original);
  expect(expected.canonicalVersions.map((canonical) => canonical.version)).toEqual([1, 2]);
  expect(expected.canonicalVersions.map((canonical) => canonical.messages.at(-1)?.content)).toEqual(
    [original, improved],
  );
  expect(expected.changes.length).toBeGreaterThan(4);
  expect(expected.changes.some((change) => change.kind === "canonical_updated")).toBe(true);
}, 30_000);

it("submits, edits, stops and reads cursor events without starting a worker or lifting Force-off", () => {
  const text = 'À conserver exactement\n\n« \\ et " »; 🛠️';
  const first = invoke("submit", {
    conversationId: "main",
    text,
    idempotencyKey: "request-one",
    expectedRevision: 0,
  });
  const initial = expectFullSnapshot(first);
  expect(initial.revision).toBe(1);
  expect(initial.status).toBe("active");
  expect(initial.messages[0]?.text).toBe(text);
  const human = initial.messages[0];
  if (!human) throw Error("Submission did not persist a human message");
  const editedText = text + "\n\nCorrection humaine conservée.";
  const edited = invoke("edit", {
    conversationId: "main",
    messageId: human.id,
    text: editedText,
    expectedVersion: 1,
    expectedRevision: 1,
  });
  const afterEdit = expectFullSnapshot(edited);
  expect(afterEdit).toMatchObject({ revision: 2, text: editedText });
  expect(afterEdit.messages[0]).toMatchObject({ version: 2, edited: true, text: editedText });
  const conflict = invoke(
    "edit",
    { conversationId: "main", messageId: human.id, text: "Stale overwrite", expectedVersion: 1 },
    1,
  );
  expect(conflict["message"]).toBe("Message version changed");
  expect(snapshot()).toEqual(afterEdit);

  const stopped = expectFullSnapshot(invoke("stop", { conversationId: "main" }));
  expect(stopped.status).toBe("stopped");
  const cursor = stopped.events.at(-1)?.sequence;
  if (cursor === undefined) throw Error("Missing stop event cursor");
  const queued = expectFullSnapshot(
    invoke("submit", {
      conversationId: "main",
      text: "Message queued after stop",
      idempotencyKey: "request-two",
      expectedRevision: 2,
    }),
  );
  expect(queued).toMatchObject({ revision: 3, status: "stopped" });
  expect(queued.calls).toEqual([]);
  const events = invoke("events", { conversationId: "main", after: cursor });
  expect(events["events"]).toEqual(queued.events.filter((event) => event.sequence > cursor));
  expect(events["events"]).toMatchObject([{ kind: "human_message", revision: 3 }]);
  expect(events["changes"]).toEqual(queued.changes);
  expectFullSnapshot(invoke("read", { conversationId: "main" }));
}, 30_000);

it("returns the versioned JSON error envelope for invalid stdin without changing the fixture", () => {
  const result = invoke("submit", ["not", "an", "object"], 1);
  expect(result["message"]).toBe("Expected an input object");
  expect(fs.existsSync(path.join(dataDir, "conversation.sqlite"))).toBe(false);
}, 30_000);
