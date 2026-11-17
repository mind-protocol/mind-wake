import { randomUUID } from "node:crypto";
import type { ConsentId, PolicyRevisionId, ProfileId, UtcTimestamp } from "../contracts/index.js";
import {
  grantConsent,
  openTrustedUserChannel,
  proposeRevision,
  resolvePolicy,
} from "../policy/index.js";
import type { Store } from "../store/index.js";
import { defaultRegistry } from "./registry.js";
import { SqliteSchedulerStateRepository } from "../scheduler/state.js";
import { providerFailure, engineChoice, preferredEngine, type Engine } from "./agent-engine.js";

/** Apply the owner's engine selection between sessions. All other policy groups stay in force. */
export function applyPrincipalEngine(
  store: Store,
  dir: string,
  profileId: ProfileId,
  engine?: Engine,
  checkOnly = false,
): boolean {
  const choice = engineChoice(dir);
  if (!choice) return false;
  const selected = engine ?? preferredEngine(dir, choice);
  return store.uow.transaction((tx) => {
    const active = resolvePolicy(tx.policies, profileId);
    const profile = tx.profiles.get(profileId);
    if (
      !profile ||
      profile.emergencyStopLocked ||
      !["ready", "hibernating", "paused", "blocked"].includes(profile.state) ||
      active.status !== "active"
    )
      return false;
    const groups = active.revision.groups;
    const current = groups.runtime.adapterId;
    if (
      (current !== "claude" && current !== "codex") ||
      current === selected ||
      !groups.runtime.hostUnsandboxedAcknowledged
    )
      return false;
    const last = store.db
      .prepare<[string], { adapter_id: string; outcome_reason: string }>(
        "SELECT adapter_id,outcome_reason FROM sessions WHERE profile_id=? ORDER BY started_at DESC LIMIT 1",
      )
      .get(profileId);
    const providerFailed =
      last?.adapter_id === current && providerFailure(last.outcome_reason ?? "");
    if (
      profile.state === "blocked" &&
      !(
        providerFailed &&
        ["fin de session : blocked", "failure.auth_failed"].includes(profile.stateReason ?? "")
      )
    )
      return false;
    const revisions = tx.policies.listRevisions(profileId);
    if (revisions.at(-1)?.id !== active.revision.id) return false;
    if (checkOnly) return true;
    const previous = [...revisions]
      .reverse()
      .find((r) => r.groups.runtime.adapterId === selected && tx.policies.getConsent(r.id));
    const runtime = previous?.groups.runtime ?? defaultRegistry().get(selected)!.runtime();
    const network =
      previous?.groups.network.providerTransportDestinations ??
      (selected === "codex" ? ["chatgpt.com", "api.openai.com"] : ["api.anthropic.com"]).map(
        (host) => ({ host, ports: [443], purpose: selected }),
      );
    const draft = {
      ...groups,
      runtime: {
        ...groups.runtime,
        adapterId: selected,
        model: runtime.model,
        provider: runtime.provider,
        authMode: runtime.authMode,
      },
      filesAndTools: {
        ...groups.filesAndTools,
        allowedExecutables: groups.filesAndTools.allowedExecutables.includes(selected)
          ? groups.filesAndTools.allowedExecutables
          : groups.filesAndTools.allowedExecutables.map((x) => (x === current ? selected : x)),
      },
      network: { ...groups.network, providerTransportDestinations: network },
    };
    const at = new Date().toISOString() as UtcTimestamp;
    const proposed = proposeRevision(tx, {
      profileId,
      at,
      draft,
      revisionId: ("rev-" + randomUUID()) as PolicyRevisionId,
    });
    if (proposed.status !== "proposed")
      throw Error(proposed.issues.map((i) => i.detail).join(", "));
    const consent = grantConsent(tx, openTrustedUserChannel(), {
      at,
      profileId,
      revisionId: proposed.revision.id,
      confirmedDigest: proposed.digest,
      consentId: ("consent-" + randomUUID()) as ConsentId,
      proof: "desktop-engine:" + choice.revision,
    });
    if (consent.status !== "consented") throw Error(consent.reason);
    if (providerFailed) {
      const states = new SqliteSchedulerStateRepository(store.db);
      states.save({ ...states.get(profileId), consecutiveFailures: 0, backoffUntil: null }, at);
      if (profile.state === "blocked")
        tx.profiles.transition(profileId, {
          from: "blocked",
          to: "ready",
          reason: "Relais du moteur indisponible",
          at,
        });
    }
    tx.profiles.setActivePolicyRevision(profileId, proposed.revision.id);
    return true;
  });
}
