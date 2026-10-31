import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PolicyRevision, ProfileId } from "../contracts/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";
import {
  conversationOwnerEnv,
  conversationWorkerCommand,
  serveConversationOwner,
  type ConversationOwnerStarted,
} from "./owner.js";
import type { RuntimeInspection } from "./role-runtime.js";

let dir: string;
const profileId = "conversation-owner-fixture" as ProfileId;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-conversation-owner-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const inspect = (): RuntimeInspection => ({
  allowed: true,
  workspaceDir: dir,
  profileId,
  revision: {
    id: "owner-fixture-revision",
    groups: { filesAndTools: { maxProcesses: 3 } },
  } as PolicyRevision,
});
const env = () => conversationOwnerEnv(process.env);

it("refuses a blocked profile before constructing or spawning any provider process", async () => {
  const spawn = vi.fn();
  await expect(
    serveConversationOwner(dir, "main", {
      inspect: () => ({ allowed: false, reason: "force_off" }),
      supervisor: { available: true, spawn, query: vi.fn() },
    }),
  ).rejects.toMatchObject({ code: "blocked", reason: "force_off" });
  expect(spawn).not.toHaveBeenCalled();
});
it("fails closed if the global process supervisor is unavailable", async () => {
  const spawn = vi.fn();
  await expect(
    serveConversationOwner(dir, "main", {
      inspect,
      supervisor: { available: false, spawn, query: vi.fn() },
    }),
  ).rejects.toMatchObject({ code: "blocked", reason: "global_process_supervisor_unavailable" });
  expect(spawn).not.toHaveBeenCalled();
});
it("preserves native runtime configuration and builds a source worker import as a file URL", () => {
  const inherited = conversationOwnerEnv({
    PATH: "native-path",
    CODEX_HOME: "native-codex",
    CLAUDE_CONFIG_DIR: "native-claude",
    MIND_WAKE_CLAUDE_MCP_CONFIG: "native-mcp",
    MIND_SHARED_LINK_KEY: "private",
    OPENAI_API_KEY: "private",
  });
  expect(inherited).toEqual({
    PATH: "native-path",
    CODEX_HOME: "native-codex",
    CLAUDE_CONFIG_DIR: "native-claude",
    MIND_WAKE_CLAUDE_MCP_CONFIG: "native-mcp",
  });
  const command = conversationWorkerCommand(dir, "main");
  const importAt = command.args.indexOf("--import");
  expect(importAt).toBeGreaterThan(-1);
  expect(command.args[importAt + 1]).toMatch(/^file:\/\//);
  expect(command.args).not.toContain("--resume");
  expect(command.env?.["MIND_WAKE_DATA_DIR"]).toBe(dir);
});

it.runIf(process.platform === "win32")(
  "fails closed on an aggregate limit violation across nested role jobs and kills the entire cooperation",
  async () => {
    // Real Windows Job Objects, disposable Node fixtures only. No model or account use.
    const nestedDir = path.join(dir, "nested-runtime");
    const nestedSupervisor = new ProcessTreeSupervisor(nestedDir);
    expect(nestedSupervisor.available).toBe(true);
    const supervisor = new ProcessTreeSupervisor(path.join(dir, "conversation-runtime"));
    expect(supervisor.available).toBe(true);
    const source = fileURLToPath(new URL("../runner/process-tree.ts", import.meta.url));
    const hooks = fileURLToPath(
      new URL("../../test/fixtures/store-ledger/ts-hooks.ts", import.meta.url),
    );
    const fixture = path.join(dir, "nested-worker.mjs");
    const overLimit = `console.log(JSON.stringify({event:'nested_code_started',pid:process.pid}));
    let spawn;try{({spawn}=require('node:child_process'));}catch(e){console.log(JSON.stringify({event:'nested_import_error',error:String(e)}));process.exit(8);}
    let p;try{p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});}
    catch(e){console.log(JSON.stringify({event:'over_limit_error',code:e.code,error:String(e)}));}
    if(p){p.once('error',e=>console.log(JSON.stringify({event:'over_limit_error',code:e.code,error:String(e)})));
    p.once('exit',code=>console.log(JSON.stringify({event:'over_limit_stopped',pid:p.pid,code})));}
    setInterval(()=>{},1000);`;
    fs.writeFileSync(
      fixture,
      `import {ProcessTreeSupervisor} from ${JSON.stringify(pathToFileURL(source).href)};
    const supervisor=new ProcessTreeSupervisor(${JSON.stringify(nestedDir)});
    const p=supervisor.spawn(${JSON.stringify(profileId)},'nested-role',{
      executable:process.execPath,args:['-e',${JSON.stringify(overLimit)}],env:${JSON.stringify(env())}});
    const pid=await p.started();
    console.log(JSON.stringify({event:'nested_started',workerPid:process.pid,nestedPid:pid}));
    let line;while((line=await p.readLine())!==null)console.log(line);
    console.log(JSON.stringify({event:'nested_exit',exit:await p.exited}));`,
    );
    let owner: ConversationOwnerStarted | undefined;
    let workerPid: number | undefined, nestedPid: number | undefined;
    const counts: number[] = [];
    const observed: string[] = [];
    const result = await serveConversationOwner(dir, "main", {
      inspect,
      supervisor: {
        available: supervisor.available,
        spawn: (p, s, c) => supervisor.spawn(p, s, c),
        query: (p, s) => {
          const result = supervisor.query(p, s);
          if (result.active !== null) counts.push(result.active);
          return result;
        },
      },
      pollMs: 10,
      onStarted: (value) => {
        owner = value;
      },
      command: {
        executable: process.execPath,
        args: [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          "--import",
          pathToFileURL(hooks).href,
          fixture,
        ],
        env: env(),
        cwd: dir,
        maxProcesses: 99,
      },
      onLog: (line) => {
        observed.push(line);
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (row["event"] === "nested_started") {
          workerPid = Number(row["workerPid"]);
          nestedPid = Number(row["nestedPid"]);
        }
      },
    });
    expect(
      counts.some((n) => n > 3),
      JSON.stringify({ observed, result, counts }),
    ).toBe(true);
    expect(owner?.maxProcesses).toBe(3); // Caller/nested limits cannot loosen the parent policy.
    expect(result.stopReason).toBe("global_process_limit_exceeded");
    expect(result.processControl).toMatchObject({
      enforcement: "observed_fail_closed",
      transientOvershootPossible: true,
      aggregateLimit: 3,
    });
    expect(result.processControl.largestObserved).toBeGreaterThan(3);
    // A limit can be detected before the nested worker has time to print its PID.
    for (const pid of [result.pid, workerPid, nestedPid].filter(
      (n): n is number => n !== undefined,
    )) {
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }
    if (owner) expect(supervisor.query(owner.profileId, owner.sessionId).active ?? 0).toBe(0);
  },
  40_000,
);

it.runIf(process.platform === "win32")(
  "terminates the owned worker when the human Force-off arrives",
  async () => {
    let blocked = false;
    const result = await serveConversationOwner(dir, "main", {
      inspect: () => (blocked ? { allowed: false, reason: "force_off" } : inspect()),
      pollMs: 10,
      onStarted: () => {
        blocked = true;
      },
      onLog: () => {},
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: env(),
        cwd: dir,
      },
    });
    expect(result.stopReason).toBe("force_off");
    expect(() => process.kill(result.pid, 0)).toThrow();
  },
  20_000,
);

it.runIf(process.platform === "win32")(
  "returns after its worker crashes without automatically restarting it",
  async () => {
    const launched = vi.fn();
    const result = await serveConversationOwner(dir, "main", {
      inspect,
      onStarted: launched,
      command: {
        executable: process.execPath,
        args: ["-e", "process.exit(7)"],
        env: env(),
        cwd: dir,
      },
      onLog: () => {},
    });
    expect(result.exit.mainExitCode).toBe(7);
    expect(launched).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBeUndefined();
  },
  20_000,
);
