/**
 * `status` : état courant, expérience active, dernière activité, budget, prochain réveil
 * et motif d'attente (SPEC §3.3). Lecture seule.
 */

import type {
  BudgetPeriodDefinition,
  PolicyRevision,
  ProfileState,
} from "../../contracts/index.js";
import {
  basisPointsToPercent,
  capabilities,
  formatCapability,
  type Capability,
  type IsolationAssessment,
} from "../capabilities.js";
import { latestSelfTest, selfTestValidFor } from "../../daemon/isolation.js";
import { isProcessAlive, latestDaemonRun } from "../../daemon/runs.js";
import { sandboxSourceDigest } from "../../sandbox/index.js";
import type { SqliteDatabase } from "../../store/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_OK, orDash, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import type { Persistence } from "../store/index.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";

export interface BudgetStatus {
  /** Toujours `unknown` tant que le ledger n'est pas consultable : inconnu ≠ disponible. */
  readonly availability: "unknown";
  readonly detail: string;
  readonly caps: {
    readonly period: BudgetPeriodDefinition;
    readonly tokensPerSession: number;
    readonly tokensPerPeriod: number;
    readonly sessionsPerPeriod: number;
    readonly userReserveTokens: number;
  } | null;
  /**
   * Garde de quota d'abonnement, si la policy en déclare une. Pourcentages d'une jauge
   * fournisseur qui inclut l'usage de l'humain : ni des tokens, ni une borne.
   */
  readonly subscriptionQuota: SubscriptionQuotaStatus | null;
}

export interface SubscriptionQuotaStatus {
  readonly enabled: boolean;
  readonly unit: "provider_quota_bp";
  readonly isConsumptionBound: false;
  readonly startBelow: string | null;
  readonly stopAt: string | null;
  readonly userReserve: string | null;
  readonly overshootBound: string | null;
  /** Pilotage (ADR-005, complément) : usage visé à la remise à zéro de la fenêtre. */
  readonly pacing: {
    readonly target: string;
    readonly initialRatePerHour: string;
    readonly margin: number;
  } | null;
  readonly note: string;
}

const QUOTA_NOTE =
  "pourcentage d'une fenêtre de quota du fournisseur, usage humain inclus ; non converti en tokens, ce n'est pas une borne de consommation";

function subscriptionQuotaStatus(revision: PolicyRevision): SubscriptionQuotaStatus | null {
  const guard = revision.groups.budget.subscriptionQuota;
  if (guard === undefined) return null;
  if (!guard.enabled) {
    return {
      enabled: false,
      unit: "provider_quota_bp",
      isConsumptionBound: false,
      startBelow: null,
      stopAt: null,
      userReserve: null,
      overshootBound: null,
      pacing: null,
      note: QUOTA_NOTE,
    };
  }
  return {
    enabled: true,
    unit: "provider_quota_bp",
    isConsumptionBound: false,
    startBelow: basisPointsToPercent(guard.startBelowBasisPoints),
    stopAt: basisPointsToPercent(guard.stopAtBasisPoints),
    userReserve: basisPointsToPercent(guard.userReserveBasisPoints),
    overshootBound:
      guard.overshootBoundBasisPoints === null
        ? null
        : basisPointsToPercent(guard.overshootBoundBasisPoints),
    pacing: {
      target: basisPointsToPercent(guard.targetUsageBasisPoints),
      initialRatePerHour: basisPointsToPercent(guard.initialRateBasisPointsPerHour),
      margin: guard.pacingMarginRatio,
    },
    note: QUOTA_NOTE,
  };
}

export interface DaemonStatus {
  /**
   * `running` : exécution en cours et processus présent ; `stopped` : arrêt propre ;
   * `crashed` : exécution sans fin enregistrée dont le processus a disparu.
   */
  readonly state: "running" | "stopped" | "crashed" | "never";
  readonly mode: "simulated" | "real" | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
}

export interface LastSessionStatus {
  readonly sessionId: string;
  readonly at: string;
  readonly outcome: string;
  readonly reason: string;
  readonly tokens: number | null;
  readonly provenance: string | null;
  readonly simulated: boolean;
}

const NO_DAEMON: DaemonStatus = {
  state: "never",
  mode: null,
  pid: null,
  startedAt: null,
  endedAt: null,
  endReason: null,
};

export interface StatusData {
  readonly dataDir: string;
  readonly persistence: Persistence | null;
  readonly profile: {
    readonly id: string;
    readonly state: ProfileState;
    readonly stateReason: string;
    readonly emergencyStopLocked: boolean;
    readonly activePolicyRevisionId: string | null;
    readonly nextWakeAt: string | null;
    readonly updatedAt: string;
  } | null;
  readonly hint: string | null;
  readonly activeExperiment: { readonly id: string; readonly title: string } | null;
  readonly openSessions: number;
  readonly daemon: DaemonStatus;
  readonly lastSession: LastSessionStatus | null;
  readonly lastEvent: {
    readonly sequence: number;
    readonly at: string;
    readonly type: string;
    readonly reason: string;
  } | null;
  readonly budget: BudgetStatus;
  readonly capabilities: readonly Capability[];
}

const NO_BUDGET: BudgetStatus = {
  availability: "unknown",
  detail: "aucune policy active : aucun budget accordé",
  caps: null,
  subscriptionQuota: null,
};

/**
 * Isolation vue par `status`, sans rien exécuter : dernier autotest de refus mené par le
 * daemon en mode réel, valable seulement pour l'empreinte du lanceur de ce build.
 */
function isolationFromLastSelfTest(
  db: SqliteDatabase | undefined,
  profileId: Parameters<typeof latestSelfTest>[1],
): IsolationAssessment | undefined {
  if (db === undefined) return undefined;
  let record: ReturnType<typeof latestSelfTest>;
  try {
    record = latestSelfTest(db, profileId);
  } catch {
    return undefined;
  }
  if (record === null) return undefined;
  const valid = selfTestValidFor(record, sandboxSourceDigest());
  return valid.ok
    ? {
        passed: true,
        detail: `AppContainer sans capacité + Job Object : ${valid.detail}`,
        blockers: [],
      }
    : {
        passed: false,
        detail: "dernier autotest de refus non valable : exécution autonome impossible",
        blockers: [valid.detail],
      };
}

export function status(ctx: CliContext, dataDir: DataDir): CommandResult<StatusData> {
  const data = withReadStore(ctx, dataDir, ({ uow, persistence, db }): StatusData => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    if (uow === null || profile === null) {
      return {
        dataDir: dataDir.path,
        persistence,
        profile: null,
        hint: NO_PROFILE_HINT,
        activeExperiment: null,
        openSessions: 0,
        daemon: NO_DAEMON,
        lastSession: null,
        lastEvent: null,
        budget: NO_BUDGET,
        capabilities: capabilities(persistence ?? ctx.storeBackend, null),
      };
    }
    const experiment = uow.experiments.getActive(profile.id);
    const events = uow.journal.list(profile.id);
    const last = events.at(-1);
    const run = db === undefined ? null : latestDaemonRun(db, profile.id);
    const daemon: DaemonStatus =
      run === null
        ? NO_DAEMON
        : {
            state:
              run.endedAt !== null ? "stopped" : isProcessAlive(run.pid) ? "running" : "crashed",
            mode: run.mode,
            pid: run.pid,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            endReason: run.endReason,
          };
    const ended = events.findLast((e) => e.type === "session_ended");
    const meta = (ended?.metadata ?? {}) as Record<string, unknown>;
    const lastSession: LastSessionStatus | null =
      ended?.sessionId === undefined
        ? null
        : {
            sessionId: ended.sessionId,
            at: ended.at,
            outcome: typeof meta["outcome"] === "string" ? meta["outcome"] : "inconnu",
            reason: ended.reason,
            tokens: typeof meta["tokens"] === "number" ? meta["tokens"] : null,
            provenance: typeof meta["provenance"] === "string" ? meta["provenance"] : null,
            simulated: meta["simulated"] === true,
          };
    const revision =
      profile.activePolicyRevisionId === null
        ? null
        : uow.policies.getRevision(profile.activePolicyRevisionId);
    const budget: BudgetStatus =
      revision === null
        ? NO_BUDGET
        : {
            availability: "unknown",
            detail:
              persistence === "sqlite"
                ? "disponibilité non calculée : status ne lit pas encore le ledger"
                : "disponibilité non calculée : ledger SQLite non câblé",
            caps: {
              period: revision.groups.budget.period,
              tokensPerSession: revision.groups.budget.tokensPerSession,
              tokensPerPeriod: revision.groups.budget.tokensPerPeriod,
              sessionsPerPeriod: revision.groups.budget.sessionsPerPeriod,
              userReserveTokens: revision.groups.budget.userReserveTokens,
            },
            subscriptionQuota: subscriptionQuotaStatus(revision),
          };
    return {
      dataDir: dataDir.path,
      persistence,
      profile: {
        id: profile.id,
        state: profile.state,
        stateReason: profile.stateReason,
        emergencyStopLocked: profile.emergencyStopLocked,
        activePolicyRevisionId: profile.activePolicyRevisionId,
        nextWakeAt: profile.nextWakeAt,
        updatedAt: profile.updatedAt,
      },
      hint: null,
      activeExperiment: experiment === null ? null : { id: experiment.id, title: experiment.title },
      openSessions: uow.sessions.listOpen(profile.id).length,
      daemon,
      lastSession,
      lastEvent:
        last === undefined
          ? null
          : { sequence: last.sequence, at: last.at, type: last.type, reason: last.reason },
      budget,
      capabilities: capabilities(persistence, revision, isolationFromLastSelfTest(db, profile.id)),
    };
  });
  return { exitCode: EXIT_OK, data, human: formatStatus };
}

function formatStatus(data: StatusData): string {
  if (data.profile === null) {
    return [`Dossier de données : ${data.dataDir}`, `Statut : ${orDash(data.hint)}`].join("\n");
  }
  const p = data.profile;
  const lines = [
    `Profil : ${p.id}`,
    `État : ${p.state}${p.emergencyStopLocked ? " (arrêt d'urgence verrouillé)" : ""}`,
    `Motif : ${p.stateReason}`,
    `Policy active : ${orDash(p.activePolicyRevisionId)}`,
    `Expérience active : ${data.activeExperiment === null ? "—" : `${data.activeExperiment.title} (${data.activeExperiment.id})`}`,
    `Daemon : ${formatDaemon(data.daemon)}`,
    `Sessions ouvertes : ${String(data.openSessions)}`,
    `Dernière session : ${formatLastSession(data.lastSession)}`,
    `Dernière activité : ${data.lastEvent === null ? "—" : `#${String(data.lastEvent.sequence)} ${data.lastEvent.at} ${data.lastEvent.type} — ${data.lastEvent.reason}`}`,
    `Budget disponible : inconnu (${data.budget.detail})`,
  ];
  if (data.budget.caps !== null) {
    const c = data.budget.caps;
    lines.push(
      `  Plafonds : ${String(c.tokensPerSession)} tokens/session, ${String(c.tokensPerPeriod)} tokens et ${String(c.sessionsPerPeriod)} sessions par ${c.period.kind} (${c.period.timeZone}), réserve utilisateur ${String(c.userReserveTokens)} tokens`,
    );
  }
  const q = data.budget.subscriptionQuota;
  if (q !== null) {
    lines.push(
      q.enabled
        ? `  Jauge abonnement (expérimentale) : lancement sous ${orDash(q.startBelow)}, arrêt à ${orDash(q.stopAt)}, réserve humaine ${orDash(q.userReserve)}, dépassement ${q.overshootBound ?? "non mesuré"}${q.pacing === null ? "" : `, cible ${q.pacing.target} à la remise à zéro (débit initial ${q.pacing.initialRatePerHour}/h, marge ${String(q.pacing.margin)})`} — ${q.note}`
        : "  Jauge abonnement : désactivée",
    );
  }
  lines.push(
    `Prochain réveil : ${orDash(p.nextWakeAt)}`,
    `Dossier de données : ${data.dataDir}`,
    "Composants :",
    ...data.capabilities.map(formatCapability),
  );
  if (data.persistence === "memory") {
    lines.push("Attention : stockage SQLite non câblé, état en mémoire uniquement.");
  }
  return lines.join("\n");
}

const DAEMON_LABEL: Record<DaemonStatus["state"], string> = {
  running: "actif",
  stopped: "arrêté",
  crashed: "arrêté brutalement (exécution sans fin enregistrée)",
  never: "jamais démarré",
};

function formatDaemon(d: DaemonStatus): string {
  if (d.state === "never") return DAEMON_LABEL.never;
  const mode = d.mode === "simulated" ? " — SIMULÉ (adapter factice, aucun appel modèle)" : "";
  const since =
    d.state === "running"
      ? `, pid ${String(d.pid)} depuis ${orDash(d.startedAt)}`
      : d.state === "stopped"
        ? ` le ${orDash(d.endedAt)} (${orDash(d.endReason)})`
        : `, pid ${String(d.pid)} disparu`;
  return `${DAEMON_LABEL[d.state]}${since}${mode}`;
}

function formatLastSession(s: LastSessionStatus | null): string {
  if (s === null) return "—";
  const tokens =
    s.tokens === null
      ? "consommation inconnue"
      : `${String(s.tokens)} tokens ${s.provenance === "simulated" ? "SIMULÉS" : (s.provenance ?? "de provenance inconnue")}`;
  return `${s.at} — ${s.reason} (${tokens})${s.simulated ? " [SIMULÉ]" : ""}`;
}
