import type { IdleObservation } from "../scheduler/priority.js";

export function ownerIsWatching(observation: IdleObservation | null, now = Date.now()): boolean {
  if (!observation || now < observation.observedAtMs || now - observation.observedAtMs > 2_000)
    return false;
  const last = observation.mindLastForegroundAtMs;
  return (observation.mindForeground === true ||
    (last !== undefined && now >= last && now - last <= 30_000)) &&
    observation.idleMs + now - observation.observedAtMs <= 120_000;
}

/** Snapshot for the wake event; foreground history is held by the live native watcher. */
export function ownerPresenceEvent(observation: IdleObservation | null, now = Date.now()): string | null {
  if (!observation || now < observation.observedAtMs || now - observation.observedAtMs > 2_000)
    return null;
  if (observation.mindForeground === undefined && observation.mindLastForegroundAtMs === undefined) return null;
  const foregroundAgo = observation.mindForeground ? 0 : observation.mindLastForegroundAtMs === undefined
    ? null : now - observation.mindLastForegroundAtMs;
  const idleMs = observation.idleMs + now - observation.observedAtMs;
  const watching = ownerIsWatching(observation, now);
  return `Desktop presence observed at ${new Date(observation.observedAtMs).toISOString()}: MIND main window foreground=${observation.mindForeground ?? "unknown"}; last foreground ${foregroundAgo === null ? "not observed" : `${foregroundAgo} ms ago`}; computer inactivity=${idleMs} ms; human potentially watching=${watching}. This is a wake-time observation, not a guarantee of continued presence.`;
}
