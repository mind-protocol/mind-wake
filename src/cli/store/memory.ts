/**
 * `UnitOfWork` en mémoire : permet à la CLI et aux tests de s'exécuter avant la fusion
 * de S3. Non persistant. Le ledger n'est pas simulé : toute opération budgétaire échoue
 * explicitement plutôt que de produire des chiffres fictifs.
 */

import {
  isProfileTransitionAllowed,
  type Checkpoint,
  type CheckpointId,
  type CheckpointRepository,
  type ExperimentId,
  type ExperimentRecord,
  type ExperimentRepository,
  type LedgerRepository,
  type PermissionRevocation,
  type PolicyConsent,
  type PolicyRepository,
  type PolicyRevision,
  type PolicyRevisionId,
  type ProfileId,
  type ProfileRecord,
  type ProfileRepository,
  type ProfileTransition,
  type SessionId,
  type SessionRecord,
  type SessionRepository,
  type UnitOfWork,
  type UtcTimestamp,
} from "../../contracts/index.js";
import { MemoryJournalRepository } from "../../journal/memory.js";

interface MemoryState {
  profiles: Map<ProfileId, ProfileRecord>;
  revisions: Map<PolicyRevisionId, PolicyRevision>;
  consents: Map<PolicyRevisionId, PolicyConsent>;
  revocations: PermissionRevocation[];
  experiments: Map<ExperimentId, ExperimentRecord>;
  sessions: Map<SessionId, SessionRecord>;
  checkpoints: Map<CheckpointId, Checkpoint>;
}

function emptyState(): MemoryState {
  return {
    profiles: new Map(),
    revisions: new Map(),
    consents: new Map(),
    revocations: [],
    experiments: new Map(),
    sessions: new Map(),
    checkpoints: new Map(),
  };
}

const clone = <T>(value: T): T => structuredClone(value);

class NotAvailableError extends Error {
  override readonly name = "NotAvailableError";
}

function ledgerUnavailable(): never {
  throw new NotAvailableError(
    "ledger en mémoire non disponible : implémentation SQLite attendue (S3)",
  );
}

export class MemoryUnitOfWork implements UnitOfWork {
  private state = emptyState();
  private journalRepo = new MemoryJournalRepository();

  get journal(): MemoryJournalRepository {
    return this.journalRepo;
  }

  readonly profiles: ProfileRepository = {
    get: (id) => clone(this.state.profiles.get(id) ?? null),
    create: (record) => {
      if (this.state.profiles.has(record.id))
        throw new Error(`profil déjà existant : ${record.id}`);
      this.state.profiles.set(record.id, clone(record));
    },
    transition: (id: ProfileId, transition: ProfileTransition) => {
      const current = this.state.profiles.get(id);
      if (current === undefined) throw new Error(`profil inconnu : ${id}`);
      if (
        current.state !== transition.from ||
        !isProfileTransitionAllowed(transition.from, transition.to)
      ) {
        throw new Error(`transition refusée : ${current.state} → ${transition.to}`);
      }
      const next: ProfileRecord = {
        ...current,
        state: transition.to,
        stateReason: transition.reason,
        updatedAt: transition.at,
      };
      this.state.profiles.set(id, next);
      return clone(next);
    },
    setNextWake: (id: ProfileId, at: UtcTimestamp | null) => {
      const current = this.state.profiles.get(id);
      if (current === undefined) throw new Error(`profil inconnu : ${id}`);
      this.state.profiles.set(id, { ...current, nextWakeAt: at });
    },
  };

  readonly policies: PolicyRepository = {
    appendRevision: (revision) => {
      if (this.state.revisions.has(revision.id)) {
        throw new Error(`révision déjà existante : ${revision.id}`);
      }
      this.state.revisions.set(revision.id, clone(revision));
    },
    getRevision: (id) => clone(this.state.revisions.get(id) ?? null),
    listRevisions: (profileId) =>
      clone([...this.state.revisions.values()].filter((r) => r.profileId === profileId)),
    recordConsent: (consent) => {
      this.state.consents.set(consent.revisionId, clone(consent));
    },
    getConsent: (revisionId) => clone(this.state.consents.get(revisionId) ?? null),
    recordRevocation: (revocation) => {
      this.state.revocations.push(clone(revocation));
    },
    listRevocations: (revisionId) =>
      clone(this.state.revocations.filter((r) => r.revisionId === revisionId)),
  };

  readonly experiments: ExperimentRepository = {
    get: (id) => clone(this.state.experiments.get(id) ?? null),
    getActive: (profileId) =>
      clone(
        [...this.state.experiments.values()].find(
          (e) => e.profileId === profileId && e.status === "active",
        ) ?? null,
      ),
    upsert: (record) => {
      this.state.experiments.set(record.id, clone(record));
    },
  };

  readonly sessions: SessionRepository = {
    get: (id) => clone(this.state.sessions.get(id) ?? null),
    listOpen: (profileId) =>
      clone(
        [...this.state.sessions.values()].filter(
          (s) => s.profileId === profileId && s.outcome === null,
        ),
      ),
    create: (record) => {
      this.state.sessions.set(record.id, clone(record));
    },
    close: (id, outcome, reason, endedAt) => {
      const current = this.state.sessions.get(id);
      if (current === undefined) throw new Error(`session inconnue : ${id}`);
      this.state.sessions.set(id, { ...current, outcome, outcomeReason: reason, endedAt });
    },
  };

  readonly ledger: LedgerRepository = {
    ensurePeriod: ledgerUnavailable,
    reserve: ledgerUnavailable,
    recordUsage: ledgerUnavailable,
    reconcile: ledgerUnavailable,
    markUncertain: ledgerUnavailable,
    getReservation: ledgerUnavailable,
    availability: ledgerUnavailable,
  };

  readonly checkpoints: CheckpointRepository = {
    publish: (checkpoint) => {
      this.state.checkpoints.set(checkpoint.id, clone(checkpoint));
    },
    get: (id) => clone(this.state.checkpoints.get(id) ?? null),
    latest: (experimentId) =>
      clone(
        [...this.state.checkpoints.values()]
          .filter((c) => c.experimentId === experimentId)
          .sort((a, b) => b.sequence - a.sequence)[0] ?? null,
      ),
  };

  /** Atomique au sens du contrat : en cas d'exception, l'état antérieur est restauré. */
  transaction<T>(fn: (uow: UnitOfWork) => T): T {
    const stateBefore = clone(this.state);
    const journalBefore = this.journalRepo.snapshot();
    try {
      return fn(this);
    } catch (error) {
      this.state = stateBefore;
      this.journalRepo = journalBefore;
      throw error;
    }
  }
}
