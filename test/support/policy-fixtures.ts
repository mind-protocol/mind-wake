/**
 * Dépôts en mémoire et brouillons de référence pour les tests du policy engine.
 * Aucun SQLite : le policy engine ne dépend que des interfaces de `src/contracts`.
 */

import type {
  ConsentId,
  JournalEvent,
  JournalEventInput,
  JournalRepository,
  PermissionRevocation,
  PolicyConsent,
  PolicyRepository,
  PolicyRevision,
  PolicyRevisionId,
  ProfileId,
  SessionId,
  UtcTimestamp,
} from "../../src/contracts/index.js";
import { JOURNAL_SCHEMA_VERSION } from "../../src/contracts/index.js";
import {
  grantConsent,
  openTrustedUserChannel,
  proposeRevision,
  type PolicyStore,
} from "../../src/policy/index.js";

export class MemoryPolicyRepository implements PolicyRepository {
  readonly revisions: PolicyRevision[] = [];
  readonly consents = new Map<string, PolicyConsent>();
  readonly revocations: PermissionRevocation[] = [];

  appendRevision(revision: PolicyRevision): void {
    if (this.revisions.some((r) => r.id === revision.id)) {
      throw new Error("révision existante : immuable");
    }
    this.revisions.push(revision);
  }
  getRevision(id: PolicyRevisionId): PolicyRevision | null {
    return this.revisions.find((r) => r.id === id) ?? null;
  }
  listRevisions(profileId: ProfileId): readonly PolicyRevision[] {
    return this.revisions.filter((r) => r.profileId === profileId);
  }
  recordConsent(consent: PolicyConsent): void {
    if (this.consents.has(consent.revisionId)) throw new Error("consentement existant");
    this.consents.set(consent.revisionId, consent);
  }
  getConsent(revisionId: PolicyRevisionId): PolicyConsent | null {
    return this.consents.get(revisionId) ?? null;
  }
  recordRevocation(revocation: PermissionRevocation): void {
    this.revocations.push(revocation);
  }
  listRevocations(revisionId: PolicyRevisionId): readonly PermissionRevocation[] {
    return this.revocations.filter((r) => r.revisionId === revisionId);
  }
}

export class MemoryJournal implements JournalRepository {
  readonly events: JournalEvent[] = [];
  append(event: JournalEventInput): JournalEvent {
    const stored = {
      ...event,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence: this.events.length + 1,
    };
    this.events.push(stored);
    return stored;
  }
  list(profileId: ProfileId): readonly JournalEvent[] {
    return this.events.filter((e) => e.profileId === profileId);
  }
}

export function memoryStore(): PolicyStore & {
  policies: MemoryPolicyRepository;
  journal: MemoryJournal;
} {
  return { policies: new MemoryPolicyRepository(), journal: new MemoryJournal() };
}

export const PROFILE = "profile-1" as ProfileId;
export const SESSION = "session-1" as SessionId;

export const ts = (iso: string): UtcTimestamp => iso as UtcTimestamp;
export const revId = (n: number): PolicyRevisionId => `rev-${String(n)}` as PolicyRevisionId;
export const consentId = (n: number): ConsentId => `consent-${String(n)}` as ConsentId;

/** Brouillon complet et valide : aucun réseau d'exploration, aucune dépense. */
export function validDraft(): Record<string, Record<string, unknown>> {
  return {
    identity: { profileId: PROFILE, agentId: "agent-1" },
    runtime: { adapterId: "fake", provider: "simulated", model: "sim-1", authMode: "none" },
    schedule: {
      timeZone: "Europe/Paris",
      weeklyWindows: [{ day: 1, start: "09:00", end: "12:00" }],
      minIntervalBetweenSessionsMs: 60_000,
      maxSessionDurationMs: 600_000,
    },
    humanPriority: {
      activitySignal: "windows_idle",
      idleThresholdMs: 300_000,
      maxSignalAgeMs: 30_000,
      maxInterruptLatencyMs: 5_000,
      maxTerminationLatencyMs: 10_000,
    },
    budget: {
      period: { kind: "day", timeZone: "Europe/Paris" },
      tokensPerSession: 10_000,
      tokensPerPeriod: 50_000,
      sessionsPerPeriod: 3,
      userReserveTokens: 5_000,
      checkpointTokens: 1_000,
      paidApi: { authorized: false },
    },
    filesAndTools: {
      readRoots: ["memory", "workspace"],
      writeRoots: ["workspace"],
      allowedExecutables: ["node"],
      maxProcesses: 4,
      maxStorageBytes: 100_000_000,
    },
    network: { explorationDestinations: [], providerTransportDestinations: [] },
    data: {
      eventRetentionDays: 30,
      localStorageCapBytes: 200_000_000,
      purge: "manual",
      exportPaths: [],
    },
  };
}

type Draft = ReturnType<typeof validDraft>;

/** Copie modifiée d'un brouillon (`groupe.champ` → valeur, `undefined` supprime). */
export function withFields(draft: Draft, changes: Record<string, unknown>): Draft {
  const copy = structuredClone(draft);
  for (const [path, value] of Object.entries(changes)) {
    const [group = "", name = ""] = path.split(".");
    const target = (copy[group] ??= {});
    if (value === undefined) Reflect.deleteProperty(target, name);
    else target[name] = value;
  }
  return copy;
}

let counter = 100;

/** Propose puis fait consentir une révision par le canal de confiance. */
export function activate(
  store: PolicyStore,
  draft: unknown,
  at = "2026-10-29T10:00:00Z",
): PolicyRevision {
  counter += 1;
  const proposed = proposeRevision(store, {
    revisionId: revId(counter),
    profileId: PROFILE,
    at: ts(at),
    draft,
  });
  if (proposed.status !== "proposed") {
    throw new Error(`proposition rejetée : ${JSON.stringify(proposed.issues)}`);
  }
  const consent = grantConsent(store, openTrustedUserChannel(), {
    consentId: consentId(counter),
    revisionId: proposed.revision.id,
    profileId: PROFILE,
    at: ts(at),
    confirmedDigest: proposed.digest,
    proof: "confirmation saisie dans la CLI locale",
  });
  if (consent.status !== "consented") throw new Error(`consentement refusé : ${consent.reason}`);
  return proposed.revision;
}
