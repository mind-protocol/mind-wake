/** Queue owner: only explicit submissions/resumes execute model cycles. Idle polling makes no model calls. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "./store.js";
import { ConversationCoordinator } from "./coordinator.js";
import { createRoleRuntime, inspectConversationRuntime, type RoleRuntime } from "./role-runtime.js";
import { collectConsolidation } from "./messages.js";

export function workerFile(dataDir: string, id: string): string {
  return path.join(
    dataDir,
    `conversation-worker-${createHash("sha256").update(id).digest("hex").slice(0, 24)}.json`,
  );
}
function workerAddress(dataDir: string, id: string): string {
  const key = createHash("sha256")
    .update(path.resolve(dataDir) + "\0" + id)
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\mind-conversation-${key}`
    : path.join(os.tmpdir(), `mind-conversation-${key}.sock`);
}
export async function workerAlive(dataDir: string, id: string): Promise<boolean> {
  try {
    const file = workerFile(dataDir, id),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
      throw Error("Invalid worker record");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: unknown; token: string };
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return false;
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(workerAddress(dataDir, id));
      let raw = "",
        done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(1000, () => {
        finish(false);
      });
      socket.on("error", () => {
        finish(false);
      });
      socket.on("data", (chunk) => {
        raw += String(chunk);
        if (raw.length > 16000) {
          finish(false);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            finish(false);
            return;
          }
          const status = parsed as Record<string, unknown>;
          finish(status["token"] === value.token && status["pid"] === value.pid);
        } catch {
          /* Await full status. */
        }
      });
      socket.on("end", () => {
        finish(false);
      });
    });
  } catch {
    return false;
  }
}

export async function serveConversation(
  dataDir: string,
  id: string,
  options: {
    runtime?: RoleRuntime;
    signal?: AbortSignal;
    allow?: () => boolean;
    idleMs?: number;
  } = {},
): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = workerFile(dataDir, id),
    token = randomUUID(),
    address = workerAddress(dataDir, id);
  const server = net.createServer((socket) => {
    socket.end(JSON.stringify({ pid: process.pid, token, conversationId: id }));
  });
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(address, () => {
      resolve(true);
    });
  });
  if (!listening) return;
  const controller = new AbortController(),
    abort = () => {
      controller.abort(options.signal?.reason);
    };
  let ownedStore: ConversationStore | undefined;
  const temporary = `${file}.${token}.tmp`;
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let attempted = "";
  try {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("Invalid worker owner file");
    }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, conversationId: id }));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const store = new ConversationStore(dataDir),
      runtime = options.runtime ?? createRoleRuntime({ dataDir });
    ownedStore = store;
    store.recoverInterruptedCalls(id);
    while (!controller.signal.aborted) {
      const state = store.current(id);
      if (!state || state.status === "stopped") break;
      const inspection = options.allow ? null : inspectConversationRuntime(dataDir);
      if (options.allow ? !options.allow() : inspection?.allowed === false) {
        store.appendEvent({
          conversationId: id,
          revision: state.revision,
          kind: "runtime_blocked",
          text: inspection?.allowed === false ? inspection.reason : "Stopped by runtime controls",
        });
        break;
      }
      const request =
        store
          .events(id)
          .filter((e) => e.kind === "cycle_resume_requested")
          .at(-1)?.sequence ?? 0;
      const key = `${String(state.revision)}:${String(request)}`;
      if (state.status === "active" && state.revision > 0 && key !== attempted) {
        attempted = key;
        if (inspection?.allowed) collectConsolidation(store, id, inspection.workspaceDir);
        try {
          await new ConversationCoordinator(store, runtime).run(
            id,
            state.revision,
            controller.signal,
          );
        } catch {
          // A changed message is another explicit revision; a failed call waits for human Resume.
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, options.idleMs ?? 250);
        controller.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    ownedStore?.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)["token"] === token
      )
        fs.unlinkSync(file);
    } catch {
      /* Another owner must not be removed. */
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" }, conversation: { type: "string" } },
  });
  if (!values["data-dir"] || !values.conversation)
    throw Error("Explicit conversation and data directory required");
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });
  process.once("SIGTERM", () => {
    controller.abort();
  });
  await serveConversation(path.resolve(values["data-dir"]), values.conversation, {
    signal: controller.signal,
  });
}
