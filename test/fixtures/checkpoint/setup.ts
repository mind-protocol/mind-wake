/** Données de test des checkpoints : store, session ouverte, racine d'artefacts. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterId,
  CheckpointCandidate,
  ExperimentId,
  ReservationId,
  SessionId,
  UnitOfWork,
  UtcTimestamp,
} from "../../../src/contracts/index.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../../src/contracts/index.js";
import { DAY_PARIS, LIMITS, PROFILE, authorize, createProfile, ts } from "../store-ledger/setup.js";

export const EXPERIMENT = "exp-1" as ExperimentId;
export const SESSION = "session-1" as SessionId;
export const NOW: UtcTimestamp = ts("2026-10-29T12:00:00Z");

/** Profil autorisé, expérience active et session ouverte sur `SESSION`. */
export function seed(uow: UnitOfWork, sessionId: SessionId = SESSION): void {
  createProfile(uow);
  authorize(uow, "rev-1");
  uow.experiments.upsert({
    id: EXPERIMENT,
    profileId: PROFILE,
    title: "Petits systèmes émergents",
    question: "Un automate simple produit-il des motifs stables ?",
    status: "active",
    statusReason: "choisie par l'agent",
    currentCheckpointId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  openSession(uow, sessionId);
}

export function openSession(uow: UnitOfWork, sessionId: SessionId): void {
  const periodId = uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, NOW, LIMITS).id;
  const reserved = uow.ledger.reserve({
    id: `res-${sessionId}` as ReservationId,
    sessionId,
    profileId: PROFILE,
    periodIds: [periodId],
    maxima: [{ unit: "sessions", amount: 1 }],
    at: NOW,
  });
  if (reserved.status !== "reserved") throw new Error(`réservation refusée : ${reserved.reason}`);
  uow.sessions.create({
    id: sessionId,
    profileId: PROFILE,
    experimentId: EXPERIMENT,
    adapterId: "fake" as AdapterId,
    policyRevisionId: authorizeId(uow),
    reservationId: `res-${sessionId}` as ReservationId,
    startedAt: NOW,
    endedAt: null,
    outcome: null,
    outcomeReason: null,
  });
}

function authorizeId(uow: UnitOfWork): ReturnType<typeof authorize> {
  const last = uow.policies.listRevisions(PROFILE).at(-1);
  if (last === undefined) throw new Error("aucune révision");
  return last.id;
}

export function candidate(overrides: Partial<CheckpointCandidate> = {}): CheckpointCandidate {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    experimentId: EXPERIMENT,
    sessionId: SESSION,
    summary: "Automate 1D règle 110 simulé sur 64 cellules.",
    observations: [
      { text: "Des structures mobiles apparaissent après 40 pas.", confidence: "observed" },
      { text: "La règle pourrait être universelle à cette taille.", confidence: "hypothesis" },
    ],
    failures: ["La visualisation ASCII tronque les lignes au-delà de 80 colonnes."],
    artifacts: [],
    incompleteWork: ["Comparer avec la règle 30."],
    nextAction: "Mesurer la période des structures mobiles.",
    hibernationReason: "Expérience bornée terminée pour cette session.",
    ...overrides,
  };
}

export interface Workspace {
  readonly path: string;
  readonly dbPath: string;
  readonly artifacts: string;
  /** Dossier hors de la racine d'artefacts, cible des tentatives d'évasion. */
  readonly outside: string;
  remove(): void;
}

export function workspace(): Workspace {
  const path = mkdtempSync(join(tmpdir(), "mind-wake-checkpoint-"));
  const artifacts = join(path, "exploration", "artifacts");
  const outside = join(path, "outside");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(outside);
  return {
    path,
    dbPath: join(path, "control.sqlite"),
    artifacts,
    outside,
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * Sous Windows, un lien symbolique exige le privilège SeCreateSymbolicLinkPrivilege
 * (administrateur ou mode développeur) ; une jonction n'exige rien. Sonde une fois.
 */
export const CAN_SYMLINK: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "mind-wake-symlink-probe-"));
  try {
    symlinkSync(dir, join(dir, "probe"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
