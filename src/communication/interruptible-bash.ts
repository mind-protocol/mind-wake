/**
 * Bash calls that yield to a newly arrived message. A trusted PreToolUse hook rewrites each Bash
 * call of the main Claude session: the command runs as a background job of the same shell,
 * its output goes to a log file, and a watcher streams that log. When a message arrives in the
 * owner inbox (human, or another agent through the shared inbox, peers, coach, advice…)
 * that was not already pending at the start, the watcher returns at once while the command
 * keeps running; PostToolUse then delivers the message. Nothing is killed. A completed command
 * keeps its output, exit status and final working directory. Paths come from launcher args.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const INBOX = "owner-inbox.sqlite";
/** Builtins whose whole point is the calling shell's state: left untouched. */
const SHELL_STATE =
  /^\s*(cd|export|source|\.|alias|unalias|unset|set|shopt|pushd|popd|ulimit|umask)(\s|$)/;

export function bashJobDir(dataDir: string): string {
  return path.join(dataDir, "runtimes", "claude", "bash");
}

const quote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;

/** Shell text of the rewritten call; the original command is kept byte for byte. */
export function interruptibleCommand(input: {
  command: string;
  id: string;
  jobDir: string;
  node: string;
  script: string;
  dataDir: string;
  /** Options Node avant le script (chargeur TypeScript hors compilation). */
  nodeArgs?: readonly string[];
}): string {
  const dir = quote(input.jobDir),
    id = quote(input.id);
  return [
    `__mw_d=${dir}; __mw_i=${id}; __mw_b="$__mw_d/$__mw_i"`,
    `{ ( ${input.command}`,
    `__mw_r=$?; pwd > "$__mw_b.cwd"; exit $__mw_r ) > "$__mw_b.log" 2>&1 < /dev/null; echo $? > "$__mw_b.rc"; } > /dev/null 2>&1 < /dev/null &`,
    `disown 2>/dev/null`,
    `${[input.node, ...(input.nodeArgs ?? []), input.script].map(quote).join(" ")} --watch-bash ${quote(input.dataDir)} "$__mw_d" "$__mw_i"; __mw_s=$?`,
    `if [ -f "$__mw_b.rc" ]; then [ -f "$__mw_b.cwd" ] && cd "$(cat "$__mw_b.cwd")"; rm -f "$__mw_b.log" "$__mw_b.rc" "$__mw_b.cwd" "$__mw_b.seen"; fi`,
    `(exit $__mw_s)`,
  ].join("\n");
}

/** PreToolUse decision for the expected main session, or null to leave the call as is. */
export function rewriteBashHook(
  dataDir: string,
  expectedSession: string,
  node: string,
  script: string,
  event: unknown,
  id: string = randomUUID(),
  nodeArgs: readonly string[] = [],
): object | null {
  if (event === null || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e["hook_event_name"] !== "PreToolUse" || e["tool_name"] !== "Bash") return null;
  if (e["session_id"] !== expectedSession || e["agent_id"] !== undefined) return null;
  const input = e["tool_input"];
  if (input === null || typeof input !== "object") return null;
  const toolInput = input as Record<string, unknown>;
  const command = toolInput["command"];
  if (
    typeof command !== "string" ||
    command.trim() === "" ||
    toolInput["run_in_background"] === true
  )
    return null;
  if (SHELL_STATE.test(command) && !/[\n;&|]/.test(command)) return null;
  const jobDir = bashJobDir(dataDir);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, `${id}.seen`), JSON.stringify(pendingMessageIds(dataDir)));
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Bash call made interruptible by a new human message",
      updatedInput: {
        ...toolInput,
        command: interruptibleCommand({ command, id, jobDir, node, script, dataDir, nodeArgs }),
      },
    },
  };
}

/** Read-only query of a local store; a missing or busy store yields nothing. */
function query<T>(dataDir: string, file: string, sql: string): T[] {
  const full = path.join(dataDir, file);
  if (!fs.existsSync(full)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(full, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Everything the PostToolUse hook would deliver now, without consuming it: inbox messages
 * (human and other agents), published fast replies not yet injected, and a due Duo reminder
 * (same conditions as claimDuoReminder).
 */
export function pendingMessageIds(dataDir: string, now = Date.now()): string[] {
  const inbox = query<{ id: string }>(
    dataDir,
    INBOX,
    "SELECT id FROM inbox WHERE emitted_session IS NULL",
  ).map((r) => r.id);
  const fast = query<{ message_id: string }>(
    dataDir,
    "fast-reply.sqlite",
    "SELECT message_id FROM replies WHERE state='replied' AND injected=0",
  ).map((r) => `fast:${r.message_id}`);
  let duo: string[] = [];
  try {
    const enabled =
      (JSON.parse(fs.readFileSync(path.join(dataDir, "duo.json"), "utf8")) as { enabled?: unknown })
        .enabled === true;
    if (enabled)
      duo = query<{
        since: number;
        last_sent: number;
        eligible_until: number;
        claim: string | null;
        claimed_at: number | null;
        reminded: number;
      }>(
        dataDir,
        "duo-runtime.sqlite",
        "SELECT since,last_sent,eligible_until,claim,claimed_at,reminded FROM duo WHERE id=1",
      )
        .filter(
          (r) =>
            r.reminded !== 1 &&
            r.eligible_until >= now &&
            now - r.since >= 30_000 &&
            now - r.last_sent >= 30_000 &&
            (r.claim === null || now - (r.claimed_at ?? now) >= 30_000),
        )
        .map((r) => `duo:${String(r.since)}:${String(r.last_sent)}`);
  } catch {
    // Duo not configured.
  }
  return [...inbox, ...fast, ...duo];
}

/** Streams the job log until the job ends (its status) or a new human message arrives (0). */
export async function watchBashJob(input: {
  dataDir: string;
  jobDir: string;
  id: string;
  write: (text: string) => void;
  pending?: () => string[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ outcome: "completed" | "yielded"; status: number }> {
  const base = path.join(input.jobDir, input.id);
  const pending = input.pending ?? (() => pendingMessageIds(input.dataDir));
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let seen: string[] = [];
  try {
    seen = JSON.parse(fs.readFileSync(`${base}.seen`, "utf8")) as string[];
  } catch {
    seen = pending();
  }
  let offset = 0,
    tick = 0;
  const flush = () => {
    try {
      const fd = fs.openSync(`${base}.log`, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > offset) {
          const bytes = Buffer.alloc(size - offset);
          fs.readSync(fd, bytes, 0, bytes.length, offset);
          offset = size;
          input.write(bytes.toString("utf8"));
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Log not created yet.
    }
  };
  for (;;) {
    flush();
    if (fs.existsSync(`${base}.rc`)) {
      await sleep(50);
      flush();
      const status = Number.parseInt(fs.readFileSync(`${base}.rc`, "utf8").trim(), 10);
      return { outcome: "completed", status: Number.isSafeInteger(status) ? status : 1 };
    }
    if (tick++ % 5 === 0 && pending().some((id) => !seen.includes(id))) {
      input.write(
        `\n[MIND Wake] Nouveau message ou rappel à te livrer (humain, autre agent, réponse rapide ou rappel duo) : cette commande continue en arrière-plan pour te laisser répondre. ` +
          `Sortie : ${base.replace(/\\/g, "/")}.log ; code de sortie dans ${base.replace(/\\/g, "/")}.rc à la fin.\n`,
      );
      return { outcome: "yielded", status: 0 };
    }
    await sleep(100);
  }
}

// Executable hook and watcher as well as an importable test boundary.
if (process.argv[2] === "--rewrite-bash") {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const output = rewriteBashHook(
      process.argv[3] ?? "",
      process.argv[4] ?? "",
      process.execPath,
      process.argv[1] ?? "",
      JSON.parse(stdin),
      undefined,
      // Le surveillant reprend le mode du hook : chargeur TypeScript compris.
      process.execArgv,
    );
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    // Never block the call: without a decision the original command runs unchanged.
    process.stderr.write(
      `MIND interruptible Bash disabled for this call: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
} else if (process.argv[2] === "--watch-bash") {
  const result = await watchBashJob({
    dataDir: process.argv[3] ?? "",
    jobDir: process.argv[4] ?? "",
    id: process.argv[5] ?? "",
    write: (text) => process.stdout.write(text),
  });
  process.exitCode = result.status;
}
