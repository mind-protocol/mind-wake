/**
 * Origine automatique des jobs (mandat Viz, 18 nov. 2026) : chaque `start_background_job`
 * enregistre qui l'a lancé, la salle, la session, le message déclencheur et le job parent, sans
 * que l'agent ait à le fournir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { openStore } from "../src/store/index.js";
import { controlDbPath } from "../src/daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../src/cli/context.js";
import type { ConsentId, PolicyRevisionId } from "../src/contracts/index.js";
import { createProfile, policyGroups, ts } from "./fixtures/store-ledger/setup.js";
import { registerBackgroundTools } from "../services/mcp/background-tools.js";
import { registerRoomAgentJobTools } from "../services/mcp/room-agent-jobs.js";
import { BackgroundJobStore, type BackgroundJob } from "../src/daemon/background-jobs.js";
import {
  saveForkAssignment,
  roomAgentMcpConfig,
  resolveRoomAgents,
} from "../src/daemon/fork-assignment.js";
import {
  autoJobOrigin,
  jobOriginEnv,
  withTurnOriginEnv,
  TURN_TRIGGER_ENV,
  type JobOrigin,
} from "../src/daemon/job-origin.js";
import { roomTurnTrigger } from "../src/daemon/room-agents.js";
import {
  claimOwnerMessages,
  confirmOwnerClaim,
  enqueueOwnerMessage,
} from "../src/communication/owner-inbox.js";

type Handler = (args: Record<string, unknown>, extra?: unknown) => unknown;
let dir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-job-origin-"));
  workspace = path.join(dir, "workspace");
  fs.mkdirSync(path.join(workspace, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "jobs", "task.mjs"), "");
  // Wake actif, mode hôte reconnu : les outils de jobs acceptent de soumettre.
  const store = openStore(controlDbPath(dir));
  try {
    createProfile(store.uow, DEFAULT_PROFILE_ID);
    const defaults = policyGroups();
    const rev = "rev-origin" as PolicyRevisionId;
    store.uow.policies.appendRevision({
      schemaVersion: 1,
      id: rev,
      profileId: DEFAULT_PROFILE_ID,
      previousRevisionId: null,
      createdAt: ts("2026-11-18T00:00:00Z"),
      groups: {
        ...defaults,
        identity: { ...defaults.identity, profileId: DEFAULT_PROFILE_ID },
        runtime: { ...defaults.runtime, hostUnsandboxedAcknowledged: true },
      },
    });
    store.uow.policies.recordConsent({
      id: "consent-origin" as ConsentId,
      revisionId: rev,
      grantedAt: ts("2026-11-18T00:00:00Z"),
      channel: "local_cli",
      proof: "test",
    });
    store.db
      .prepare("UPDATE profiles SET state='ready',active_policy_revision_id=? WHERE id=?")
      .run(rev, DEFAULT_PROFILE_ID);
  } finally {
    store.close();
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function tools(register: (server: McpServer) => void): Map<string, Handler> {
  const map = new Map<string, Handler>();
  register({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      map.set(name, handler);
    },
  } as unknown as McpServer);
  return map;
}
async function call(
  tool: Handler | undefined,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await tool!(args)) as { isError?: boolean; content: { text: string }[] };
  const body = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
  if (response.isError === true) throw Error(String(body["error"]));
  return body;
}
const record = (job: BackgroundJob) =>
  JSON.parse(fs.readFileSync(path.join(workspace, "jobs", "runs", job.id, "job.json"), "utf8")) as {
    id: string;
    origin: JobOrigin;
  };

describe("automatic job origin", () => {
  it("records a job launched by the principal: session, last delivered human message, no room", async () => {
    enqueueOwnerMessage(dir, {
      id: "ui-nlr-1543",
      at: "2026-11-18T15:43:00Z",
      text: "lance le bilan",
    });
    claimOwnerMessages(dir, "claude-session", "claim-1");
    confirmOwnerClaim(dir, "claude-session", "claim-1");
    const env = {
      MIND_WAKE_DATA_DIR: dir,
      MIND_WAKE_BACKGROUND_JOBS: "1",
      MIND_WAKE_SESSION: "wake-session-1",
    };
    const t = tools((server) => {
      registerBackgroundTools(server, env);
    });
    const { job } = (await call(t.get("start_background_job"), {
      title: "Bilan",
      script: "jobs/task.mjs",
      args: [],
      idempotency_key: "principal-key-1",
      relaunch: false,
    })) as { job: BackgroundJob };
    expect(job.origin).toMatchObject({
      schema: "mind.job-origin/1",
      launchedBy: "principal",
      launcher: { kind: "principal", agentId: null, signature: null },
      room: null,
      session: "wake-session-1",
      trigger: { id: "ui-nlr-1543", kind: "human", basis: "last-delivered" },
      parent: null,
      rootJobId: null,
      declared: null,
    });
    // Exposée dans list_background_jobs et dans jobs/runs/<id>/job.json.
    const listed = (await call(t.get("list_background_jobs"), {})) as { jobs: BackgroundJob[] };
    expect(listed.jobs[0]?.origin).toEqual(job.origin);
    expect(record(job).origin).toEqual(job.origin);
    // Le principal garde la convention existante : MIND_WAKE_JOB_ORIGIN absent.
    expect(jobOriginEnv(job.origin)).toEqual({
      MIND_WAKE_JOB_ORIGIN_AUTO: JSON.stringify(job.origin),
    });
  });

  it("does not depend on the agent's declaration, but keeps it apart", async () => {
    const env = { MIND_WAKE_DATA_DIR: dir, MIND_WAKE_BACKGROUND_JOBS: "1" };
    const t = tools((server) => {
      registerBackgroundTools(server, env);
    });
    const { job } = (await call(t.get("start_background_job"), {
      title: "Déclaré",
      script: "jobs/task.mjs",
      args: [],
      idempotency_key: "principal-key-2",
      relaunch: false,
      why: "Viz a besoin du lien",
      trigger_message_id: "forged-id",
    })) as { job: BackgroundJob };
    expect(job.origin?.launcher.kind).toBe("principal");
    expect(job.origin?.trigger).toBeNull();
    expect(job.origin?.declared).toEqual({
      why: "Viz a besoin du lien",
      triggerMessageId: "forged-id",
    });
  });

  it("records a job launched by a room agent with its id, room, turn session and trigger", async () => {
    const project = path.join(workspace, "artifacts", "projets", "recrutement");
    const own = path.join(project, "agents", "manager");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "SYSTEM.md"), "Manager.");
    fs.writeFileSync(path.join(own, "mandate.md"), "Tâche.");
    fs.writeFileSync(path.join(project, "ROOM.md"), "Room");
    fs.writeFileSync(path.join(workspace, "jobs", "room-agent-sous-session.mjs"), "");
    const assignment = saveForkAssignment(path.join(dir, "forks", "4"), {
      workspace: project,
      instructions: path.join(project, "ROOM.md"),
      engine: "claude",
      inbox: "explicit",
      agents: [
        {
          id: "manager",
          name: "Manager",
          instructions: path.join(own, "SYSTEM.md"),
          writable: ["agents/manager"],
          tools: "none",
          owner: { colony: null, profile: "publish" },
        },
      ],
    });
    fs.writeFileSync(
      path.join(workspace, "artifacts", "projets-compteur.json"),
      JSON.stringify({
        projects: {
          recrutement: {
            room: 4,
            status: "en cours",
            capabilities: { roleTools: { agents: ["manager"], backgroundJobs: true } },
          },
        },
      }),
    );
    // Env tel que le daemon le pose : config MCP de l'agent + session et déclencheur du tour.
    const trigger = roomTurnTrigger(
      4,
      [
        { id: 11, at: "2026-11-18T15:40:00Z" },
        { id: 12, at: "2026-11-18T15:43:00Z" },
      ],
      [],
      () => null,
    ).trigger!;
    const config = withTurnOriginEnv(
      roomAgentMcpConfig(
        4,
        dir,
        resolveRoomAgents(assignment)[0]!,
        process.execPath,
        process.cwd(),
      ),
      { MIND_WAKE_SESSION: "claude-room-session", [TURN_TRIGGER_ENV]: JSON.stringify(trigger) },
    );
    const env = (JSON.parse(config!) as { mcpServers: { mind: { env: Record<string, string> } } })
      .mcpServers.mind.env;
    expect(env["MIND_WAKE_OWNER_AGENT"]).toBe("manager");
    const t = tools((server) => {
      registerRoomAgentJobTools(server, env, "Manager");
    });
    const { job } = (await call(t.get("start_background_job"), {
      title: "Sous-tâche",
      mandate: "mandate.md",
      why: "le bilan",
      idempotency_key: "room-key-1",
    })) as { job: BackgroundJob };
    expect(job.origin).toMatchObject({
      launchedBy: "Manager",
      launcher: { kind: "room-agent", agentId: "manager", signature: "Manager" },
      room: "room:4",
      roomNumber: 4,
      session: "claude-room-session",
      trigger: { id: "room4:entry:12", kind: "human", basis: "turn", at: "2026-11-18T15:43:00Z" },
      parent: null,
      declared: { why: "le bilan" },
    });
    expect(record(job).origin).toEqual(job.origin);
    const listed = (await call(t.get("list_background_jobs"), {})) as { jobs: BackgroundJob[] };
    expect(listed.jobs.map((j) => j.origin?.launcher.agentId)).toEqual(["manager"]);
    const scriptEnv = jobOriginEnv(job.origin);
    expect(JSON.parse(scriptEnv["MIND_WAKE_JOB_ORIGIN"]!)).toMatchObject({
      launchedBy: "Manager",
      room: "room:4",
    });
  });

  it("records a job launched from another job: parent, root, inherited room", async () => {
    const store = new BackgroundJobStore(dir);
    let root: BackgroundJob, middle: BackgroundJob;
    try {
      root = store.submit("Racine", "jobs/task.mjs", [], "root-key-1", {
        origin: autoJobOrigin({
          MIND_WAKE_OWNER_SIGNATURE: "VOX (Room 7)",
          MIND_WAKE_DESKTOP_ROOM: "7",
          MIND_WAKE_OWNER_FORK: "7",
        }),
      });
      middle = store.submit("Milieu", "jobs/task.mjs", [], "middle-key-1", {
        origin: autoJobOrigin({ MIND_WAKE_JOB_ID: root.id }, { lookupJob: (id) => store.get(id) }),
      });
    } finally {
      store.close();
    }
    expect(root.origin).toMatchObject({
      launchedBy: "VOX (Room 7)",
      launcher: { kind: "room-agent", agentId: null },
      room: "room:7",
    });
    // Le job lancé depuis un job : MCP d'une sous-session, MIND_WAKE_JOB_ID hérité de son job.
    const env = {
      MIND_WAKE_DATA_DIR: dir,
      MIND_WAKE_BACKGROUND_JOBS: "1",
      MIND_WAKE_JOB_ID: middle.id,
    };
    const t = tools((server) => {
      registerBackgroundTools(server, env);
    });
    const { job } = (await call(t.get("start_background_job"), {
      title: "Petit-enfant",
      script: "jobs/task.mjs",
      args: [],
      idempotency_key: "child-key-1",
      relaunch: false,
    })) as { job: BackgroundJob };
    expect(middle.origin).toMatchObject({
      parent: { jobId: root.id, title: "Racine", launchedBy: "VOX (Room 7)", room: "room:7" },
      rootJobId: root.id,
      room: "room:7",
    });
    expect(job.origin).toMatchObject({
      launcher: { kind: "principal" },
      parent: { jobId: middle.id, title: "Milieu" },
      rootJobId: root.id,
      room: "room:7",
      // Pas de « dernier message du principal » pour un job lancé depuis un job.
      trigger: null,
    });
    expect(record(job).origin.parent?.jobId).toBe(middle.id);
  });

  it("keeps the origin across a relaunch and leaves file-based MCP configs untouched", () => {
    const store = new BackgroundJobStore(dir);
    try {
      const origin = autoJobOrigin({ MIND_WAKE_SESSION: "s" });
      const loop = store.submit("Boucle", "jobs/task.mjs", [], "loop-key-1", {
        relaunch: true,
        origin,
      });
      store.update(loop.id, { status: "interrupted" });
      const [next] = store.relaunchInterrupted();
      expect(next?.origin).toEqual(origin);
    } finally {
      store.close();
    }
    expect(withTurnOriginEnv("C:/config.json", { A: "1" })).toBe("C:/config.json");
    expect(withTurnOriginEnv(undefined, { A: "1" })).toBeUndefined();
    expect(
      roomTurnTrigger(
        2,
        [{ id: 3, at: "2026-11-18T10:00:00Z" }],
        [{ key: "k", at: "2026-11-18T11:00:00Z" }],
        () => null,
      ).trigger,
    ).toMatchObject({ id: "room2:relay:k", kind: "peer" });
  });
});
