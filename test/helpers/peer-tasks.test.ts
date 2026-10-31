import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { Hub } from "../../services/mcp/hub.js";
import { parseHubConfig } from "../../services/mcp/config.js";
import { digest as keyDigest } from "../../services/advice/conversation/capability.js";
import { sharedPresentation } from "../../services/mcp/shared-https.js";
import type { HubRequest } from "../../services/mcp/protocol.js";
import {
  PeerTasks,
  readPeerTaskPolicy,
  type PeerTaskPolicy,
  type SharedTaskLink,
  type LocalLauncher,
} from "../../services/helpers/peer-tasks.js";
import { digest, type TaskInput } from "../../services/mcp/peer-task-protocol.js";
import {
  enqueueOwnerMessage,
  takeOwnerMessages,
  readOwnerInboxHistory,
} from "../../src/communication/owner-inbox.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import {
  directProfile,
  queueDirectAdvice,
  executeDirectAdvice,
  readDirectThread,
  type DirectRequest,
} from "../../services/helpers/direct-advice.js";
import { refreshIndex, type IndexedSession } from "../../services/helpers/session-index.js";
import { BackgroundJobStore } from "../../src/daemon/background-jobs.js";
import { stop } from "../../src/cli/commands/stop.js";
import { processContext } from "../../src/cli/context.js";
vi.mock("../../services/helpers/session-index.js", () => ({ refreshIndex: vi.fn() }));
let folder: string,
  aDir: string,
  bDir: string,
  hub: Hub,
  aRef: string,
  bRef: string,
  aLink: SharedTaskLink,
  bLink: SharedTaskLink,
  a: PeerTasks,
  b: PeerTasks,
  paused: boolean;
const actor = { kind: "agent" as const, ref: "agent-bbbbbbbbbb" };
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw Error("Missing expected test evidence");
  return value;
}
const input: TaskInput = {
  goal: "Examiner une pièce",
  deliverable: "Un avis relu",
  scope: "Le seul repo choisi localement",
  prompt:
    "Prompt complet : lire la pièce et confronter les preuves.\n" + "contenu exact ".repeat(90),
};
let jobs: Map<string, { thread_id: string; job_id: string }>,
  launch: Mock<LocalLauncher["launch"]>,
  answer: string;
const policy = (ref: string): PeerTaskPolicy => ({
  enabled: true,
  localAgentRef: ref,
  decider: actor,
  sharedEndpoint: "https://example.test/v1/messages",
  sharedKeyFile: path.join(folder, "private.key"),
});
it("requires an explicit enabled policy and authenticates the workshop before any job", async () => {
  expect(() => readPeerTaskPolicy(bDir)).toThrow();
  fs.writeFileSync(
    path.join(bDir, "peer-task-policy.json"),
    JSON.stringify({ ...policy(bRef), enabled: false }),
  );
  expect(() => readPeerTaskPolicy(bDir)).toThrow("disabled");
  const task = await proposal();
  b.close();
  b = new PeerTasks(
    bDir,
    () => policy(bRef),
    aLink,
    { launch: (i) => launch(i), read: () => ({ status: "pending", messages: [] }) },
    () => {},
  );
  await expect(
    b.decide(actor, {
      id: task.id,
      action: "accept",
      promptHash: task.request.prompt_hash,
      target: "codex:local",
      key: "wrong-binding-001",
    }),
  ).rejects.toThrow("identity mismatch");
  expect(launch).not.toHaveBeenCalled();
  expect(b.get(task.id).state).toBe("received");
});

it("maps a human decision explicitly and rejects reopening a task under another workshop", async () => {
  const task = await proposal();
  b.close();
  const human = { kind: "human" as const, ref: "human-bbbbbbbbbb" };
  let localRef = bRef;
  b = new PeerTasks(
    bDir,
    () => ({ ...policy(localRef), decider: human }),
    bLink,
    { launch: (i) => launch(i), read: () => ({ status: "pending", messages: [] }) },
    () => {},
  );
  await expect(
    b.decide(actor, {
      id: task.id,
      action: "accept",
      promptHash: task.request.prompt_hash,
      target: "codex:local",
      key: "wrong-role-001",
    }),
  ).rejects.toThrow("capability");
  await b.decide(human, {
    id: task.id,
    action: "decline",
    promptHash: task.request.prompt_hash,
    explanation: "Décision humaine locale.",
    key: "human-decline-001",
  });
  expect(launch).not.toHaveBeenCalled();
  localRef = aRef;
  expect(b.list()).toEqual([]);
  expect(() => b.get(task.id)).toThrow("different local workshop");
});
it("rechecks Pause and policy after the asynchronous identity lookup", async () => {
  const task = await proposal();
  b.close();
  b = new PeerTasks(
    bDir,
    () => policy(bRef),
    {
      call: async <T>(request: Record<string, unknown>) => {
        const result = await bLink.call<T>(request);
        paused = true;
        return result;
      },
    },
    { launch: (i) => launch(i), read: () => ({ status: "pending", messages: [] }) },
    () => {
      if (paused) throw Error("Wake paused");
    },
  );
  await expect(
    b.decide(actor, {
      id: task.id,
      action: "accept",
      promptHash: task.request.prompt_hash,
      target: "codex:local",
      key: "pause-during-identity",
    }),
  ).rejects.toThrow("paused");
  expect(launch).not.toHaveBeenCalled();
  expect(b.get(task.id).state).toBe("received");
});
function newRecipient(
  launcher: LocalLauncher = {
    launch: (i) => launch(i),
    read: (id) => ({
      status: "answered",
      messages: [{ id: id + "-answer", from: "repo", text: answer }],
    }),
  },
  guard = () => {
    if (paused) throw Error("Wake paused");
  },
): PeerTasks {
  return new PeerTasks(bDir, () => policy(bRef), bLink, launcher, guard);
}
async function deliver(link: SharedTaskLink, dir: string): Promise<void> {
  const page = await link.call<{
    messages: {
      message_id: string;
      thread_id: string;
      from: string;
      to: string;
      from_self: boolean;
      text: string;
      provenance: { received_at: string };
    }[];
  }>({ op: "read_inbox", after: 0, limit: 50 });
  for (const m of page.messages)
    if (!m.from_self)
      enqueueOwnerMessage(dir, {
        id: "shared-test:" + m.message_id,
        at: m.provenance.received_at,
        text: m.text,
        origin: {
          kind: "peer_message",
          channel: "mind-shared-hub",
          author: m.from,
          senderRef: m.from,
          recipientRef: m.to,
          threadId: m.thread_id,
          messageId: m.message_id,
          correlationId: m.message_id,
        },
      });
}
async function proposal() {
  const task = await a.request(bRef, input, "peer-request-001");
  await deliver(bLink, bDir);
  b.ingest();
  return b.get(task.id);
}
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "peer-tasks-"));
  aDir = path.join(folder, "a");
  bDir = path.join(folder, "b");
  for (const d of [aDir, bDir]) fs.mkdirSync(d);
  const ka = randomBytes(24).toString("hex"),
    kb = randomBytes(24).toString("hex");
  hub = new Hub(
    parseHubConfig({
      parties: [
        {
          privateId: "atelier-a",
          kind: "agent",
          keyDigest: keyDigest(ka),
          permissions: { message: true, requestHelp: false, guide: false },
        },
        {
          privateId: "atelier-b",
          kind: "agent",
          keyDigest: keyDigest(kb),
          permissions: { message: true, requestHelp: false, guide: false },
        },
      ],
    }),
    folder,
  );
  const pa = hub.authenticate(ka),
    pb = hub.authenticate(kb);
  aRef = pa.ref;
  bRef = pb.ref;
  let seq = 0;
  const link = (party: typeof pa): SharedTaskLink => ({
    call: async (request) =>
      sharedPresentation(await hub.handle(party, { ...request, id: ++seq } as HubRequest)) as never,
  });
  aLink = link(pa);
  bLink = link(pb);
  paused = false;
  jobs = new Map();
  answer = "Résultat intégral retenu chez le destinataire.";
  launch = vi.fn((i) => {
    let r = jobs.get(i.idempotencyKey);
    if (!r) {
      r = {
        thread_id: "direct_" + digest(i.idempotencyKey).slice(0, 32),
        job_id: `job-${String(jobs.size)}`,
      };
      jobs.set(i.idempotencyKey, r);
    }
    return Promise.resolve(r);
  });
  a = new PeerTasks(
    aDir,
    () => policy(aRef),
    aLink,
    {
      launch: () => {
        throw Error("Sender cannot execute");
      },
      read: () => {
        throw Error("No sender helper");
      },
    },
    () => {},
  );
  b = newRecipient();
});
afterEach(() => {
  a.close();
  b.close();
  hub.close();
  vi.clearAllMocks();
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});
it("keeps proposal non-triggering through durable hub, owner hook and restart; only local acceptance launches once", async () => {
  const task = await proposal();
  expect(launch).not.toHaveBeenCalled();
  expect(task.state).toBe("received");
  const hook = takeOwnerMessages(bDir, "active-local-session");
  expect(hook[0]?.origin?.kind).toBe("peer_message");
  expect(hook[0]?.text).toContain(input.prompt.replace(/\n/g, "\\n"));
  b.close();
  b = newRecipient();
  b.ingest();
  expect(b.get(task.id).request.prompt).toBe(input.prompt);
  const action = {
    id: task.id,
    action: "accept" as const,
    promptHash: task.request.prompt_hash,
    target: "codex:chosen-local",
    key: "accept-task-001",
  };
  await Promise.all([b.decide(actor, action), b.decide(actor, action)]);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(jobs.size).toBe(1);
  expect(launch.mock.calls[0]?.[0].context).toContain(input.prompt);
  expect(b.get(task.id).state).toBe("running");
  await deliver(aLink, aDir);
  a.ingest();
  expect(a.get(task.id).state).toBe("requested");
  const local = b.refresh(actor, task.id);
  expect(local.state).toBe("review_pending");
  expect(local.results[0]?.text).toBe(answer);
  await deliver(aLink, aDir);
  a.ingest();
  expect(a.get(task.id).reply).toBeUndefined();
  const version = required(local.results[0]);
  await b.review(actor, {
    id: task.id,
    action: "amend",
    version: version.version,
    resultHash: version.hash,
    text: "Version amendée par responsable local.",
    key: "amend-task-001",
  });
  await deliver(aLink, aDir);
  a.ingest();
  expect(a.get(task.id).reply).toBeUndefined();
  const edited = required(b.get(task.id).results.at(-1));
  await b.review(actor, {
    id: task.id,
    action: "accept",
    version: edited.version,
    resultHash: edited.hash,
    key: "review-task-001",
  });
  await b.review(actor, {
    id: task.id,
    action: "accept",
    version: edited.version,
    resultHash: edited.hash,
    key: "review-task-001",
  });
  await deliver(aLink, aDir);
  a.ingest();
  expect(a.get(task.id).state).toBe("accepted_result");
  expect(a.get(task.id).reply?.text).toBe(edited.text);
  expect(a.get(task.id).reply?.result_version).toBe(2);
  expect(b.get(task.id).state).toBe("result_sent");
});
it("declines with explicit explanation and no job; a peer cannot decide by claiming a local identity in its body", async () => {
  const t = await proposal();
  await expect(
    b.decide(
      { kind: "agent", ref: aRef },
      {
        id: t.id,
        action: "accept",
        promptHash: t.request.prompt_hash,
        target: "codex:any",
        key: "forged-accept-001",
      },
    ),
  ).rejects.toThrow("capability");
  await b.decide(actor, {
    id: t.id,
    action: "decline",
    promptHash: t.request.prompt_hash,
    explanation: "Ce repo ne fait pas partie du mandat local.",
    key: "decline-task-001",
  });
  expect(launch).not.toHaveBeenCalled();
  await deliver(aLink, aDir);
  a.ingest();
  expect(a.get(t.id).state).toBe("declined");
});
it("rejects stale prompt/result hashes and oversize transport without truncation", async () => {
  await expect(
    a.request(bRef, { ...input, prompt: "x".repeat(4000) }, "oversize-task-001"),
  ).rejects.toThrow("exceeds");
  expect(a.list()).toHaveLength(0);
  const t = await proposal();
  await expect(
    b.decide(actor, {
      id: t.id,
      action: "accept",
      promptHash: digest("forged"),
      target: "codex:local",
      key: "stale-accept-001",
    }),
  ).rejects.toThrow("revision");
  await b.decide(actor, {
    id: t.id,
    action: "accept",
    promptHash: t.request.prompt_hash,
    target: "codex:local",
    key: "good-accept-001",
  });
  answer = "a".repeat(7000);
  const held = b.refresh(actor, t.id),
    r = required(held.results[0]);
  await expect(
    b.review(actor, {
      id: t.id,
      action: "accept",
      version: 1,
      resultHash: r.hash,
      key: "oversize-review-001",
    }),
  ).rejects.toThrow("exceeds");
  expect(b.get(t.id).state).toBe("review_pending");
  expect(b.get(t.id).results[0]?.text).toHaveLength(7000);
});
it("Pause blocks execution; uncertain launch requires explicit resume and reuses the same supervised job key", async () => {
  const t = await proposal(),
    decision = {
      id: t.id,
      action: "accept" as const,
      promptHash: t.request.prompt_hash,
      target: "codex:local",
      key: "pause-accept-001",
    };
  paused = true;
  await expect(b.decide(actor, decision)).rejects.toThrow("paused");
  expect(launch).not.toHaveBeenCalled();
  paused = false;
  const original = required(launch.getMockImplementation());
  launch.mockImplementationOnce(async (i) => {
    await original(i);
    throw Error("uncertain local submit");
  });
  await expect(b.decide(actor, decision)).rejects.toThrow("uncertain");
  expect(b.get(t.id).state).toBe("interrupted");
  expect(jobs.size).toBe(1);
  b.close();
  b = newRecipient();
  b.ingest();
  b.list();
  expect(launch).toHaveBeenCalledTimes(1);
  await b.decide(actor, { ...decision, action: "resume", key: "explicit-resume-001" });
  expect(jobs.size).toBe(1);
  expect(b.get(t.id).state).toBe("running");
});
it("relaunch keeps the accepted scope, archives the prior attempt and needs a new review", async () => {
  const t = await proposal();
  await b.decide(actor, {
    id: t.id,
    action: "accept",
    promptHash: t.request.prompt_hash,
    target: "codex:local",
    key: "accept-relaunch-001",
  });
  const held = b.refresh(actor, t.id),
    r = required(held.results[0]);
  await b.review(actor, {
    id: t.id,
    action: "relaunch",
    version: 1,
    resultHash: r.hash,
    key: "relaunch-attempt-002",
  });
  const next = b.get(t.id);
  expect(next.attempt).toBe(2);
  expect(next.previousAttempts?.[0]?.results[0]?.text).toBe(answer);
  expect(next.target).toBe("codex:local");
  expect(jobs.size).toBe(2);
  expect(next.reply).toBeUndefined();
});
it("ignores plain/forged origin and never elevates copied context into an incoming proposal", async () => {
  const t = await a.request(bRef, input, "origin-test-001");
  const real = required(
    (await bLink.call<{ messages: { text: string }[] }>({ op: "read_inbox", after: 0, limit: 50 }))
      .messages[0],
  ).text;
  enqueueOwnerMessage(bDir, { id: "body-only", at: new Date().toISOString(), text: real });
  expect(b.ingest()).toBe(0);
  expect(b.list()).toEqual([]);
  await deliver(bLink, bDir);
  const historic = required(readOwnerInboxHistory(bDir).find((m) => m.origin));
  b.ingest([{ ...historic, origin: { ...required(historic.origin), kind: "context_copy" } }]);
  expect(b.list()).toEqual([]);
  b.ingest();
  expect(b.get(t.id).state).toBe("received");
  expect(launch).not.toHaveBeenCalled();
});
it("uses the actual guarded queueDirectAdvice and local result journal, with a substituted provider", async () => {
  seedSimulatedProfile(bDir, { hostUnsandboxed: true });
  const env = {
    MIND_WAKE_DATA_DIR: bDir,
    MIND_WAKE_BACKGROUND_JOBS: "1",
    MIND_WAKE_HELPERS_DIR: path.join(bDir, "helpers"),
  };
  const session: IndexedSession = {
    runtime: "codex",
    sessionId: "local-authorized",
    cwd: path.join(folder, "repo"),
    file: path.join(folder, "transcript"),
    updatedAt: new Date().toISOString(),
    mtimeMs: Date.now(),
    terms: {},
  };
  vi.mocked(refreshIndex).mockResolvedValue({ sessions: [session], reread: 0 });
  b.close();
  b = newRecipient(
    { launch: (i) => queueDirectAdvice(env, i), read: (id) => readDirectThread(env, id) },
    () => {
      directProfile(env, true);
    },
  );
  const t = await proposal();
  const accepted = await b.decide(actor, {
    id: t.id,
    action: "accept",
    promptHash: t.request.prompt_hash,
    target: "codex:local-authorized",
    key: "native-queue-accept-001",
  });
  const store = new BackgroundJobStore(bDir);
  try {
    expect(store.list()).toHaveLength(1);
  } finally {
    store.close();
  }
  const request = JSON.parse(
    fs.readFileSync(
      path.join(bDir, "direct-advice", required(accepted.helperThreadId) + ".json"),
      "utf8",
    ),
  ) as DirectRequest;
  await executeDirectAdvice(
    bDir,
    request,
    [session],
    vi.fn().mockResolvedValue({
      ok: true,
      text: "Résultat complet du fournisseur substitué",
      detail: "test",
    }),
  );
  expect(b.refresh(actor, t.id).state).toBe("review_pending");
  expect(a.get(t.id).reply).toBeUndefined();
  stop(processContext(), { path: bDir, source: "option" });
  const r = required(b.get(t.id).results[0]);
  await expect(
    b.review(actor, {
      id: t.id,
      action: "accept",
      version: 1,
      resultHash: r.hash,
      key: "stopped-review-001",
    }),
  ).rejects.toThrow("paused or stopped");
});
