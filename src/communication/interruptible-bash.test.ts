/** Interruptible Bash: real Git Bash and a local inbox fixture; no model call. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashJobDir,
  interruptibleCommand,
  pendingMessageIds,
  rewriteBashHook,
} from "./interruptible-bash.js";

const BASH = process.env["CLAUDE_CODE_GIT_BASH_PATH"] ?? "C:/Program Files/Git/bin/bash.exe";
const SCRIPT = path.resolve("src/communication/interruptible-bash.ts");
let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "interruptible-bash-"));
  const db = new Database(path.join(dataDir, "owner-inbox.sqlite"));
  db.exec("CREATE TABLE inbox(id TEXT PRIMARY KEY, emitted_session TEXT)");
  db.close();
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const message = (id: string) => {
  const db = new Database(path.join(dataDir, "owner-inbox.sqlite"));
  db.prepare("INSERT INTO inbox(id) VALUES(?)").run(id);
  db.close();
};
const event = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  session_id: "s1",
  tool_input: { command, description: "test", ...extra },
});

describe("rewriteBashHook", () => {
  it("rewrites only the main session's foreground Bash calls", () => {
    const out = rewriteBashHook(
      dataDir,
      "s1",
      "node",
      "hook.js",
      event("make build", { timeout: 9000 }),
      "id1",
    ) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: Record<string, unknown> };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toMatchObject({
      description: "test",
      timeout: 9000,
    });
    expect(String(out.hookSpecificOutput.updatedInput["command"])).toContain("make build\n");
    expect(rewriteBashHook(dataDir, "other", "node", "hook.js", event("ls"))).toBeNull();
    expect(
      rewriteBashHook(dataDir, "s1", "node", "hook.js", { ...event("ls"), agent_id: "a" }),
    ).toBeNull();
    expect(
      rewriteBashHook(dataDir, "s1", "node", "hook.js", event("ls", { run_in_background: true })),
    ).toBeNull();
    expect(rewriteBashHook(dataDir, "s1", "node", "hook.js", event("cd sub"))).toBeNull();
    expect(rewriteBashHook(dataDir, "s1", "node", "hook.js", event("cd sub && ls"))).not.toBeNull();
  });
});

describe("pendingMessageIds", () => {
  it("includes published fast replies not yet injected and a due Duo reminder", () => {
    message("ui-1");
    const fast = new Database(path.join(dataDir, "fast-reply.sqlite"));
    fast.exec("CREATE TABLE replies(message_id TEXT, state TEXT, injected INTEGER)");
    fast.prepare("INSERT INTO replies VALUES(?,?,?)").run("r1", "replied", 0);
    fast.prepare("INSERT INTO replies VALUES(?,?,?)").run("r2", "replied", 1);
    fast.prepare("INSERT INTO replies VALUES(?,?,?)").run("r3", "pending", 0);
    fast.close();
    const now = 1_000_000;
    fs.writeFileSync(path.join(dataDir, "duo.json"), JSON.stringify({ enabled: true }));
    const duo = new Database(path.join(dataDir, "duo-runtime.sqlite"));
    duo.exec(
      "CREATE TABLE duo(id INTEGER PRIMARY KEY, fingerprint TEXT, since INTEGER, last_sent INTEGER, eligible_until INTEGER, claim TEXT, claimed_at INTEGER, reminded INTEGER)",
    );
    duo
      .prepare("INSERT INTO duo VALUES(1,'f',?,?,?,NULL,NULL,0)")
      .run(now - 40_000, now - 40_000, now + 2000);
    duo.close();
    expect(pendingMessageIds(dataDir, now)).toEqual([
      "ui-1",
      "fast:r1",
      `duo:${String(now - 40_000)}:${String(now - 40_000)}`,
    ]);
    // Visual content changed 10 s ago: no reminder due yet.
    expect(pendingMessageIds(dataDir, now - 30_000)).toEqual(["ui-1", "fast:r1"]);
  });
});

describe.skipIf(!fs.existsSync(BASH))("rewritten command in Git Bash", () => {
  const run = (command: string, cwd: string) =>
    new Promise<{ code: number; out: string; ms: number }>((resolve) => {
      const started = Date.now();
      const child = spawn(BASH, ["-c", command], { cwd });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (out += c.toString()));
      child.on("close", (code) => {
        resolve({ code: code ?? -1, out, ms: Date.now() - started });
      });
    });
  const wrap = (command: string, id: string) => {
    fs.mkdirSync(bashJobDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(bashJobDir(dataDir), `${id}.seen`), "[]");
    return interruptibleCommand({
      command,
      id,
      jobDir: bashJobDir(dataDir),
      node: process.execPath,
      script: SCRIPT,
      dataDir,
    });
  };

  it("keeps output, exit status and the final directory of a completed command", async () => {
    fs.mkdirSync(path.join(dataDir, "sub"));
    const result = await run(
      `${wrap("cd sub && echo bonjour; (exit 3)", "c1")}\necho "status=$? dir=$(basename "$(pwd)")"`,
      dataDir,
    );
    expect(result.out).toContain("bonjour");
    expect(result.out).toContain("status=3 dir=sub");
    expect(fs.readdirSync(bashJobDir(dataDir)).filter((f) => f.startsWith("c1"))).toEqual([]);
  }, 30_000);

  it("returns as soon as a new human message arrives and lets the command finish", async () => {
    const marker = path.join(dataDir, "fini.txt").replace(/\\/g, "/");
    const pending = run(wrap(`echo debut; sleep 6; echo fin > '${marker}'`, "y1"), dataDir);
    await new Promise((r) => setTimeout(r, 1500));
    message("m1");
    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.out).toContain("debut");
    expect(result.out).toContain("[MIND Wake] Nouveau message");
    expect(result.ms).toBeLessThan(5000);
    expect(fs.existsSync(marker)).toBe(false);
    await new Promise((r) => setTimeout(r, 6000));
    expect(fs.readFileSync(marker, "utf8").trim()).toBe("fin");
  }, 30_000);

  it("also yields to a message from another agent", async () => {
    const pending = run(wrap("sleep 6; echo fin", "a1"), dataDir);
    await new Promise((r) => setTimeout(r, 1500));
    message("shared-inbox:hub:peer-1");
    const result = await pending;
    expect(result.out).toContain("autre agent");
    expect(result.ms).toBeLessThan(5000);
  }, 30_000);

  it("ignores a message that was already pending when the command started", async () => {
    message("old");
    fs.mkdirSync(bashJobDir(dataDir), { recursive: true });
    const out = rewriteBashHook(
      dataDir,
      "s1",
      process.execPath,
      SCRIPT,
      event("sleep 2; echo ok"),
      "o1",
    ) as {
      hookSpecificOutput: { updatedInput: { command: string } };
    };
    const result = await run(out.hookSpecificOutput.updatedInput.command, dataDir);
    expect(result.out).toContain("ok");
    expect(result.out).not.toContain("Nouveau message");
  }, 30_000);
});
