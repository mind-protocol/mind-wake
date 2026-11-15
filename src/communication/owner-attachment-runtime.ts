import fs from "node:fs";
import path from "node:path";

const FILE = "owner-attachment-runtime.json";
/** Distinguish a live old daemon from the rebuilt files on disk. */
export function recordOwnerAttachmentRuntime(dataDir: string, runId: string): void {
  fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify({ version: 1, runId, voiceScreens: true }));
}
export function ownerAttachmentRuntimeMatches(dataDir: string, runId: string, voiceScreens = false): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as {
      version?: unknown;
      runId?: unknown;
      voiceScreens?: unknown;
    };
    return marker.version === 1 && marker.runId === runId && (!voiceScreens || marker.voiceScreens === true);
  } catch {
    return false;
  }
}
