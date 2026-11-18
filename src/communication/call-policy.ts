import { openStoreReadOnly } from "../store/index.js";
import { controlDbPath } from "../daemon/paths.js";
import { resolvePolicy } from "../policy/index.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";

/**
 * An explicit call grants a bounded conversational turn, not autonomous execution.
 * Pause/Stop and the emergency-stop flag remain unchanged. The opening responder
 * has no tools and deduplicates by call and participant; hangup cancels its reply.
 * This must never be used to authorize background work or ordinary peer messages.
 */
export function callConversationAllowed(dataDir: string): boolean {
  try {
    const store = openStoreReadOnly(controlDbPath(dataDir));
    try {
      const profile = store.uow.profiles.get(DEFAULT_PROFILE_ID);
      return profile !== null && profile.state !== "disabled"
        && resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID).status === "active";
    } finally { store.close(); }
  } catch { return false; }
}
