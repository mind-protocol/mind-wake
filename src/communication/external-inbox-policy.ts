import fs from "node:fs";
import path from "node:path";
import { openStoreReadOnly } from "../store/index.js";
import { controlDbPath } from "../daemon/paths.js";
import { resolvePolicy } from "../policy/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";

/** External collectors never wake a stopped or paused profile. Fail closed. */
export function externalInboxSyncAllowed(dataDir: string): boolean {
  if (fs.existsSync(path.join(dataDir, "emergency-stop.flag"))) return false;
  try {
    const store = openStoreReadOnly(controlDbPath(dataDir));
    try {
      const profile = store.uow.profiles.get(DEFAULT_PROFILE_ID);
      return (
        profile !== null &&
        !profile.emergencyStopLocked &&
        !["paused", "checkpointing", "stopped", "disabled"].includes(profile.state) &&
        resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID).status === "active"
      );
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}
