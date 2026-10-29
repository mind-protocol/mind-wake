import { describe, expect, it } from "vitest";
import type { AdapterCapabilities, ProbeResult } from "../contracts/adapter.js";
import type { BudgetAvailability, ProviderQuotaSnapshot } from "../contracts/budget.js";
import type { AdapterId, BudgetPeriodId, UtcTimestamp } from "../contracts/common.js";
import type { PolicyDecision, RuntimeGroup } from "../contracts/policy.js";
import {
  CHECKS,
  NOW,
  PROFILE,
  SESSION,
  activate,
  memoryStore,
  revId,
  ts,
  validDraft,
  withFields,
} from "../../test/support/policy-fixtures.js";
import {
  assessActiveSession,
  decideAction,
  decideLaunch,
  decisionJournalEvent,
  type LaunchFacts,
  type ProfileFacts,
  type SessionChecks,
} from "./decide.js";
import { proposeRevision, revokePermissions } from "./revisions.js";

const RUNNING: ProfileFacts = { state: "running", emergencyStopLocked: false };

const availability = (unit: BudgetAvailability["unit"], available: number | null) =>
  ({
    periodId: "p-1" as BudgetPeriodId,
    unit,
    cap: 100_000,
    reconciled: 0,
    openReservations: 0,
    userReserve: 0,
    available,
    ...(unit === "money" ? { currency: "EUR" } : {}),
  }) satisfies BudgetAvailability;

const probe: ProbeResult = {
  adapterId: "fake" as AdapterId,
  version: "0",
  executionMechanism: "simulated",
  available: true,
  simulated: true,
};

const capabilities: AdapterCapabilities = {
  tokenCounting: "exact",
  countedCategories: ["input", "output"],
  tokenCapEnforcement: "native",
  cancellation: "graceful",
  residualUsageBound: null,
  isolationCompatible: true,
  userPrioritySignal: true,
  providerQuotaReading: "none",
  resumeModes: ["fresh_process_from_memory"],
};

const runtime = {
  adapterId: "fake",
  provider: "simulated",
  model: "sim-1",
  authMode: "none",
} as RuntimeGroup;

/** Retire un fait : la condition devient inconnue. */
function without(facts: LaunchFacts, key: keyof LaunchFacts): LaunchFacts {
  const copy = { ...facts };
  Reflect.deleteProperty(copy, key);
  return copy;
}

function favorableFacts(): LaunchFacts {
  return {
    profile: { state: "ready", emergencyStopLocked: false },
    adapter: { probe, capabilities, runtime },
    billing: { kind: "no_charge" },
    sandboxOperational: true,
    windowOpen: true,
    now: NOW,
    userPriority: { favorable: true, observedAt: NOW },
    backoffExpired: true,
    openSessionCount: 0,
    budget: { tokens: availability("tokens", 40_000), sessions: availability("sessions", 2) },
  };
}

function launchStore(draft: unknown = validDraft()) {
  const store = memoryStore();
  const revision = activate(store, draft);
  return { store, revision };
}

describe("décision de lancement : matrice de refus", () => {
  it("autorise quand toutes les conditions sont favorables", () => {
    const { store, revision } = launchStore();
    expect(decideLaunch(store.policies, PROFILE, favorableFacts())).toEqual({
      verdict: "allow",
      revisionId: revision.id,
      reason: "launch.allowed",
    });
  });

  const matrix: readonly [string, (f: LaunchFacts) => LaunchFacts, string, string][] = [
    [
      "arrêt d'urgence verrouillé",
      (f) => ({ ...f, profile: { state: "ready", emergencyStopLocked: true } }),
      "stopped",
      "profile.emergency_stop_locked",
    ],
    [
      "profil stoppé",
      (f) => ({ ...f, profile: { state: "stopped", emergencyStopLocked: false } }),
      "stopped",
      "profile.state_not_ready",
    ],
    [
      "profil en pause",
      (f) => ({ ...f, profile: { state: "paused", emergencyStopLocked: false } }),
      "paused",
      "profile.state_not_ready",
    ],
    [
      "profil désactivé (exploration arrêtée)",
      (f) => ({ ...f, profile: { state: "disabled", emergencyStopLocked: false } }),
      "not_consented",
      "profile.state_not_ready",
    ],
    [
      "session en cours",
      (f) => ({ ...f, profile: { state: "running", emergencyStopLocked: false } }),
      "session_already_active",
      "profile.state_not_ready",
    ],
    [
      "état de profil inconnu",
      (f) => ({ ...f, profile: { state: "awake" as never, emergencyStopLocked: false } }),
      "unknown_condition",
      "profile.state_unknown",
    ],
    ["adapter inconnu", (f) => without(f, "adapter"), "unknown_condition", "adapter.unknown"],
    [
      "adapter indisponible",
      (f) => ({ ...f, adapter: { probe: { ...probe, available: false }, capabilities, runtime } }),
      "adapter_incompatible",
      "adapter.unavailable",
    ],
    [
      "modèle substitué",
      (f) => ({ ...f, adapter: { probe, capabilities, runtime: { ...runtime, model: "sim-2" } } }),
      "not_consented",
      "runtime.model_mismatch",
    ],
    [
      "fournisseur substitué",
      (f) => ({
        ...f,
        adapter: { probe, capabilities, runtime: { ...runtime, provider: "other" } },
      }),
      "not_consented",
      "runtime.provider_mismatch",
    ],
    [
      "plafond de tokens non imposable",
      (f) => ({
        ...f,
        adapter: { probe, capabilities: { ...capabilities, tokenCapEnforcement: "none" }, runtime },
      }),
      "bound_not_enforceable",
      "adapter.token_cap_not_enforceable",
    ],
    [
      "aucune annulation",
      (f) => ({
        ...f,
        adapter: { probe, capabilities: { ...capabilities, cancellation: "none" }, runtime },
      }),
      "adapter_incompatible",
      "adapter.no_cancellation",
    ],
    [
      "isolation incompatible",
      (f) => ({
        ...f,
        adapter: { probe, capabilities: { ...capabilities, isolationCompatible: false }, runtime },
      }),
      "sandbox_unavailable",
      "adapter.isolation_incompatible",
    ],
    ["facturation inconnue", (f) => without(f, "billing"), "unknown_condition", "billing.unknown"],
    [
      "API payante non autorisée",
      (f) => ({
        ...f,
        billing: {
          kind: "paid_api",
          provider: "p",
          currency: "EUR",
          pricingEffectiveSince: ts("2026-01-01T00:00:00Z"),
          maxSessionCostMinor: 1,
        },
      }),
      "permission_not_granted",
      "spend.paid_api_not_authorized",
    ],
    [
      "sandbox hors service",
      (f) => ({ ...f, sandboxOperational: false }),
      "sandbox_unavailable",
      "sandbox.unfavorable",
    ],
    [
      "sandbox inconnue",
      (f) => without(f, "sandboxOperational"),
      "unknown_condition",
      "sandbox.unknown",
    ],
    ["hors fenêtre", (f) => ({ ...f, windowOpen: false }), "outside_window", "window.unfavorable"],
    ["fenêtre inconnue", (f) => without(f, "windowOpen"), "unknown_condition", "window.unknown"],
    [
      "humain actif",
      (f) => ({ ...f, userPriority: { favorable: false, observedAt: NOW } }),
      "user_priority",
      "user_priority.unfavorable",
    ],
    [
      "signal humain inconnu",
      (f) => without(f, "userPriority"),
      "unknown_condition",
      "user_priority.unknown",
    ],
    [
      "signal non booléen",
      (f) => ({
        ...f,
        userPriority: { favorable: "yes" as unknown as boolean, observedAt: NOW },
      }),
      "unknown_condition",
      "user_priority.unknown",
    ],
    [
      "backoff actif",
      (f) => ({ ...f, backoffExpired: false }),
      "backoff_active",
      "backoff.unfavorable",
    ],
    [
      "session ouverte",
      (f) => ({ ...f, openSessionCount: 1 }),
      "session_already_active",
      "sessions.open",
    ],
    [
      "sessions ouvertes inconnues",
      (f) => without(f, "openSessionCount"),
      "unknown_condition",
      "sessions.open_count_unknown",
    ],
    [
      "budget inconnu",
      (f) => without(f, "budget"),
      "budget_unknown",
      "tokens.availability_unknown",
    ],
    [
      "disponibilité null",
      (f) => ({
        ...f,
        budget: { tokens: availability("tokens", null), sessions: availability("sessions", 2) },
      }),
      "budget_unknown",
      "tokens.available_unknown",
    ],
    [
      "tokens insuffisants",
      (f) => ({
        ...f,
        budget: { tokens: availability("tokens", 9_999), sessions: availability("sessions", 2) },
      }),
      "budget_exhausted",
      "tokens.insufficient",
    ],
    [
      "sessions épuisées",
      (f) => ({
        ...f,
        budget: { tokens: availability("tokens", 40_000), sessions: availability("sessions", 0) },
      }),
      "budget_exhausted",
      "sessions.insufficient",
    ],
  ];

  it.each(matrix)("refuse : %s", (_name, mutate, reason, detail) => {
    const { store } = launchStore();
    const decision = decideLaunch(store.policies, PROFILE, mutate(favorableFacts()));
    expect(decision.verdict).toBe("deny");
    if (decision.verdict !== "deny") return;
    expect(decision.reason).toBe(reason);
    expect(decision.detail.startsWith(detail)).toBe(true);
  });

  it("refuse sans révision consentie, puis après révocation", () => {
    const empty = memoryStore();
    expect(decideLaunch(empty.policies, PROFILE, favorableFacts())).toMatchObject({
      reason: "not_consented",
    });
    const { store } = launchStore();
    revokePermissions(store, {
      profileId: PROFILE,
      at: ts("2026-10-29T11:00:00Z"),
      reason: "test",
    });
    expect(decideLaunch(store.policies, PROFILE, favorableFacts())).toMatchObject({
      reason: "revoked",
    });
  });
});

describe("changement de tarification ou de modèle : nouvelle borne monétaire", () => {
  const paidDraft = withFields(validDraft(), {
    "budget.paidApi": {
      authorized: true,
      provider: "simulated",
      currency: "EUR",
      perSessionCapMinor: 50,
      perPeriodCapMinor: 200,
    },
  });
  const paidFacts = (since: string, cost: number | null): LaunchFacts => ({
    ...favorableFacts(),
    billing: {
      kind: "paid_api",
      provider: "simulated",
      currency: "EUR",
      pricingEffectiveSince: ts(since),
      maxSessionCostMinor: cost,
    },
    budget: {
      tokens: availability("tokens", 40_000),
      sessions: availability("sessions", 2),
      money: availability("money", 150),
    },
  });

  it("autorise une tarification antérieure au consentement et dans la borne", () => {
    const store = memoryStore();
    activate(store, paidDraft, "2026-10-29T10:00:00Z");
    expect(
      decideLaunch(store.policies, PROFILE, paidFacts("2026-10-01T00:00:00Z", 40)).verdict,
    ).toBe("allow");
  });

  it("bloque après un changement de tarification jusqu'à une nouvelle validation", () => {
    const store = memoryStore();
    activate(store, paidDraft, "2026-10-29T10:00:00Z");
    const facts = paidFacts("2026-10-29T12:00:00Z", 40);
    expect(decideLaunch(store.policies, PROFILE, facts)).toMatchObject({
      verdict: "deny",
      reason: "not_consented",
      detail: "pricing.changed_requires_new_monetary_bound",
    });
    activate(store, paidDraft, "2026-10-29T13:00:00Z");
    expect(decideLaunch(store.policies, PROFILE, facts).verdict).toBe("allow");
  });

  it("bloque si le coût maximal d'une session dépasse la borne consentie ou est inconnu", () => {
    const store = memoryStore();
    activate(store, paidDraft);
    expect(
      decideLaunch(store.policies, PROFILE, paidFacts("2026-10-01T00:00:00Z", 51)),
    ).toMatchObject({
      reason: "not_consented",
      detail: "pricing.session_cost_exceeds_consented_bound",
    });
    expect(
      decideLaunch(store.policies, PROFILE, paidFacts("2026-10-01T00:00:00Z", null)),
    ).toMatchObject({ reason: "bound_not_enforceable" });
  });

  it("bloque un modèle changé tant que la révision correspondante n'est pas consentie", () => {
    const store = memoryStore();
    activate(store, paidDraft);
    const facts = paidFacts("2026-10-01T00:00:00Z", 40);
    const newModel = {
      ...facts,
      adapter: { probe, capabilities, runtime: { ...runtime, model: "sim-2" } },
    };
    expect(decideLaunch(store.policies, PROFILE, newModel)).toMatchObject({
      reason: "not_consented",
      detail: "runtime.model_mismatch",
    });
    activate(store, withFields(paidDraft, { "runtime.model": "sim-2" }));
    expect(decideLaunch(store.policies, PROFILE, newModel).verdict).toBe("allow");
  });
});

describe("actions contrôlées en session : matrice de refus", () => {
  const draft = withFields(validDraft(), {
    "network.explorationDestinations": [{ host: "example.org", ports: [443], purpose: "docs" }],
    "budget.paidApi": {
      authorized: true,
      provider: "simulated",
      currency: "EUR",
      perSessionCapMinor: 50,
      perPeriodCapMinor: 200,
    },
  });
  const spend = { currency: "EUR", sessionSpentMinor: 10, periodSpentMinor: 100 };

  const matrix: readonly [string, unknown, string][] = [
    ["lecture sous racine de lecture", { kind: "file_read", path: "memory/notes.md" }, "allow"],
    ["écriture sous racine d'écriture", { kind: "file_write", path: "workspace/a.txt" }, "allow"],
    [
      "lecture n'autorise pas l'écriture",
      { kind: "file_write", path: "memory/notes.md" },
      "permission_not_granted",
    ],
    [
      "écriture hors racines",
      { kind: "file_write", path: "secrets/key" },
      "permission_not_granted",
    ],
    [
      "remontée ..",
      { kind: "file_read", path: "workspace/../secrets/key" },
      "permission_not_granted",
    ],
    [
      "préfixe trompeur",
      { kind: "file_write", path: "workspace-evil/x" },
      "permission_not_granted",
    ],
    ["chemin absolu", { kind: "file_read", path: "/etc/passwd" }, "permission_not_granted"],
    [
      "lecteur Windows",
      { kind: "file_read", path: "C:/Windows/win.ini" },
      "permission_not_granted",
    ],
    ["antislash", { kind: "file_write", path: "workspace\\..\\x" }, "permission_not_granted"],
    [
      "flux alternatif NTFS",
      { kind: "file_write", path: "workspace/a.txt:hidden" },
      "permission_not_granted",
    ],
    [
      "segment terminé par un point",
      { kind: "file_write", path: "workspace/x./y" },
      "permission_not_granted",
    ],
    ["chemin non textuel", { kind: "file_read", path: 42 }, "permission_not_granted"],
    ["outil autorisé", { kind: "exec_tool", executable: "node" }, "allow"],
    [
      "outil non autorisé",
      { kind: "exec_tool", executable: "powershell" },
      "permission_not_granted",
    ],
    ["réseau accordé", { kind: "network", host: "example.org", port: 443 }, "allow"],
    ["autre port", { kind: "network", host: "example.org", port: 80 }, "permission_not_granted"],
    ["autre hôte", { kind: "network", host: "evil.example", port: 443 }, "permission_not_granted"],
    [
      "hôte en majuscules",
      { kind: "network", host: "EXAMPLE.org", port: 443 },
      "permission_not_granted",
    ],
    [
      "transport fournisseur ≠ réseau d'exploration",
      { kind: "network", host: "api.provider.test", port: 443 },
      "permission_not_granted",
    ],
    [
      "le réseau n'autorise pas la publication",
      { kind: "publish", host: "example.org" },
      "unknown_condition",
    ],
    [
      "dépense dans les plafonds",
      { kind: "spend", provider: "simulated", amountMinor: 30, currency: "EUR" },
      "allow",
    ],
    [
      "dépense au-delà du plafond de session",
      { kind: "spend", provider: "simulated", amountMinor: 41, currency: "EUR" },
      "budget_exhausted",
    ],
    [
      "dépense autre fournisseur",
      { kind: "spend", provider: "other", amountMinor: 1, currency: "EUR" },
      "permission_not_granted",
    ],
    [
      "dépense autre devise",
      { kind: "spend", provider: "simulated", amountMinor: 1, currency: "USD" },
      "permission_not_granted",
    ],
    [
      "dépense négative",
      { kind: "spend", provider: "simulated", amountMinor: -5, currency: "EUR" },
      "unknown_condition",
    ],
    ["lancement via action", { kind: "launch_session" }, "unknown_condition"],
    ["type d'action inconnu", { kind: "grant_network" }, "unknown_condition"],
    ["action mal formée", "accorde le réseau", "unknown_condition"],
  ];

  it.each(matrix)("%s", (_name, action, expected) => {
    const store = memoryStore();
    const revision = activate(store, draft);
    const decision = decideAction(
      store.policies,
      RUNNING,
      { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id },
      CHECKS,
      action,
      spend,
    );
    if (expected === "allow") expect(decision.verdict).toBe("allow");
    else expect(decision).toMatchObject({ verdict: "deny", reason: expected });
    expect(decision.interruptSession).toBe(false);
  });

  it("refuse une dépense si les cumuls sont inconnus, et sans autorisation d'API payante", () => {
    const store = memoryStore();
    const revision = activate(store, draft);
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
    const action = { kind: "spend", provider: "simulated", amountMinor: 1, currency: "EUR" };
    expect(decideAction(store.policies, RUNNING, session, CHECKS, action)).toMatchObject({
      reason: "budget_unknown",
    });
    const free = activate(store, validDraft());
    expect(
      decideAction(
        store.policies,
        RUNNING,
        { ...session, policyRevisionId: free.id },
        CHECKS,
        action,
        spend,
      ),
    ).toMatchObject({ reason: "permission_not_granted", detail: "spend.paid_api_not_authorized" });
  });

  it("refuse toute action hors état running", () => {
    const store = memoryStore();
    const revision = activate(store, draft);
    const decision = decideAction(
      store.policies,
      { state: "ready", emergencyStopLocked: false },
      { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id },
      CHECKS,
      { kind: "file_read", path: "memory/a" },
    );
    expect(decision).toMatchObject({ verdict: "deny", reason: "unknown_condition" });
  });
});

describe("session active face aux restrictions, élargissements et révocations", () => {
  const networkDraft = withFields(validDraft(), {
    "network.explorationDestinations": [{ host: "example.org", ports: [443], purpose: "docs" }],
  });

  it("une restriction s'applique immédiatement et exige l'interruption", () => {
    const store = memoryStore();
    const launched = activate(store, networkDraft);
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    const net = { kind: "network", host: "example.org", port: 443 };
    expect(decideAction(store.policies, RUNNING, session, CHECKS, net).verdict).toBe("allow");

    activate(store, validDraft());
    const assessment = assessActiveSession(store.policies, RUNNING, session, CHECKS);
    expect(assessment).toMatchObject({
      interruptSession: true,
      reason: "permission_not_granted",
      checkpointAllowed: true,
    });
    expect(decideAction(store.policies, RUNNING, session, CHECKS, net)).toMatchObject({
      verdict: "deny",
      reason: "permission_not_granted",
      interruptSession: true,
    });
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, {
        kind: "file_read",
        path: "memory/a",
      }),
    ).toMatchObject({ verdict: "deny", interruptSession: true });
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, { kind: "publish_checkpoint" }),
    ).toMatchObject({ verdict: "allow", interruptSession: true });
  });

  it("un élargissement ne profite pas à la session en cours", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    activate(store, networkDraft);
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    expect(assessActiveSession(store.policies, RUNNING, session, CHECKS).interruptSession).toBe(
      false,
    );
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, {
        kind: "network",
        host: "example.org",
        port: 443,
      }),
    ).toMatchObject({ verdict: "deny", reason: "permission_not_granted", interruptSession: false });
  });

  it("une révocation interrompt la session et interdit même le checkpoint", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    revokePermissions(store, {
      profileId: PROFILE,
      at: ts("2026-10-29T11:00:00Z"),
      reason: "stop",
    });
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, { kind: "publish_checkpoint" }),
    ).toMatchObject({ verdict: "deny", reason: "revoked", interruptSession: true });

    activate(store, validDraft());
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, {
        kind: "file_read",
        path: "memory/a",
      }),
    ).toMatchObject({ verdict: "deny", reason: "revoked", interruptSession: true });
  });

  it("pause et arrêt d'urgence interrompent la session", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    expect(
      assessActiveSession(
        store.policies,
        { state: "paused", emergencyStopLocked: false },
        session,
        CHECKS,
      ),
    ).toMatchObject({ interruptSession: true, reason: "paused" });
    expect(
      decideAction(
        store.policies,
        { state: "running", emergencyStopLocked: true },
        session,
        CHECKS,
        {
          kind: "publish_checkpoint",
        },
      ),
    ).toMatchObject({ verdict: "deny", reason: "stopped", interruptSession: true });
  });

  it("une session liée à une révision inconnue est interrompue", () => {
    const store = memoryStore();
    activate(store, validDraft());
    expect(
      assessActiveSession(
        store.policies,
        RUNNING,
        {
          profileId: PROFILE,
          sessionId: SESSION,
          policyRevisionId: "rev-ghost" as never,
        },
        CHECKS,
      ),
    ).toMatchObject({ interruptSession: true, reason: "unknown_condition" });
  });
});

describe("journalisation des décisions", () => {
  it("produit un événement action_denied avec motif stable et détail", () => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    const action = { kind: "network", host: "example.org", port: 443 };
    const decision = decideAction(
      store.policies,
      RUNNING,
      { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id },
      CHECKS,
      action,
    );
    const event = decisionJournalEvent(decision, {
      profileId: PROFILE,
      at: ts("2026-10-29T10:05:00Z"),
      action,
      sessionId: SESSION,
    });
    expect(event).toEqual({
      type: "action_denied",
      at: "2026-10-29T10:05:00Z",
      profileId: PROFILE,
      sessionId: SESSION,
      policyRevisionId: revision.id,
      reason: "permission_not_granted",
      metadata: {
        kind: "network",
        host: "example.org",
        port: 443,
        verdict: "deny",
        detail: "network.destination_not_granted",
        interruptSession: false,
      },
    });
  });
});

describe("signal de priorité humaine et contrôles revérifiés à chaque action", () => {
  it("refuse le lancement si le signal est plus ancien que maxSignalAgeMs ou l'horloge inconnue", () => {
    const { store } = launchStore();
    const stale = ts("2026-10-29T10:29:29Z"); // 31 s > maxSignalAgeMs (30 s)
    expect(
      decideLaunch(store.policies, PROFILE, {
        ...favorableFacts(),
        userPriority: { favorable: true, observedAt: stale },
      }),
    ).toMatchObject({ reason: "unknown_condition", detail: "user_priority.stale: age_ms=31000" });
    expect(
      decideLaunch(store.policies, PROFILE, {
        ...favorableFacts(),
        userPriority: { favorable: true, observedAt: ts("2026-10-29T11:00:00Z") },
      }),
    ).toMatchObject({ reason: "unknown_condition", detail: "user_priority.unknown" });
    expect(decideLaunch(store.policies, PROFILE, without(favorableFacts(), "now"))).toMatchObject({
      reason: "unknown_condition",
      detail: "clock.unknown",
    });
  });

  const liveMatrix: readonly [string, Partial<SessionChecks>, string, boolean][] = [
    [
      "humain revenu",
      { userPriority: { favorable: false, observedAt: NOW } },
      "user_priority",
      true,
    ],
    [
      "signal trop ancien",
      { userPriority: { favorable: true, observedAt: ts("2026-10-29T10:00:00Z") } },
      "unknown_condition",
      true,
    ],
    ["sandbox hors service", { sandboxOperational: false }, "sandbox_unavailable", false],
    ["horloge invalide", { now: ts("hier") }, "unknown_condition", true],
    [
      "mode abonnement inconnu",
      { onSubscription: "?" as unknown as boolean },
      "unknown_condition",
      true,
    ],
  ];

  it.each(liveMatrix)("interrompt la session : %s", (_name, override, reason, checkpoint) => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
    const checks = { ...CHECKS, ...override };
    expect(assessActiveSession(store.policies, RUNNING, session, checks)).toMatchObject({
      interruptSession: true,
      reason,
      checkpointAllowed: checkpoint,
    });
    expect(
      decideAction(store.policies, RUNNING, session, checks, {
        kind: "file_read",
        path: "memory/a",
      }),
    ).toMatchObject({ verdict: "deny", reason, interruptSession: true });
  });

  it("une pause laisse publier le checkpoint mais aucune autre action", () => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
    const pausing = { state: "paused", emergencyStopLocked: false } as const;
    expect(
      decideAction(store.policies, pausing, session, CHECKS, {
        kind: "file_read",
        path: "memory/a",
      }),
    ).toMatchObject({ verdict: "deny", reason: "paused", interruptSession: true });
    expect(
      decideAction(
        store.policies,
        { state: "checkpointing", emergencyStopLocked: false },
        session,
        { ...CHECKS, userPriority: { favorable: false, observedAt: NOW } },
        { kind: "publish_checkpoint" },
      ),
    ).toMatchObject({ verdict: "allow", interruptSession: true });
  });
});

describe("élargissements partiels ou mixtes et révisions non consenties", () => {
  const wide = withFields(validDraft(), {
    "network.explorationDestinations": [{ host: "example.org", ports: [443], purpose: "docs" }],
  });

  it("une révision mixte consentie en cours de session exige l'interruption", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    // Élargit le réseau mais retire l'écriture.
    activate(store, withFields(wide, { "filesAndTools.writeRoots": [] }));
    expect(assessActiveSession(store.policies, RUNNING, session, CHECKS)).toMatchObject({
      interruptSession: true,
      detail: "policy.restricted_during_session: filesAndTools.writeRoots",
    });
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, {
        kind: "network",
        host: "example.org",
        port: 443,
      }),
    ).toMatchObject({ verdict: "deny", interruptSession: true });
  });

  it("un élargissement partiel non consenti reste sans effet sur les nouvelles sessions", () => {
    const store = memoryStore();
    const active = activate(store, validDraft());
    const proposal = proposeRevision(store, {
      revisionId: revId(700),
      profileId: PROFILE,
      at: NOW,
      draft: withFields(wide, { "budget.tokensPerSession": 5_000 }),
    });
    expect(proposal).toMatchObject({ status: "proposed", change: { kind: "mixed" } });
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: active.id };
    expect(
      decideAction(store.policies, RUNNING, session, CHECKS, {
        kind: "network",
        host: "example.org",
        port: 443,
      }),
    ).toMatchObject({ verdict: "deny", interruptSession: false });
    expect(decideLaunch(store.policies, PROFILE, favorableFacts())).toMatchObject({
      revisionId: active.id,
    });
  });

  it("une révision restrictive non consentie ne réactive rien après révocation", () => {
    const store = memoryStore();
    activate(store, wide);
    revokePermissions(store, { profileId: PROFILE, at: NOW, reason: "demande humaine" });
    const narrower = proposeRevision(store, {
      revisionId: revId(701),
      profileId: PROFILE,
      at: NOW,
      draft: validDraft(),
    });
    expect(narrower.status).toBe("proposed");
    expect(decideLaunch(store.policies, PROFILE, favorableFacts())).toMatchObject({
      verdict: "deny",
      reason: "revoked",
    });
  });
});

describe("voie abonnement expérimentale (ADR-004) : matrice de refus", () => {
  const guard = {
    enabled: true,
    accountRiskAcknowledged: true,
    startBelowBasisPoints: 5_000,
    stopAtBasisPoints: 7_000,
    userReserveBasisPoints: 2_000,
    overshootBoundBasisPoints: 500,
    maxSnapshotAgeMs: 60_000,
    targetUsageBasisPoints: 7_000,
    initialRateBasisPointsPerHour: 1_000,
    pacingMarginRatio: 0.25,
  };
  const snapshot = (used: number, extra: Partial<ProviderQuotaSnapshot> = {}) =>
    ({
      windowKey: "primary",
      windowDurationMs: 18_000_000,
      usedBasisPoints: used,
      resetsAt: ts("2026-10-29T15:00:00Z"),
      observedAt: NOW,
      provenance: "measured",
      ...extra,
    }) satisfies ProviderQuotaSnapshot;
  const quotaCaps = {
    ...capabilities,
    tokenCapEnforcement: "provider_quota_guard",
    providerQuotaReading: "official",
  } as const;
  const subFacts = (overrides: Partial<LaunchFacts> = {}): LaunchFacts => ({
    ...favorableFacts(),
    adapter: { probe, capabilities: quotaCaps, runtime },
    billing: { kind: "subscription_quota" },
    quotaSnapshots: [snapshot(1_000), snapshot(4_000, { windowKey: "weekly" })],
    ...overrides,
  });
  const store = (g: unknown) => {
    const s = memoryStore();
    activate(s, withFields(validDraft(), { "budget.subscriptionQuota": g }));
    return s;
  };

  it("autorise seulement si toutes les conditions tiennent", () => {
    expect(decideLaunch(store(guard).policies, PROFILE, subFacts()).verdict).toBe("allow");
  });

  const matrix: readonly [string, unknown, Partial<LaunchFacts>, string, string][] = [
    ["voie absente", undefined, {}, "permission_not_granted", "subscription.not_enabled"],
    [
      "voie désactivée",
      { enabled: false },
      {},
      "permission_not_granted",
      "subscription.not_enabled",
    ],
    [
      "dépassement non mesuré (null)",
      { ...guard, overshootBoundBasisPoints: null },
      {},
      "bound_not_enforceable",
      "subscription.overshoot_not_measured",
    ],
    [
      "pas de lecture officielle de la jauge",
      guard,
      { adapter: { probe, capabilities: { ...quotaCaps, providerQuotaReading: "none" }, runtime } },
      "bound_not_enforceable",
      "subscription.no_official_quota_reading",
    ],
    [
      "aucune lecture",
      guard,
      { quotaSnapshots: [] },
      "budget_unknown",
      "subscription.quota_unknown",
    ],
    [
      "lecture estimée",
      guard,
      { quotaSnapshots: [snapshot(1_000, { provenance: "estimated" })] },
      "budget_unknown",
      "subscription.snapshot_not_measured",
    ],
    [
      "lecture simulée",
      guard,
      { quotaSnapshots: [snapshot(1_000, { provenance: "simulated" })] },
      "budget_unknown",
      "subscription.snapshot_not_measured",
    ],
    [
      "lecture trop ancienne",
      guard,
      { quotaSnapshots: [snapshot(1_000, { observedAt: ts("2026-10-29T10:28:59Z") })] },
      "budget_unknown",
      "subscription.snapshot_stale",
    ],
    [
      "lecture datée du futur",
      guard,
      { quotaSnapshots: [snapshot(1_000, { observedAt: ts("2026-10-29T10:31:00Z") })] },
      "budget_unknown",
      "subscription.snapshot_stale",
    ],
    [
      "pourcentage hors bornes",
      guard,
      { quotaSnapshots: [snapshot(10_001)] },
      "budget_unknown",
      "subscription.snapshot_invalid",
    ],
    [
      "une fenêtre au seuil de départ",
      guard,
      { quotaSnapshots: [snapshot(1_000), snapshot(5_000, { windowKey: "weekly" })] },
      "budget_exhausted",
      "subscription.start_threshold_reached: weekly",
    ],
    [
      "jauge utilisée hors voie abonnement",
      guard,
      { billing: { kind: "no_charge" } },
      "bound_not_enforceable",
      "adapter.token_cap_not_enforceable",
    ],
    [
      "isolation toujours exigée",
      guard,
      {
        adapter: { probe, capabilities: { ...quotaCaps, isolationCompatible: false }, runtime },
      },
      "sandbox_unavailable",
      "adapter.isolation_incompatible",
    ],
    [
      "priorité humaine toujours exigée",
      guard,
      { userPriority: { favorable: false, observedAt: NOW } },
      "user_priority",
      "user_priority.unfavorable",
    ],
    [
      "budget de sessions toujours exigé",
      guard,
      { budget: { tokens: availability("tokens", 50_000) } },
      "budget_unknown",
      "sessions.availability_unknown",
    ],
    [
      "pilotage : remise à zéro encore loin pour le débit estimé",
      guard,
      { quotaSnapshots: [snapshot(1_000, { resetsAt: ts("2026-10-30T15:00:00Z") })] },
      "outside_window",
      "subscription.pacing_wait: primary",
    ],
    [
      "fenêtre pilotée à la cible",
      guard,
      {
        quotaSnapshots: [
          snapshot(7_000),
          snapshot(1_000, { windowKey: "weekly", resetsAt: ts("2026-11-02T00:00:00Z") }),
        ],
      },
      "budget_exhausted",
      "subscription.target_reached: primary",
    ],
    [
      "remise à zéro déjà passée",
      guard,
      { quotaSnapshots: [snapshot(1_000, { resetsAt: ts("2026-10-29T10:29:00Z") })] },
      "budget_unknown",
      "subscription.snapshot_reset_passed: primary",
    ],
    [
      "remise à zéro illisible",
      guard,
      { quotaSnapshots: [snapshot(1_000, { resetsAt: "demain" as UtcTimestamp })] },
      "budget_unknown",
      "subscription.snapshot_invalid: primary",
    ],
  ];

  it.each(matrix)("refuse : %s", (_name, g, overrides, reason, detail) => {
    const decision = decideLaunch(store(g).policies, PROFILE, subFacts(overrides));
    expect(decision.verdict).toBe("deny");
    if (decision.verdict !== "deny") return;
    expect(decision.reason).toBe(reason);
    expect(decision.detail.startsWith(detail)).toBe(true);
  });

  it("n'exige aucun plafond de tokens propre à Wake quand la garde est active", () => {
    const decision = decideLaunch(
      store(guard).policies,
      PROFILE,
      subFacts({ budget: { sessions: availability("sessions", 2) } }),
    );
    expect(decision).toMatchObject({ verdict: "allow" });
  });

  it("pilotage : réveil quand le temps restant ≤ temps nécessaire × (1 + marge)", () => {
    const policies = store(guard).policies;
    const at = (now: string, estimates?: LaunchFacts["quotaPacing"]): PolicyDecision =>
      decideLaunch(
        policies,
        PROFILE,
        subFacts({
          now: ts(now),
          userPriority: { favorable: true, observedAt: ts(now) },
          quotaSnapshots: [snapshot(1_000, { observedAt: ts(now) })],
          ...(estimates === undefined ? {} : { quotaPacing: estimates }),
        }),
      );
    // Cible 7 000, usage 1 000 : 6 000 bp à 1 000 bp/h (débit initial) = 6 h, × 1,25 =
    // 7 h 30 avant la remise à zéro de 15:00 → réveil à 07:30.
    expect(at("2026-10-29T07:29:59Z")).toMatchObject({
      verdict: "deny",
      reason: "outside_window",
      detail: expect.stringContaining("wake_at=2026-10-29T07:30:00.000Z") as unknown,
    });
    expect(at("2026-10-29T07:30:00Z").verdict).toBe("allow");
    // Débit mesuré deux fois plus rapide : réveil plus tard (11:15).
    const fast = [
      { windowKey: "primary", rateBasisPointsPerHour: 2_000, marginRatio: 0.25, samples: 3 },
    ];
    expect(at("2026-10-29T11:14:00Z", fast).verdict).toBe("deny");
    expect(at("2026-10-29T11:15:00Z", fast).verdict).toBe("allow");
    // Marge augmentée après une fenêtre manquée : réveil plus tôt.
    const wide = [
      { windowKey: "primary", rateBasisPointsPerHour: 2_000, marginRatio: 1, samples: 3 },
    ];
    expect(at("2026-10-29T09:00:00Z", wide).verdict).toBe("allow");
  });

  it("le pilotage passe après la priorité humaine et les fenêtres horaires", () => {
    const policies = store(guard).policies;
    const tooEarly = {
      quotaSnapshots: [snapshot(1_000, { resetsAt: ts("2026-10-30T15:00:00Z") })],
    };
    expect(
      decideLaunch(policies, PROFILE, subFacts({ ...tooEarly, windowOpen: false })),
    ).toMatchObject({ reason: "outside_window", detail: "window.unfavorable" });
    expect(
      decideLaunch(
        policies,
        PROFILE,
        subFacts({ ...tooEarly, userPriority: { favorable: false, observedAt: NOW } }),
      ),
    ).toMatchObject({ reason: "user_priority" });
  });

  it("interrompt la session au seuil d'arrêt, la laisse continuer en dessous", () => {
    const s = memoryStore();
    const revision = activate(s, withFields(validDraft(), { "budget.subscriptionQuota": guard }));
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
    const sub = (used: number): SessionChecks => ({
      ...CHECKS,
      onSubscription: true,
      quotaSnapshots: [snapshot(used)],
    });
    const read = { kind: "file_read", path: "memory/a" };
    expect(decideAction(s.policies, RUNNING, session, sub(6_999), read)).toMatchObject({
      verdict: "allow",
      interruptSession: false,
    });
    expect(decideAction(s.policies, RUNNING, session, sub(7_000), read)).toMatchObject({
      verdict: "deny",
      reason: "budget_exhausted",
      detail: "subscription.target_reached: primary used_bp=7000",
      interruptSession: true,
    });
    expect(
      decideAction(s.policies, RUNNING, session, { ...sub(0), quotaSnapshots: [] }, read),
    ).toMatchObject({ reason: "budget_unknown", interruptSession: true });
  });

  it("interrompt une session sur abonnement si la voie n'est pas activée dans sa révision", () => {
    const s = memoryStore();
    const revision = activate(s, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
    expect(
      assessActiveSession(s.policies, RUNNING, session, {
        ...CHECKS,
        onSubscription: true,
        quotaSnapshots: [snapshot(0)],
      }),
    ).toMatchObject({ interruptSession: true, reason: "permission_not_granted" });
  });

  it("désactiver la voie est une restriction ; relever le seuil d'arrêt un élargissement", () => {
    const base = withFields(validDraft(), { "budget.subscriptionQuota": guard });
    const s = memoryStore();
    const launched = activate(s, base);
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    const raise = proposeRevision(s, {
      revisionId: revId(800),
      profileId: PROFILE,
      at: NOW,
      draft: withFields(base, {
        "budget.subscriptionQuota": { ...guard, stopAtBasisPoints: 7_500 },
      }),
    });
    expect(raise).toMatchObject({
      change: { kind: "widening", widened: ["budget.subscriptionQuota"] },
    });
    activate(s, withFields(base, { "budget.subscriptionQuota": { enabled: false } }));
    expect(assessActiveSession(s.policies, RUNNING, session, CHECKS)).toMatchObject({
      interruptSession: true,
      detail: "policy.restricted_during_session: budget.subscriptionQuota",
    });
  });
});

describe("mode non isolé consenti (ADR-006)", () => {
  const hostDraft = () => withFields(validDraft(), { "runtime.hostUnsandboxedAcknowledged": true });
  const noSandbox = (f: LaunchFacts): LaunchFacts => ({
    ...f,
    sandboxOperational: false,
    adapter: { probe, capabilities: { ...capabilities, isolationCompatible: false }, runtime },
  });

  it("sans consentement : isolation exigée au lancement", () => {
    const { store } = launchStore();
    expect(decideLaunch(store.policies, PROFILE, noSandbox(favorableFacts()))).toMatchObject({
      verdict: "deny",
      reason: "sandbox_unavailable",
    });
  });

  it("avec consentement : lancement sans sandbox, autres conditions toujours vérifiées", () => {
    const { store } = launchStore(hostDraft());
    expect(decideLaunch(store.policies, PROFILE, noSandbox(favorableFacts())).verdict).toBe(
      "allow",
    );
    expect(
      decideLaunch(store.policies, PROFILE, {
        ...noSandbox(favorableFacts()),
        userPriority: { favorable: false, observedAt: NOW },
      }),
    ).toMatchObject({ verdict: "deny", reason: "user_priority" });
    expect(
      decideLaunch(store.policies, PROFILE, { ...noSandbox(favorableFacts()), windowOpen: false }),
    ).toMatchObject({ verdict: "deny", reason: "outside_window" });
  });

  it("en session : sandbox non exigée avec consentement, exigée sinon", () => {
    for (const [draft, expected] of [
      [hostDraft(), false],
      [validDraft(), true],
    ] as const) {
      const s = memoryStore();
      const revision = activate(s, draft);
      const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: revision.id };
      expect(
        assessActiveSession(s.policies, RUNNING, session, {
          ...CHECKS,
          sandboxOperational: false,
        }).interruptSession,
      ).toBe(expected);
    }
  });

  it("accorder le mode non isolé élargit (nouveau consentement), le retirer restreint", () => {
    const s = memoryStore();
    activate(s, validDraft());
    const widened = proposeRevision(s, {
      revisionId: revId(900),
      profileId: PROFILE,
      at: NOW,
      draft: hostDraft(),
    });
    expect(widened).toMatchObject({
      change: { kind: "widening", widened: ["runtime.hostUnsandboxedAcknowledged"] },
    });
  });
});
