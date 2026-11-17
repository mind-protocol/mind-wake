import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { ProcessTreeSupervisor, type ContainedCommand } from "../runner/process-tree.js";
import { runtimeDirFor } from "../runner/paths.js";

/** Start a role in the same Windows Job Object launcher used by the principal runner. */
export function spawnAgentProcess(dataDir: string, command: ContainedCommand) {
  const child = new ProcessTreeSupervisor(runtimeDirFor(dataDir)).spawn(
    "default" as ProfileId,
    randomUUID() as SessionId,
    command,
  );
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let pending = "";
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const lines = (pending + String(chunk)).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) child.send(line);
      done();
    },
    final(done) {
      if (pending) child.send(pending);
      child.closeInput();
      done();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: () => child.terminateTree(),
  });
  void (async () => {
    try {
      await child.started();
      for (let line = await child.readLine(); line !== null; line = await child.readLine())
        stdout.write(line + "\n");
    } catch (error) {
      proc.emit("error", error);
    } finally {
      const exit = await child.exited;
      stdout.end();
      stderr.end();
      proc.emit("close", exit.mainExitCode);
    }
  })();
  return proc;
}
