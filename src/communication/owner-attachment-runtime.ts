import fs from "node:fs";
import path from "node:path";

const FILE = "owner-attachment-runtime.json";
/** Distinguish a live old daemon from the rebuilt files on disk. */
export function recordOwnerAttachmentRuntime(dataDir: string, runId: string): void {
  fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify({ version: 1, runId }));
}
export function ownerAttachmentRuntimeMatches(dataDir: string, runId: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as {
      version?: unknown;
      runId?: unknown;
    };
    return marker.version === 1 && marker.runId === runId;
  } catch {
    return false;
  }
}
