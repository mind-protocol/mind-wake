/**
 * Décisions du policy engine : activation, lancement, actions contrôlées en session.
 * Refus par défaut : toute condition absente, inconnue ou mal formée produit un refus.
 * Chaque décision porte un motif stable (`DenyReason`) et un détail `code[: contexte]`
 * journalisable tel quel.
 */

import type { AdapterCapabilities, ProbeResult } from "../contracts/adapter.js";
import type {
  BudgetAvailability,
  CurrencyCode,
  ProviderQuotaSnapshot,
} from "../contracts/budget.js";
import type { PolicyRevisionId, ProfileId, SessionId, UtcTimestamp } from "../contracts/common.js";
import type { JournalEventInput } from "../contracts/journal.js";
import type { ProfileState } from "../contracts/lifecycle.js";
import type {
  DenyReason,
  PolicyDecision,
  PolicyGroups,
  PolicyRevision,
  RuntimeGroup,
  SubscriptionQuotaGuard,
} from "../contracts/policy.js";
import type { PolicyRepository } from "../contracts/repositories.js";
import type { JsonObject } from "../contracts/common.js";
import { classifyChange } from "./change.js";
import { isUtcTimestamp, resolvePolicy, type PolicyResolution } from "./revisions.js";
import { BASIS_POINTS_MAX, isConfinedPath, isValidHost } from "./validate.js";

export interface ProfileFacts {
  readonly state: ProfileState;
  readonly emergencyStopLocked: boolean;
}

function deny(
  revisionId: PolicyRevisionId | null,
  reason: DenyReason,
  detail: string,
): PolicyDecision {
  return { verdict: "deny", revisionId, reason, detail };
}

function allow(revisionId: PolicyRevisionId, reason: string): PolicyDecision {
  return { verdict: "allow", revisionId, reason };
}

function resolutionDenial(resolution: PolicyResolution): PolicyDecision | null {
  switch (resolution.status) {
    case "active":
      return null;
    case "none":
      return deny(null, "not_consented", resolution.detail);
    case "revoked":
      return deny(resolution.revision.id, "revoked", "policy.revoked");
    case "invalid":
      return deny(resolution.revisionId, "missing_limit", resolution.detail);
  }
}

/** Un fait booléen n'est favorable que s'il vaut exactement `true`. */
function factDenial(
  revisionId: PolicyRevisionId,
  value: unknown,
  name: string,
  reasonIfFalse: DenyReason,
): PolicyDecision | null {
  if (value === true) return null;
  if (value === false) return deny(revisionId, reasonIfFalse, `${name}.unfavorable`);
  return deny(revisionId, "unknown_condition", `${name}.unknown`);
}

/** Activation (`disabled → ready`) : exige une révision consentie, complète et non révoquée. */
export function decideActivation(policies: PolicyRepository, profileId: ProfileId): PolicyDecision {
  const resolution = resolvePolicy(policies, profileId);
  const denial = resolutionDenial(resolution);
  if (denial !== null || resolution.status !== "active") return denial ?? unreachable();
  return allow(resolution.revision.id, "activation.allowed");
}

function unreachable(): never {
  throw new Error("policy: état de résolution incohérent");
}

/** Tarification observée pour le runtime qui serait lancé. */
export type BillingFacts =
  /** Aucune facturation monétaire déclarée (adapter simulé, par exemple). */
  | { readonly kind: "no_charge" }
  | {
      readonly kind: "paid_api";
      readonly provider: string;
      readonly currency: CurrencyCode;
      /** Date d'entrée en vigueur de la grille tarifaire appliquée par le fournisseur. */
      readonly pricingEffectiveSince: UtcTimestamp;
      /** Coût maximal d'une session à cette tarification ; `null` si non établi. */
      readonly maxSessionCostMinor: number | null;
    }
  /**
   * Voie abonnement expérimentale (ADR-004) : consommation du quota d'un forfait,
   * bornée par la jauge officielle du fournisseur. Jamais convertie en tokens ou monnaie.
   */
  | { readonly kind: "subscription_quota" };

/** Signal de priorité humaine horodaté : trop ancien, il vaut condition inconnue. */
export interface PrioritySignal {
  readonly favorable: boolean;
  readonly observedAt: UtcTimestamp;
}

/** Faits fournis par le scheduler, l'adapter, la sandbox et le ledger avant un lancement. */
export interface LaunchFacts {
  readonly profile: ProfileFacts;
  readonly adapter?: {
    readonly probe: ProbeResult;
    readonly capabilities: AdapterCapabilities;
    /** Runtime réellement configuré dans l'adapter ; aucune substitution tolérée. */
    readonly runtime: RuntimeGroup;
  };
  /** Horloge du daemon (UTC) ; sert à juger l'âge des signaux et des lectures de quota. */
  readonly now?: UtcTimestamp;
  readonly billing?: BillingFacts;
  /** Lectures officielles des fenêtres de quota, pour la voie abonnement. */
  readonly quotaSnapshots?: readonly ProviderQuotaSnapshot[];
  readonly sandboxOperational?: boolean;
  readonly windowOpen?: boolean;
  readonly userPriority?: PrioritySignal;
  readonly backoffExpired?: boolean;
  readonly openSessionCount?: number;
  readonly budget?: {
    readonly tokens?: BudgetAvailability;
    readonly sessions?: BudgetAvailability;
    readonly money?: BudgetAvailability;
  };
}

const STATE_DENIALS: { readonly [S in ProfileState]: DenyReason | null } = {
  ready: null,
  stopped: "stopped",
  paused: "paused",
  running: "session_already_active",
  checkpointing: "session_already_active",
  disabled: "not_consented",
  blocked: "unknown_condition",
  hibernating: "unknown_condition",
};

function profileDenial(profile: ProfileFacts | undefined): PolicyDecision | null {
  if (profile === undefined) return deny(null, "unknown_condition", "profile.unknown");
  if (profile.emergencyStopLocked) return deny(null, "stopped", "profile.emergency_stop_locked");
  const reason = STATE_DENIALS[profile.state] as DenyReason | null | undefined;
  if (reason === undefined) return deny(null, "unknown_condition", "profile.state_unknown");
  if (reason !== null) {
    return deny(null, reason, `profile.state_not_ready: ${profile.state}`);
  }
  return null;
}

/**
 * Décision avant lancement (SPEC §5.1) : toutes les conditions sont nécessaires, la
 * première condition défavorable donne le motif. Le budget est vérifié sur l'instantané
 * fourni ; la réservation atomique reste du ressort du ledger.
 */
export function decideLaunch(
  policies: PolicyRepository,
  profileId: ProfileId,
  facts: LaunchFacts,
): PolicyDecision {
  const profileDeny = profileDenial(facts.profile);
  if (profileDeny !== null) return profileDeny;

  const resolution = resolvePolicy(policies, profileId);
  const denial = resolutionDenial(resolution);
  if (denial !== null || resolution.status !== "active") return denial ?? unreachable();
  const { revision, consent } = resolution;
  const id = revision.id;
  const groups = revision.groups;

  if (!isUtcTimestamp(facts.now)) return deny(id, "unknown_condition", "clock.unknown");
  const now = facts.now;

  const adapterDeny = adapterDenial(id, groups, facts.adapter, facts.billing);
  if (adapterDeny !== null) return adapterDeny;

  const billingDeny =
    facts.billing?.kind === "subscription_quota"
      ? subscriptionLaunchDenial(id, groups, now, facts)
      : billingDenial(id, groups, consent.grantedAt, facts.billing, facts.budget);
  if (billingDeny !== null) return billingDeny;

  for (const [value, name, reason] of [
    [facts.sandboxOperational, "sandbox", "sandbox_unavailable"],
    [facts.windowOpen, "window", "outside_window"],
  ] as const) {
    const d = factDenial(id, value, name, reason);
    if (d !== null) return d;
  }
  const priority = priorityDenial(id, groups, now, facts.userPriority);
  if (priority !== null) return priority;
  const backoff = factDenial(id, facts.backoffExpired, "backoff", "backoff_active");
  if (backoff !== null) return backoff;

  if (facts.openSessionCount === undefined || !Number.isSafeInteger(facts.openSessionCount)) {
    return deny(id, "unknown_condition", "sessions.open_count_unknown");
  }
  if (facts.openSessionCount !== 0) {
    return deny(id, "session_already_active", `sessions.open: ${String(facts.openSessionCount)}`);
  }

  // Voie abonnement : la garde de quota est la borne (ADR-005) ; aucun plafond de tokens
  // propre à Wake n'est exigé, et les points de base ne sont jamais convertis en tokens.
  if (facts.billing?.kind !== "subscription_quota") {
    const tokens = availabilityDenial(
      id,
      facts.budget?.tokens,
      "tokens",
      groups.budget.tokensPerSession,
    );
    if (tokens !== null) return tokens;
  }
  const sessions = availabilityDenial(id, facts.budget?.sessions, "sessions", 1);
  if (sessions !== null) return sessions;

  return allow(id, "launch.allowed");
}

function adapterDenial(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  adapter: LaunchFacts["adapter"],
  billing: BillingFacts | undefined,
): PolicyDecision | null {
  if (adapter === undefined) return deny(id, "unknown_condition", "adapter.unknown");
  const { probe, capabilities, runtime } = adapter;
  if (!probe.available) {
    return deny(
      id,
      "adapter_incompatible",
      `adapter.unavailable: ${probe.unavailableReason ?? ""}`,
    );
  }
  for (const key of ["adapterId", "provider", "model", "authMode"] as const) {
    if (runtime[key] !== groups.runtime[key]) {
      return deny(id, "not_consented", `runtime.${key}_mismatch`);
    }
  }
  if (probe.adapterId !== groups.runtime.adapterId) {
    return deny(id, "not_consented", "runtime.adapterId_mismatch");
  }
  // La jauge de quota ne borne que la voie abonnement ; elle ne remplace jamais un
  // plafond de tokens pour une autre voie.
  const enforcement = capabilities.tokenCapEnforcement;
  const quotaGuardBound =
    enforcement === "provider_quota_guard" && billing?.kind === "subscription_quota";
  if (enforcement !== "native" && enforcement !== "conservative_bound" && !quotaGuardBound) {
    return deny(id, "bound_not_enforceable", "adapter.token_cap_not_enforceable");
  }
  if (capabilities.cancellation === "none") {
    return deny(id, "adapter_incompatible", "adapter.no_cancellation");
  }
  if (!capabilities.userPrioritySignal) {
    return deny(id, "adapter_incompatible", "adapter.no_user_priority_signal");
  }
  if (!capabilities.isolationCompatible) {
    return deny(id, "sandbox_unavailable", "adapter.isolation_incompatible");
  }
  return null;
}

/**
 * Dépense : une API payante exige une autorisation explicite (fournisseur, devise,
 * plafonds). Une tarification entrée en vigueur après le consentement, ou un coût de
 * session supérieur au plafond consenti, exige une nouvelle borne validée par l'humain.
 */
function billingDenial(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  consentedAt: UtcTimestamp,
  billing: BillingFacts | undefined,
  budget: LaunchFacts["budget"],
): PolicyDecision | null {
  if (billing === undefined) return deny(id, "unknown_condition", "billing.unknown");
  if (billing.kind === "no_charge") return null;
  if (billing.kind !== "paid_api") return deny(id, "unknown_condition", "billing.unknown_kind");
  const paid = groups.budget.paidApi;
  if (!paid.authorized) return deny(id, "permission_not_granted", "spend.paid_api_not_authorized");
  if (billing.provider !== paid.provider || billing.currency !== paid.currency) {
    return deny(id, "not_consented", "spend.provider_or_currency_mismatch");
  }
  if (!isUtcTimestamp(billing.pricingEffectiveSince)) {
    return deny(id, "unknown_condition", "pricing.unknown");
  }
  if (Date.parse(billing.pricingEffectiveSince) > Date.parse(consentedAt)) {
    return deny(id, "not_consented", "pricing.changed_requires_new_monetary_bound");
  }
  if (billing.maxSessionCostMinor === null || !Number.isSafeInteger(billing.maxSessionCostMinor)) {
    return deny(id, "bound_not_enforceable", "pricing.session_cost_bound_unknown");
  }
  if (billing.maxSessionCostMinor > paid.perSessionCapMinor) {
    return deny(id, "not_consented", "pricing.session_cost_exceeds_consented_bound");
  }
  const money = budget?.money;
  if (money !== undefined && money.currency !== paid.currency) {
    return deny(id, "budget_unknown", "money.currency_mismatch");
  }
  return availabilityDenial(id, money, "money", billing.maxSessionCostMinor);
}

/** Âge d'un horodatage par rapport à `now` ; `null` si invalide ou dans le futur. */
function ageMs(now: UtcTimestamp, at: unknown): number | null {
  if (!isUtcTimestamp(at)) return null;
  const age = Date.parse(now) - Date.parse(at);
  return age >= 0 ? age : null;
}

/** Priorité humaine : absente, mal formée ou plus ancienne que `maxSignalAgeMs` → refus. */
function priorityDenial(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  now: UtcTimestamp,
  signal: PrioritySignal | undefined,
): PolicyDecision | null {
  if (signal === undefined) return deny(id, "unknown_condition", "user_priority.unknown");
  const age = ageMs(now, signal.observedAt);
  if (age === null) return deny(id, "unknown_condition", "user_priority.unknown");
  if (age > groups.humanPriority.maxSignalAgeMs) {
    return deny(id, "unknown_condition", `user_priority.stale: age_ms=${String(age)}`);
  }
  return factDenial(id, signal.favorable, "user_priority", "user_priority");
}

type EnabledGuard = Extract<SubscriptionQuotaGuard, { enabled: true }>;

function enabledGuard(groups: PolicyGroups): EnabledGuard | null {
  const guard = groups.budget.subscriptionQuota;
  return guard?.enabled === true && (guard.accountRiskAcknowledged as unknown) === true
    ? guard
    : null;
}

/**
 * Voie abonnement (ADR-004) : elle ne lève aucune autre condition (isolation, priorité,
 * annulation, sessions, tokens restent vérifiés par `decideLaunch`). La reconnaissance du
 * risque de compte ne suffit pas : il faut un dépassement consenti non nul, une lecture
 * officielle de la jauge, et chaque fenêtre lue `measured`, récente et sous le seuil de
 * départ.
 */
function subscriptionLaunchDenial(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  now: UtcTimestamp,
  facts: LaunchFacts,
): PolicyDecision | null {
  const guard = enabledGuard(groups);
  if (guard === null) return deny(id, "permission_not_granted", "subscription.not_enabled");
  const overshoot = guard.overshootBoundBasisPoints;
  if (overshoot === null || !Number.isSafeInteger(overshoot) || overshoot < 0) {
    return deny(id, "bound_not_enforceable", "subscription.overshoot_not_measured");
  }
  if (guard.stopAtBasisPoints + overshoot > BASIS_POINTS_MAX - guard.userReserveBasisPoints) {
    return deny(id, "bound_not_enforceable", "subscription.bound_exceeds_user_reserve");
  }
  if (facts.adapter?.capabilities.providerQuotaReading !== "official") {
    return deny(id, "bound_not_enforceable", "subscription.no_official_quota_reading");
  }
  return quotaDenial(id, guard, now, facts.quotaSnapshots, "start");
}

/** Préfixe du détail « remise à zéro trop lointaine », lu par le scheduler. */
export const RESET_NOT_WITHIN = "subscription.reset_not_within";

/**
 * Lectures de quota : au moins une, toutes `measured`, récentes, cohérentes, et sous le
 * seuil de départ (`start`) ou d'arrêt (`stop`). Au départ, chaque fenêtre lue doit en
 * outre se remettre à zéro dans `launchWhenResetWithinMs` (ADR-005) : Wake ne consomme
 * que ce qui serait perdu de toute façon. Les points de base ne sont jamais convertis en
 * tokens.
 */
function quotaDenial(
  id: PolicyRevisionId,
  guard: EnabledGuard,
  now: UtcTimestamp,
  snapshots: readonly ProviderQuotaSnapshot[] | undefined,
  phase: "start" | "stop",
): PolicyDecision | null {
  if (snapshots === undefined || snapshots.length === 0) {
    return deny(id, "budget_unknown", "subscription.quota_unknown");
  }
  const threshold = phase === "start" ? guard.startBelowBasisPoints : guard.stopAtBasisPoints;
  for (const snapshot of snapshots) {
    const key = snapshot.windowKey;
    if (snapshot.provenance !== "measured") {
      return deny(id, "budget_unknown", `subscription.snapshot_not_measured: ${key}`);
    }
    const age = ageMs(now, snapshot.observedAt);
    if (age === null || age > guard.maxSnapshotAgeMs) {
      return deny(id, "budget_unknown", `subscription.snapshot_stale: ${key}`);
    }
    const used = snapshot.usedBasisPoints;
    if (!Number.isSafeInteger(used) || used < 0 || used > BASIS_POINTS_MAX) {
      return deny(id, "budget_unknown", `subscription.snapshot_invalid: ${key}`);
    }
    if (used >= threshold) {
      return deny(
        id,
        "budget_exhausted",
        `subscription.${phase}_threshold_reached: ${key} used_bp=${String(used)}`,
      );
    }
    if (phase === "start") {
      if (!isUtcTimestamp(snapshot.resetsAt)) {
        return deny(id, "budget_unknown", `subscription.snapshot_invalid: ${key}`);
      }
      const resetsInMs = Date.parse(snapshot.resetsAt) - Date.parse(now);
      // Remise à zéro déjà passée : la lecture décrit une fenêtre close, donc périmée.
      if (resetsInMs <= 0) {
        return deny(id, "budget_unknown", `subscription.snapshot_reset_passed: ${key}`);
      }
      if (resetsInMs > guard.launchWhenResetWithinMs) {
        return deny(
          id,
          "outside_window",
          `${RESET_NOT_WITHIN}: ${key} resets_in_ms=${String(resetsInMs)}`,
        );
      }
    }
  }
  return null;
}

function availabilityDenial(
  id: PolicyRevisionId,
  availability: BudgetAvailability | undefined,
  name: string,
  needed: number,
): PolicyDecision | null {
  if (availability === undefined) return deny(id, "budget_unknown", `${name}.availability_unknown`);
  const available = availability.available;
  if (available === null || !Number.isFinite(available)) {
    return deny(id, "budget_unknown", `${name}.available_unknown`);
  }
  if (available < needed) {
    return deny(
      id,
      "budget_exhausted",
      `${name}.insufficient: available=${String(available)} needed=${String(needed)}`,
    );
  }
  return null;
}

/** Session active telle que connue du runner. */
export interface ActiveSessionRef {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /** Révision en vigueur au lancement de la session. */
  readonly policyRevisionId: PolicyRevisionId;
}

/** Contrôles revérifiés avant chaque action d'une session active. */
export interface SessionChecks {
  readonly now: UtcTimestamp;
  readonly userPriority?: PrioritySignal;
  readonly sandboxOperational?: boolean;
  /** `true` si la session consomme un quota d'abonnement (voie ADR-004). */
  readonly onSubscription?: boolean;
  readonly quotaSnapshots?: readonly ProviderQuotaSnapshot[];
}

export type SessionAssessment =
  | {
      readonly interruptSession: false;
      /** Révision qui gouverne les actions de la session. */
      readonly governing: PolicyRevision;
    }
  | {
      readonly interruptSession: true;
      readonly revisionId: PolicyRevisionId | null;
      readonly reason: DenyReason;
      readonly detail: string;
      /** Un checkpoint borné reste permis (restriction ou pause), pas après révocation. */
      readonly checkpointAllowed: boolean;
    };

/**
 * Évalue une session déjà lancée face à la policy courante. Une restriction, une
 * révocation, une pause ou un arrêt exigent l'interruption ; un élargissement ne profite
 * pas à la session en cours, qui reste gouvernée par sa propre révision.
 */
export function assessActiveSession(
  policies: PolicyRepository,
  profile: ProfileFacts,
  session: ActiveSessionRef,
  checks: SessionChecks,
): SessionAssessment {
  const interrupt = (
    revisionId: PolicyRevisionId | null,
    reason: DenyReason,
    detail: string,
    checkpointAllowed: boolean,
  ): SessionAssessment => ({
    interruptSession: true,
    revisionId,
    reason,
    detail,
    checkpointAllowed,
  });

  if (profile.emergencyStopLocked || profile.state === "stopped") {
    return interrupt(null, "stopped", "profile.stopped", false);
  }
  if (profile.state === "paused") {
    return interrupt(session.policyRevisionId, "paused", "profile.paused", true);
  }

  const resolution = resolvePolicy(policies, session.profileId);
  const denial = resolutionDenial(resolution);
  if (denial !== null && denial.verdict === "deny") {
    return interrupt(denial.revisionId, denial.reason, denial.detail, false);
  }
  if (resolution.status !== "active") return unreachable();

  const own = policies.getRevision(session.policyRevisionId);
  if (own === null || own.profileId !== session.profileId) {
    return interrupt(
      session.policyRevisionId,
      "unknown_condition",
      "session.revision_unknown",
      false,
    );
  }
  if (policies.listRevocations(own.id).length > 0) {
    return interrupt(own.id, "revoked", "session.revision_revoked", false);
  }
  if (own.id !== resolution.revision.id) {
    const change = classifyChange(own.groups, resolution.revision.groups);
    if (change.restricted.length > 0) {
      return interrupt(
        resolution.revision.id,
        "permission_not_granted",
        `policy.restricted_during_session: ${change.restricted.join(", ")}`,
        true,
      );
    }
  }

  // Conditions vivantes : revérifiées à chaque action, pas seulement au lancement.
  const live = sessionChecksDenial(own, checks);
  if (live !== null && live.verdict === "deny") {
    return interrupt(own.id, live.reason, live.detail, live.reason !== "sandbox_unavailable");
  }
  return { interruptSession: false, governing: own };
}

function sessionChecksDenial(
  revision: PolicyRevision,
  checks: SessionChecks | undefined,
): PolicyDecision | null {
  const id = revision.id;
  if (checks === undefined || !isUtcTimestamp(checks.now)) {
    return deny(id, "unknown_condition", "clock.unknown");
  }
  const priority = priorityDenial(id, revision.groups, checks.now, checks.userPriority);
  if (priority !== null) return priority;
  const sandbox = factDenial(id, checks.sandboxOperational, "sandbox", "sandbox_unavailable");
  if (sandbox !== null) return sandbox;
  if (checks.onSubscription === false) return null;
  if (checks.onSubscription !== true) {
    return deny(id, "unknown_condition", "subscription.session_mode_unknown");
  }
  const guard = enabledGuard(revision.groups);
  if (guard === null) return deny(id, "permission_not_granted", "subscription.not_enabled");
  return quotaDenial(id, guard, checks.now, checks.quotaSnapshots, "stop");
}

/** Cumul de dépense déjà engagé, fourni par le ledger. */
export interface SpendFacts {
  readonly currency: CurrencyCode;
  readonly sessionSpentMinor: number;
  readonly periodSpentMinor: number;
}

export type ActionDecision = PolicyDecision & { readonly interruptSession: boolean };

type Obj = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function underRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => root === "." || path === root || path.startsWith(`${root}/`));
}

/**
 * Décision avant chaque action contrôlée d'une session active. L'action est traitée
 * comme une donnée non fiable : forme inconnue ou champ invalide → refus.
 */
export function decideAction(
  policies: PolicyRepository,
  profile: ProfileFacts,
  session: ActiveSessionRef,
  checks: SessionChecks,
  action: unknown,
  spend?: SpendFacts,
): ActionDecision {
  const assessment = assessActiveSession(policies, profile, session, checks);
  const kind = isObject(action) ? action["kind"] : undefined;

  if (assessment.interruptSession) {
    const checkpointOk =
      kind === "publish_checkpoint" &&
      assessment.checkpointAllowed &&
      (profile.state === "running" || profile.state === "checkpointing") &&
      assessment.revisionId !== null;
    if (checkpointOk) {
      return {
        verdict: "allow",
        revisionId: assessment.revisionId,
        reason: "publish_checkpoint.allowed_during_interruption",
        interruptSession: true,
      };
    }
    return {
      verdict: "deny",
      revisionId: assessment.revisionId,
      reason: assessment.reason,
      detail: assessment.detail,
      interruptSession: true,
    };
  }

  const decision = evaluateAction(assessment.governing, profile, action, spend);
  return { ...decision, interruptSession: false };
}

function evaluateAction(
  revision: PolicyRevision,
  profile: ProfileFacts,
  action: unknown,
  spend: SpendFacts | undefined,
): PolicyDecision {
  const id = revision.id;
  const groups = revision.groups;
  if (!isObject(action) || typeof action["kind"] !== "string") {
    return deny(id, "unknown_condition", "action.malformed");
  }
  const kind = action["kind"];

  if (kind === "publish_checkpoint") {
    return profile.state === "running" || profile.state === "checkpointing"
      ? allow(id, "publish_checkpoint.allowed")
      : deny(id, "unknown_condition", `profile.state_not_active: ${profile.state}`);
  }
  if (profile.state !== "running") {
    return deny(id, "unknown_condition", `profile.state_not_running: ${profile.state}`);
  }

  switch (kind) {
    case "file_read":
    case "file_write": {
      const path = action["path"];
      if (!isConfinedPath(path, false))
        return deny(id, "permission_not_granted", "file.path_not_confined");
      const roots =
        kind === "file_read" ? groups.filesAndTools.readRoots : groups.filesAndTools.writeRoots;
      return underRoot(path, roots)
        ? allow(id, `${kind}.allowed`)
        : deny(id, "permission_not_granted", `${kind}.outside_roots`);
    }
    case "exec_tool": {
      const exe = action["executable"];
      return typeof exe === "string" && groups.filesAndTools.allowedExecutables.includes(exe)
        ? allow(id, "exec_tool.allowed")
        : deny(id, "permission_not_granted", "exec_tool.not_allowed");
    }
    case "network": {
      const host = action["host"];
      const port = action["port"];
      if (!isValidHost(host) || typeof port !== "number" || !Number.isSafeInteger(port)) {
        return deny(id, "permission_not_granted", "network.malformed_destination");
      }
      const granted = groups.network.explorationDestinations.some(
        (d) => d.host === host && d.ports.includes(port),
      );
      return granted
        ? allow(id, "network.allowed")
        : deny(id, "permission_not_granted", "network.destination_not_granted");
    }
    case "spend":
      return spendDecision(id, groups, action, spend);
    case "launch_session":
      return deny(id, "unknown_condition", "action.launch_requires_launch_decision");
    default:
      return deny(id, "unknown_condition", "action.unknown_kind");
  }
}

function spendDecision(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  action: Obj,
  spend: SpendFacts | undefined,
): PolicyDecision {
  const paid = groups.budget.paidApi;
  if (!paid.authorized) return deny(id, "permission_not_granted", "spend.paid_api_not_authorized");
  const amount = action["amountMinor"];
  if (action["provider"] !== paid.provider || action["currency"] !== paid.currency) {
    return deny(id, "permission_not_granted", "spend.provider_or_currency_not_granted");
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) {
    return deny(id, "unknown_condition", "spend.amount_invalid");
  }
  if (
    spend === undefined ||
    spend.currency !== paid.currency ||
    !Number.isSafeInteger(spend.sessionSpentMinor) ||
    !Number.isSafeInteger(spend.periodSpentMinor)
  ) {
    return deny(id, "budget_unknown", "spend.totals_unknown");
  }
  if (spend.sessionSpentMinor + amount > paid.perSessionCapMinor) {
    return deny(id, "budget_exhausted", "spend.session_cap_exceeded");
  }
  if (spend.periodSpentMinor + amount > paid.perPeriodCapMinor) {
    return deny(id, "budget_exhausted", "spend.period_cap_exceeded");
  }
  return allow(id, "spend.allowed");
}

function actionMetadata(action: unknown): JsonObject {
  if (!isObject(action)) return { action: "malformed" };
  const meta: Record<string, string | number> = {};
  for (const key of [
    "kind",
    "path",
    "executable",
    "host",
    "port",
    "provider",
    "amountMinor",
    "currency",
  ]) {
    const value = action[key];
    if (typeof value === "string") meta[key] = value.slice(0, 512);
    else if (typeof value === "number" && Number.isFinite(value)) meta[key] = value;
  }
  return meta;
}

/** Événement de journal `action_allowed` / `action_denied` pour une décision. */
export function decisionJournalEvent(
  decision: PolicyDecision,
  context: {
    readonly profileId: ProfileId;
    readonly at: UtcTimestamp;
    readonly action: unknown;
    readonly sessionId?: SessionId;
  },
): JournalEventInput {
  const base = {
    at: context.at,
    profileId: context.profileId,
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    ...(decision.revisionId === null ? {} : { policyRevisionId: decision.revisionId }),
  };
  const interrupt =
    "interruptSession" in decision && typeof decision.interruptSession === "boolean"
      ? { interruptSession: decision.interruptSession }
      : {};
  return decision.verdict === "allow"
    ? {
        ...base,
        type: "action_allowed",
        reason: decision.reason,
        metadata: { ...actionMetadata(context.action), verdict: "allow", ...interrupt },
      }
    : {
        ...base,
        type: "action_denied",
        reason: decision.reason,
        metadata: {
          ...actionMetadata(context.action),
          verdict: "deny",
          detail: decision.detail,
          ...interrupt,
        },
      };
}
