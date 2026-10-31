import fs from "node:fs";
import path from "node:path";
import { workerFile } from "./worker.js";

/** A failed liveness probe alone cannot distinguish a dead worker from one starting up. */
export function recordedWorkerExit(dataDir: string, conversationId: string): string | null {
  try {
    const file = workerFile(dataDir, conversationId);
    const record = fs.lstatSync(file);
    if (!record.isFile() || record.isSymbolicLink() || record.size > 16000) return null;
    const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return null;
    const log = path.join(dataDir, "conversation-worker.log");
    const stat = fs.lstatSync(log);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const fd = fs.openSync(log, "r");
    let tail: string;
    try {
      const offset = Math.max(0, stat.size - 65536);
      const buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    for (const line of tail.split(/\r?\n/).reverse()) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (
          value["schema"] !== "mind.conversation/owner-control" ||
          value["conversationId"] !== conversationId ||
          value["pid"] !== owner.pid
        )
          continue;
        return value["stopReason"] === "global_process_limit_exceeded"
          ? "Le moteur s’est arrêté : la limite de processus a été dépassée. Les résultats reçus sont conservés."
          : "Le moteur de conversation s’est arrêté avant de rendre son résultat.";
      } catch {
        /* Other log lines are not exit receipts. */
      }
    }
  } catch {
    /* An absent receipt is not evidence of an interrupted call. */
  }
  return null;
}
