/**
 * Décisions du policy engine : activation, lancement, actions contrôlées en session.
 * Refus par défaut : toute condition absente, inconnue ou mal formée produit un refus.
 * Chaque décision porte un motif stable (`DenyReason`) et un détail `code[: contexte]`
 * journalisable tel quel.
 */

import type { AdapterCapabilities, ProbeResult } from "../contracts/adapter.js";
import type { BudgetAvailability, CurrencyCode } from "../contracts/budget.js";
import type { PolicyRevisionId, ProfileId, SessionId, UtcTimestamp } from "../contracts/common.js";
import type { JournalEventInput } from "../contracts/journal.js";
import type { ProfileState } from "../contracts/lifecycle.js";
import type {
  DenyReason,
  PolicyDecision,
  PolicyGroups,
  PolicyRevision,
  RuntimeGroup,
} from "../contracts/policy.js";
import type { PolicyRepository } from "../contracts/repositories.js";
import type { JsonObject } from "../contracts/common.js";
import { classifyChange } from "./change.js";
import { isUtcTimestamp, resolvePolicy, type PolicyResolution } from "./revisions.js";
import { isConfinedPath, isValidHost } from "./validate.js";

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
    };

/** Faits fournis par le scheduler, l'adapter, la sandbox et le ledger avant un lancement. */
export interface LaunchFacts {
  readonly profile: ProfileFacts;
  readonly adapter?: {
    readonly probe: ProbeResult;
    readonly capabilities: AdapterCapabilities;
    /** Runtime réellement configuré dans l'adapter ; aucune substitution tolérée. */
    readonly runtime: RuntimeGroup;
  };
  readonly billing?: BillingFacts;
  readonly sandboxOperational?: boolean;
  readonly windowOpen?: boolean;
  readonly userPriorityFavorable?: boolean;
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

  const adapterDeny = adapterDenial(id, groups, facts.adapter);
  if (adapterDeny !== null) return adapterDeny;

  const billingDeny = billingDenial(id, groups, consent.grantedAt, facts.billing, facts.budget);
  if (billingDeny !== null) return billingDeny;

  for (const [value, name, reason] of [
    [facts.sandboxOperational, "sandbox", "sandbox_unavailable"],
    [facts.windowOpen, "window", "outside_window"],
    [facts.userPriorityFavorable, "user_priority", "user_priority"],
    [facts.backoffExpired, "backoff", "backoff_active"],
  ] as const) {
    const d = factDenial(id, value, name, reason);
    if (d !== null) return d;
  }

  if (facts.openSessionCount === undefined || !Number.isSafeInteger(facts.openSessionCount)) {
    return deny(id, "unknown_condition", "sessions.open_count_unknown");
  }
  if (facts.openSessionCount !== 0) {
    return deny(id, "session_already_active", `sessions.open: ${String(facts.openSessionCount)}`);
  }

  const tokens = availabilityDenial(
    id,
    facts.budget?.tokens,
    "tokens",
    groups.budget.tokensPerSession,
  );
  if (tokens !== null) return tokens;
  const sessions = availabilityDenial(id, facts.budget?.sessions, "sessions", 1);
  if (sessions !== null) return sessions;

  return allow(id, "launch.allowed");
}

function adapterDenial(
  id: PolicyRevisionId,
  groups: PolicyGroups,
  adapter: LaunchFacts["adapter"],
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
  if (
    capabilities.tokenCapEnforcement !== "native" &&
    capabilities.tokenCapEnforcement !== "conservative_bound"
  ) {
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
  if ((billing.kind as string) !== "paid_api")
    return deny(id, "unknown_condition", "billing.unknown_kind");
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
  if (profile.state === "paused") return interrupt(null, "paused", "profile.paused", true);

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
  if (own.id === resolution.revision.id) return { interruptSession: false, governing: own };

  const change = classifyChange(own.groups, resolution.revision.groups);
  if (change.restricted.length > 0) {
    return interrupt(
      resolution.revision.id,
      "permission_not_granted",
      `policy.restricted_during_session: ${change.restricted.join(", ")}`,
      true,
    );
  }
  return { interruptSession: false, governing: own };
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
  action: unknown,
  spend?: SpendFacts,
): ActionDecision {
  const assessment = assessActiveSession(policies, profile, session);
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
