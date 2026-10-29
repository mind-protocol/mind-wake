/**
 * `status` : état courant, expérience active, dernière activité, budget, prochain réveil
 * et motif d'attente (SPEC §3.3). Lecture seule.
 */

import type { BudgetPeriodDefinition, ProfileState } from "../../contracts/index.js";
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
}

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
  readonly lastEvent: {
    readonly sequence: number;
    readonly at: string;
    readonly type: string;
    readonly reason: string;
  } | null;
  readonly budget: BudgetStatus;
}

const NO_BUDGET: BudgetStatus = {
  availability: "unknown",
  detail: "aucune policy active : aucun budget accordé",
  caps: null,
};

export function status(ctx: CliContext, dataDir: DataDir): CommandResult<StatusData> {
  const data = withReadStore(ctx, dataDir, ({ uow, persistence }): StatusData => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    if (uow === null || profile === null) {
      return {
        dataDir: dataDir.path,
        persistence,
        profile: null,
        hint: NO_PROFILE_HINT,
        activeExperiment: null,
        openSessions: 0,
        lastEvent: null,
        budget: NO_BUDGET,
      };
    }
    const experiment = uow.experiments.getActive(profile.id);
    const events = uow.journal.list(profile.id);
    const last = events.at(-1);
    const revision =
      profile.activePolicyRevisionId === null
        ? null
        : uow.policies.getRevision(profile.activePolicyRevisionId);
    const budget: BudgetStatus =
      revision === null
        ? NO_BUDGET
        : {
            availability: "unknown",
            detail: "disponibilité non calculée : ledger SQLite non câblé",
            caps: {
              period: revision.groups.budget.period,
              tokensPerSession: revision.groups.budget.tokensPerSession,
              tokensPerPeriod: revision.groups.budget.tokensPerPeriod,
              sessionsPerPeriod: revision.groups.budget.sessionsPerPeriod,
              userReserveTokens: revision.groups.budget.userReserveTokens,
            },
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
      lastEvent:
        last === undefined
          ? null
          : { sequence: last.sequence, at: last.at, type: last.type, reason: last.reason },
      budget,
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
    `Sessions ouvertes : ${String(data.openSessions)}`,
    `Dernière activité : ${data.lastEvent === null ? "—" : `#${String(data.lastEvent.sequence)} ${data.lastEvent.at} ${data.lastEvent.type} — ${data.lastEvent.reason}`}`,
    `Budget disponible : inconnu (${data.budget.detail})`,
  ];
  if (data.budget.caps !== null) {
    const c = data.budget.caps;
    lines.push(
      `  Plafonds : ${String(c.tokensPerSession)} tokens/session, ${String(c.tokensPerPeriod)} tokens et ${String(c.sessionsPerPeriod)} sessions par ${c.period.kind} (${c.period.timeZone}), réserve utilisateur ${String(c.userReserveTokens)} tokens`,
    );
  }
  lines.push(`Prochain réveil : ${orDash(p.nextWakeAt)}`, `Dossier de données : ${data.dataDir}`);
  if (data.persistence === "memory") {
    lines.push("Attention : stockage SQLite non câblé, état en mémoire uniquement.");
  }
  return lines.join("\n");
}
