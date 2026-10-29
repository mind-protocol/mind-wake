import { describe, expect, it } from "vitest";
import type { AdapterCapabilities, ProbeResult } from "../contracts/adapter.js";
import type { BudgetAvailability } from "../contracts/budget.js";
import type { AdapterId, BudgetPeriodId } from "../contracts/common.js";
import type { RuntimeGroup } from "../contracts/policy.js";
import {
  PROFILE,
  SESSION,
  activate,
  memoryStore,
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
} from "./decide.js";
import { revokePermissions } from "./revisions.js";

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
    userPriorityFavorable: true,
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
      (f) => ({ ...f, userPriorityFavorable: false }),
      "user_priority",
      "user_priority.unfavorable",
    ],
    [
      "signal humain inconnu",
      (f) => without(f, "userPriorityFavorable"),
      "unknown_condition",
      "user_priority.unknown",
    ],
    [
      "signal non booléen",
      (f) => ({ ...f, userPriorityFavorable: "yes" as unknown as boolean }),
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
    expect(decideAction(store.policies, RUNNING, session, action)).toMatchObject({
      reason: "budget_unknown",
    });
    const free = activate(store, validDraft());
    expect(
      decideAction(
        store.policies,
        RUNNING,
        { ...session, policyRevisionId: free.id },
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
    expect(decideAction(store.policies, RUNNING, session, net).verdict).toBe("allow");

    activate(store, validDraft());
    const assessment = assessActiveSession(store.policies, RUNNING, session);
    expect(assessment).toMatchObject({
      interruptSession: true,
      reason: "permission_not_granted",
      checkpointAllowed: true,
    });
    expect(decideAction(store.policies, RUNNING, session, net)).toMatchObject({
      verdict: "deny",
      reason: "permission_not_granted",
      interruptSession: true,
    });
    expect(
      decideAction(store.policies, RUNNING, session, { kind: "file_read", path: "memory/a" }),
    ).toMatchObject({ verdict: "deny", interruptSession: true });
    expect(
      decideAction(store.policies, RUNNING, session, { kind: "publish_checkpoint" }),
    ).toMatchObject({ verdict: "allow", interruptSession: true });
  });

  it("un élargissement ne profite pas à la session en cours", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    activate(store, networkDraft);
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    expect(assessActiveSession(store.policies, RUNNING, session).interruptSession).toBe(false);
    expect(
      decideAction(store.policies, RUNNING, session, {
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
      decideAction(store.policies, RUNNING, session, { kind: "publish_checkpoint" }),
    ).toMatchObject({ verdict: "deny", reason: "revoked", interruptSession: true });

    activate(store, validDraft());
    expect(
      decideAction(store.policies, RUNNING, session, { kind: "file_read", path: "memory/a" }),
    ).toMatchObject({ verdict: "deny", reason: "revoked", interruptSession: true });
  });

  it("pause et arrêt d'urgence interrompent la session", () => {
    const store = memoryStore();
    const launched = activate(store, validDraft());
    const session = { profileId: PROFILE, sessionId: SESSION, policyRevisionId: launched.id };
    expect(
      assessActiveSession(store.policies, { state: "paused", emergencyStopLocked: false }, session),
    ).toMatchObject({ interruptSession: true, reason: "paused" });
    expect(
      decideAction(store.policies, { state: "running", emergencyStopLocked: true }, session, {
        kind: "publish_checkpoint",
      }),
    ).toMatchObject({ verdict: "deny", reason: "stopped", interruptSession: true });
  });

  it("une session liée à une révision inconnue est interrompue", () => {
    const store = memoryStore();
    activate(store, validDraft());
    expect(
      assessActiveSession(store.policies, RUNNING, {
        profileId: PROFILE,
        sessionId: SESSION,
        policyRevisionId: "rev-ghost" as never,
      }),
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
