/**
 * Bilan d'une expérience (AGENTS §7, SPEC §3.3) : ce qui a été produit, ce qui a échoué
 * et ce qui reste hypothétique, avec la consommation rapportée et sa provenance. Une
 * consommation simulée porte cette mention ; la borne réservée est rapportée à côté.
 * Lecture seule ; tout texte vient de checkpoints validés, rendu comme donnée.
 */

import type {
  Checkpoint,
  CheckpointId,
  ExperimentId,
  SessionId,
  UnitOfWork,
  UsageProvenance,
} from "../contracts/index.js";
import type { SqliteDatabase } from "../store/index.js";

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly tokens: number | null;
  readonly provenance: UsageProvenance | null;
  readonly simulated: boolean;
  /** Borne de tokens réservée pour la session. */
  readonly reservedTokens: number | null;
  readonly reservationStatus: string | null;
}

export interface ExperimentReport {
  readonly experiment: {
    readonly id: ExperimentId;
    readonly title: string;
    readonly question: string;
    readonly status: string;
  };
  readonly simulated: boolean;
  readonly sessions: readonly SessionSummary[];
  readonly checkpoints: readonly {
    readonly sequence: number;
    readonly sessionId: SessionId;
    readonly createdAt: string;
  }[];
  readonly produced: {
    readonly artifacts: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly sequence: number;
    }[];
    readonly observed: readonly string[];
  };
  readonly failed: readonly string[];
  readonly hypothetical: readonly string[];
  readonly nextAction: string | null;
  readonly consumption: {
    readonly tokens: number;
    readonly reservedTokens: number;
    readonly provenance: "simulated" | "measured" | "mixed" | "unknown";
    readonly durationMs: number;
  };
}

interface SessionEnd {
  readonly tokens?: unknown;
  readonly provenance?: unknown;
  readonly simulated?: unknown;
}

export function buildReport(
  uow: UnitOfWork,
  db: SqliteDatabase,
  experimentId: ExperimentId,
): ExperimentReport | null {
  const experiment = uow.experiments.get(experimentId);
  if (experiment === null) return null;
  const ends = new Map<string, SessionEnd>();
  for (const event of uow.journal.list(experiment.profileId)) {
    if (event.type === "session_ended" && event.sessionId !== undefined) {
      const metadata: SessionEnd = event.metadata;
      ends.set(event.sessionId, metadata);
    }
  }
  const sessionIds = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM sessions WHERE experiment_id = ? ORDER BY started_at, rowid",
    )
    .all(experimentId);
  const sessions: SessionSummary[] = [];
  let durationMs = 0;
  for (const { id } of sessionIds) {
    const record = uow.sessions.get(id as SessionId);
    if (record === null) continue;
    const end = ends.get(id);
    const reservation = uow.ledger.getReservation(record.reservationId);
    const reserved = reservation?.maxima.find((q) => q.unit === "tokens");
    if (record.endedAt !== null) {
      durationMs += Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt));
    }
    sessions.push({
      sessionId: record.id,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      outcome: record.outcome,
      reason: record.outcomeReason,
      tokens: typeof end?.tokens === "number" ? end.tokens : null,
      provenance: typeof end?.provenance === "string" ? (end.provenance as UsageProvenance) : null,
      simulated: end?.simulated === true || record.adapterId === "fake",
      reservedTokens: reserved?.unit === "tokens" ? reserved.amount : null,
      reservationStatus: reservation?.status ?? null,
    });
  }
  const checkpoints = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM checkpoints WHERE experiment_id = ? ORDER BY sequence",
    )
    .all(experimentId)
    .map(({ id }) => uow.checkpoints.get(id as CheckpointId))
    .filter((c): c is Checkpoint => c !== null);
  const latest = checkpoints.at(-1) ?? null;

  const artifacts = new Map<string, { path: string; bytes: number; sequence: number }>();
  const observed: string[] = [];
  const failed: string[] = [];
  for (const checkpoint of checkpoints) {
    for (const a of checkpoint.artifacts) {
      artifacts.set(a.path, { path: a.path, bytes: a.bytes, sequence: checkpoint.sequence });
    }
    for (const o of checkpoint.observations) {
      if (o.confidence === "observed")
        observed.push(`[cp ${String(checkpoint.sequence)}] ${o.text}`);
    }
    for (const f of checkpoint.failures) failed.push(`[cp ${String(checkpoint.sequence)}] ${f}`);
  }
  for (const s of sessions) {
    if (s.outcome !== null && s.outcome !== "completed") {
      failed.push(`session ${s.sessionId} : ${s.outcome} (${s.reason ?? "motif inconnu"})`);
    }
  }
  const hypothetical =
    latest === null
      ? []
      : [
          ...latest.observations
            .filter((o) => o.confidence !== "observed")
            .map((o) => `[${o.confidence}] ${o.text}`),
          ...latest.incompleteWork.map((w) => `[à faire] ${w}`),
        ];
  const provenances = new Set(sessions.map((s) => s.provenance ?? "unknown"));
  const simulated = sessions.length > 0 && sessions.every((s) => s.simulated);
  return {
    experiment: {
      id: experiment.id,
      title: experiment.title,
      question: experiment.question,
      status: experiment.status,
    },
    simulated,
    sessions,
    checkpoints: checkpoints.map((c) => ({
      sequence: c.sequence,
      sessionId: c.sessionId,
      createdAt: c.createdAt,
    })),
    produced: { artifacts: [...artifacts.values()], observed },
    failed,
    hypothetical,
    nextAction: latest?.nextAction ?? null,
    consumption: {
      tokens: sessions.reduce((sum, s) => sum + (s.tokens ?? 0), 0),
      reservedTokens: sessions.reduce((sum, s) => sum + (s.reservedTokens ?? 0), 0),
      provenance:
        provenances.size === 1
          ? ((): ExperimentReport["consumption"]["provenance"] => {
              const only = [...provenances][0];
              return only === "simulated" || only === "measured" ? only : "unknown";
            })()
          : "mixed",
      durationMs,
    },
  };
}

/** Rendu humain ; chaque texte issu d'un checkpoint tient sur une ligne. */
export function formatReport(report: ExperimentReport): string {
  const line = (text: string): string => text.replace(/\s+/g, " ").trim();
  const tag = report.simulated ? " [SIMULÉ]" : "";
  const c = report.consumption;
  return [
    `Bilan${tag} — ${line(report.experiment.title)} (${report.experiment.status})`,
    `Question : ${line(report.experiment.question)}`,
    `Sessions : ${String(report.sessions.length)}, checkpoints : ${String(report.checkpoints.length)}`,
    ...report.sessions.map(
      (s) =>
        `  - ${s.sessionId} : ${s.outcome ?? "en cours"} (${line(s.reason ?? "—")}), ${String(s.tokens ?? "?")} tokens ${s.provenance ?? "inconnus"} / borne réservée ${String(s.reservedTokens ?? "?")}`,
    ),
    "Produit :",
    ...report.produced.artifacts.map(
      (a) => `  - artefact ${a.path} (${String(a.bytes)} octets, checkpoint ${String(a.sequence)})`,
    ),
    ...report.produced.observed.map((o) => `  - observé ${line(o)}`),
    "Échoué :",
    ...(report.failed.length === 0 ? ["  - rien"] : report.failed.map((f) => `  - ${line(f)}`)),
    "Hypothétique :",
    ...(report.hypothetical.length === 0
      ? ["  - rien"]
      : report.hypothetical.map((h) => `  - ${line(h)}`)),
    `Prochaine piste (suggestion de l'agent) : ${line(report.nextAction ?? "—")}`,
    `Consommation : ${String(c.tokens)} tokens ${c.provenance === "simulated" ? "SIMULÉS" : c.provenance} (borne réservée ${String(c.reservedTokens)}), durée ${String(Math.round(c.durationMs))} ms, coût monétaire 0 (aucune dépense autorisée)`,
  ].join("\n");
}
