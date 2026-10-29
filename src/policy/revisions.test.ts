import { describe, expect, it } from "vitest";
import type { PolicyRevision } from "../contracts/policy.js";
import {
  PROFILE,
  activate,
  consentId,
  memoryStore,
  revId,
  ts,
  validDraft,
  withFields,
} from "../../test/support/policy-fixtures.js";
import { classifyChange } from "./change.js";
import { decideActivation } from "./decide.js";
import {
  grantConsent,
  openTrustedUserChannel,
  proposeRevision,
  resolvePolicy,
  revisionDigest,
  revokePermissions,
} from "./revisions.js";
import { validateDraft } from "./validate.js";

const AT = ts("2026-10-29T10:00:00Z");

function groupsOf(draft: unknown) {
  const result = validateDraft(draft, PROFILE);
  if (!result.ok) throw new Error("brouillon invalide");
  return result.groups;
}

describe("révisions et consentement", () => {
  it("une proposition sans consentement n'est pas applicable", () => {
    const store = memoryStore();
    const proposed = proposeRevision(store, {
      revisionId: revId(1),
      profileId: PROFILE,
      at: AT,
      draft: validDraft(),
    });
    expect(proposed.status).toBe("proposed");
    expect(resolvePolicy(store.policies, PROFILE).status).toBe("none");
    expect(decideActivation(store.policies, PROFILE)).toMatchObject({
      verdict: "deny",
      reason: "not_consented",
    });
  });

  it("un brouillon incomplet ne crée aucune révision", () => {
    const store = memoryStore();
    const proposed = proposeRevision(store, {
      revisionId: revId(1),
      profileId: PROFILE,
      at: AT,
      draft: withFields(validDraft(), { "budget.tokensPerSession": undefined }),
    });
    expect(proposed.status).toBe("rejected");
    expect(store.policies.revisions).toHaveLength(0);
    expect(decideActivation(store.policies, PROFILE).verdict).toBe("deny");
  });

  it("le consentement du canal de confiance rend la révision applicable et est journalisé", () => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    const resolution = resolvePolicy(store.policies, PROFILE);
    expect(resolution.status).toBe("active");
    expect(decideActivation(store.policies, PROFILE)).toMatchObject({
      verdict: "allow",
      revisionId: revision.id,
    });
    expect(store.journal.events.map((e) => e.type)).toEqual([
      "policy_revision_created",
      "consent_granted",
    ]);
  });

  it("une révision est gelée et son identifiant ne peut pas être réutilisé", () => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    expect(Object.isFrozen(revision)).toBe(true);
    expect(() => {
      (revision.groups.budget as { tokensPerSession: number }).tokensPerSession = 1e9;
    }).toThrow();
    const again = proposeRevision(store, {
      revisionId: revision.id,
      profileId: PROFILE,
      at: AT,
      draft: validDraft(),
    });
    expect(again.status).toBe("rejected");
  });

  const refusals: readonly [string, (r: PolicyRevision, digest: string) => unknown, object][] = [
    ["jeton forgé (JSON)", () => JSON.parse('{"channel":"local_cli"}') as unknown, {}],
    ["aucun jeton", () => null, {}],
    ["chaîne « local_cli »", () => "local_cli", {}],
  ];

  it.each(refusals)("refuse le consentement : %s", (_name, channel) => {
    const store = memoryStore();
    const proposed = proposeRevision(store, {
      revisionId: revId(1),
      profileId: PROFILE,
      at: AT,
      draft: validDraft(),
    });
    if (proposed.status !== "proposed") throw new Error();
    const result = grantConsent(store, channel(proposed.revision, proposed.digest), {
      consentId: consentId(1),
      revisionId: proposed.revision.id,
      profileId: PROFILE,
      at: AT,
      confirmedDigest: proposed.digest,
      proof: "le modèle déclare que l'humain est d'accord",
    });
    expect(result).toEqual({ status: "refused", reason: "untrusted_channel" });
    expect(resolvePolicy(store.policies, PROFILE).status).toBe("none");
    expect(store.journal.events.at(-1)).toMatchObject({ type: "action_denied" });
  });

  it("refuse un consentement dont l'empreinte ne correspond pas au contenu affiché", () => {
    const store = memoryStore();
    const proposed = proposeRevision(store, {
      revisionId: revId(1),
      profileId: PROFILE,
      at: AT,
      draft: validDraft(),
    });
    if (proposed.status !== "proposed") throw new Error();
    const result = grantConsent(store, openTrustedUserChannel(), {
      consentId: consentId(1),
      revisionId: proposed.revision.id,
      profileId: PROFILE,
      at: AT,
      confirmedDigest: "0".repeat(64),
      proof: "ok",
    });
    expect(result).toEqual({ status: "refused", reason: "digest_mismatch" });
  });

  it("refuse un consentement en double et une preuve vide", () => {
    const store = memoryStore();
    const revision = activate(store, validDraft());
    const input = {
      consentId: consentId(9),
      revisionId: revision.id,
      profileId: PROFILE,
      at: AT,
      confirmedDigest: revisionDigest(revision),
      proof: "ok",
    };
    expect(grantConsent(store, openTrustedUserChannel(), input)).toMatchObject({
      reason: "already_consented",
    });

    const proposed = proposeRevision(store, {
      revisionId: revId(2),
      profileId: PROFILE,
      at: AT,
      draft: validDraft(),
    });
    if (proposed.status !== "proposed") throw new Error();
    expect(
      grantConsent(store, openTrustedUserChannel(), {
        ...input,
        revisionId: proposed.revision.id,
        confirmedDigest: proposed.digest,
        proof: "   ",
      }),
    ).toMatchObject({ reason: "invalid_proof" });
  });

  it("refuse une proposition périmée qui annulerait une restriction intervenue entre-temps", () => {
    const store = memoryStore();
    activate(store, validDraft());
    const widening = proposeRevision(store, {
      revisionId: revId(50),
      profileId: PROFILE,
      at: AT,
      draft: withFields(validDraft(), { "budget.tokensPerSession": 20_000 }),
    });
    if (widening.status !== "proposed") throw new Error();
    expect(widening.change.kind).toBe("widening");

    const restriction = activate(
      store,
      withFields(validDraft(), { "budget.tokensPerSession": 5_000 }),
    );
    const late = grantConsent(store, openTrustedUserChannel(), {
      consentId: consentId(50),
      revisionId: widening.revision.id,
      profileId: PROFILE,
      at: AT,
      confirmedDigest: widening.digest,
      proof: "ok",
    });
    expect(late).toEqual({ status: "refused", reason: "stale_proposal" });
    const resolution = resolvePolicy(store.policies, PROFILE);
    expect(resolution.status === "active" && resolution.revision.id).toBe(restriction.id);
  });

  it("une révocation bloque tout et ne ressuscite pas une révision antérieure", () => {
    const store = memoryStore();
    activate(store, validDraft());
    const narrow = activate(store, withFields(validDraft(), { "filesAndTools.writeRoots": [] }));
    const revoked = revokePermissions(store, {
      profileId: PROFILE,
      at: AT,
      reason: "demande humaine",
    });
    expect(revoked.status).toBe("revoked");
    expect(decideActivation(store.policies, PROFILE)).toMatchObject({
      verdict: "deny",
      reason: "revoked",
      revisionId: narrow.id,
    });
    const restored = activate(store, validDraft());
    expect(decideActivation(store.policies, PROFILE)).toMatchObject({
      verdict: "allow",
      revisionId: restored.id,
    });
  });

  it("une chaîne de révisions altérée rend la policy invalide", () => {
    const store = memoryStore();
    activate(store, validDraft());
    store.policies.revisions.push({
      ...store.policies.revisions[0],
      id: revId(999),
      previousRevisionId: revId(12345),
    } as PolicyRevision);
    expect(decideActivation(store.policies, PROFILE)).toMatchObject({
      verdict: "deny",
      reason: "missing_limit",
      detail: "policy.chain_integrity",
    });
  });
});

describe("classement des changements", () => {
  const base = groupsOf(validDraft());
  const cases: readonly [string, Record<string, unknown>, string, string[], string[]][] = [
    ["identique", {}, "unchanged", [], []],
    [
      "moins de tokens",
      { "budget.tokensPerSession": 5_000 },
      "restriction",
      [],
      ["budget.tokensPerSession"],
    ],
    [
      "plus de tokens",
      { "budget.tokensPerSession": 20_000 },
      "widening",
      ["budget.tokensPerSession"],
      [],
    ],
    [
      "réserve accrue",
      { "budget.userReserveTokens": 8_000 },
      "restriction",
      [],
      ["budget.userReserveTokens"],
    ],
    [
      "écriture retirée",
      { "filesAndTools.writeRoots": [] },
      "restriction",
      [],
      ["filesAndTools.writeRoots"],
    ],
    [
      "réseau ajouté",
      {
        "network.explorationDestinations": [{ host: "example.org", ports: [443], purpose: "doc" }],
      },
      "widening",
      ["network.explorationDestinations"],
      [],
    ],
    ["modèle changé", { "runtime.model": "sim-2" }, "widening", ["runtime.model"], []],
    [
      "fenêtre raccourcie",
      { "schedule.weeklyWindows": [{ day: 1, start: "09:00", end: "10:00" }] },
      "restriction",
      [],
      ["schedule.weeklyWindows"],
    ],
    [
      "fenêtre déplacée",
      { "schedule.weeklyWindows": [{ day: 2, start: "09:00", end: "12:00" }] },
      "mixed",
      ["schedule.weeklyWindows"],
      ["schedule.weeklyWindows"],
    ],
    [
      "dépense autorisée",
      {
        "budget.paidApi": {
          authorized: true,
          provider: "p",
          currency: "EUR",
          perSessionCapMinor: 10,
          perPeriodCapMinor: 100,
        },
      },
      "widening",
      ["budget.paidApi"],
      [],
    ],
  ];

  it.each(cases)("%s", (_name, changes, kind, widened, restricted) => {
    const after = groupsOf(withFields(validDraft(), changes));
    expect(classifyChange(base, after)).toEqual({ kind, widened, restricted });
  });

  it("une première révision est initiale", () => {
    expect(classifyChange(null, base).kind).toBe("initial");
  });
});
