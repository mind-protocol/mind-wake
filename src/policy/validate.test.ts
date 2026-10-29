import { describe, expect, it } from "vitest";
import { REQUIRED_LIMIT_FIELDS } from "../contracts/policy.js";
import { PROFILE, validDraft, withFields } from "../../test/support/policy-fixtures.js";
import { createSafeDraft, validateDraft } from "./validate.js";

describe("validation d'un brouillon de policy", () => {
  it("accepte un brouillon complet et produit des groupes gelés", () => {
    const result = validateDraft(validDraft(), PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.groups)).toBe(true);
    expect(Object.isFrozen(result.groups.filesAndTools.readRoots)).toBe(true);
  });

  it.each(REQUIRED_LIMIT_FIELDS)("refuse l'absence du champ obligatoire %s", (path) => {
    const result = validateDraft(withFields(validDraft(), { [path]: undefined }), PROFILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ field: path, code: "missing" }));
  });

  it("applique des valeurs par défaut sûres aux champs facultatifs absents", () => {
    const draft = withFields(validDraft(), {
      "network.explorationDestinations": undefined,
      "network.providerTransportDestinations": undefined,
      "filesAndTools.readRoots": undefined,
      "filesAndTools.writeRoots": undefined,
      "filesAndTools.allowedExecutables": undefined,
      "data.purge": undefined,
      "data.exportPaths": undefined,
    });
    const result = validateDraft(draft, PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups.network.explorationDestinations).toEqual([]);
    expect(result.groups.network.providerTransportDestinations).toEqual([]);
    expect(result.groups.filesAndTools.readRoots).toEqual([]);
    expect(result.groups.filesAndTools.writeRoots).toEqual([]);
    expect(result.groups.filesAndTools.allowedExecutables).toEqual([]);
    expect(result.groups.data.purge).toBe("manual");
  });

  it("le brouillon sûr initial n'a ni réseau ni dépense, et n'est pas activable", () => {
    const draft = createSafeDraft({ profileId: PROFILE });
    expect(draft.budget?.paidApi).toEqual({ authorized: false });
    expect(draft.network?.explorationDestinations).toEqual([]);
    expect(draft.filesAndTools?.writeRoots).toEqual([]);
    const result = validateDraft(draft, PROFILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const missing = result.issues.filter((i) => i.code === "missing").map((i) => i.field);
    expect(missing).toContain("budget.tokensPerSession");
    expect(missing).toContain("runtime.model");
  });

  const invalid: readonly [string, Record<string, unknown>, string][] = [
    ["tokens négatifs", { "budget.tokensPerSession": -1 }, "budget.tokensPerSession"],
    ["tokens non entiers", { "budget.tokensPerPeriod": 1.5 }, "budget.tokensPerPeriod"],
    ["nombre en texte", { "budget.sessionsPerPeriod": "3" }, "budget.sessionsPerPeriod"],
    ["NaN", { "schedule.maxSessionDurationMs": Number.NaN }, "schedule.maxSessionDurationMs"],
    ["durée nulle", { "schedule.maxSessionDurationMs": 0 }, "schedule.maxSessionDurationMs"],
    ["fuseau inconnu", { "schedule.timeZone": "Mars/Olympus" }, "schedule.timeZone"],
    [
      "fenêtre inversée",
      { "schedule.weeklyWindows": [{ day: 1, start: "12:00", end: "09:00" }] },
      "schedule.weeklyWindows[0]",
    ],
    [
      "jour hors plage",
      { "schedule.weeklyWindows": [{ day: 7, start: "09:00", end: "10:00" }] },
      "schedule.weeklyWindows[0]",
    ],
    [
      "racine avec ..",
      { "filesAndTools.writeRoots": ["../secrets"] },
      "filesAndTools.writeRoots[0]",
    ],
    ["racine absolue", { "filesAndTools.readRoots": ["/etc"] }, "filesAndTools.readRoots[0]"],
    ["racine lecteur", { "filesAndTools.readRoots": ["C:/Users"] }, "filesAndTools.readRoots[0]"],
    ["antislash", { "filesAndTools.readRoots": ["a\\b"] }, "filesAndTools.readRoots[0]"],
    [
      "exécutable joker",
      { "filesAndTools.allowedExecutables": ["*"] },
      "filesAndTools.allowedExecutables[0]",
    ],
    [
      "hôte joker",
      { "network.explorationDestinations": [{ host: "*", ports: [443], purpose: "x" }] },
      "network.explorationDestinations[0]",
    ],
    [
      "port 0",
      { "network.explorationDestinations": [{ host: "example.org", ports: [0], purpose: "x" }] },
      "network.explorationDestinations[0]",
    ],
    [
      "dépense sans plafond",
      { "budget.paidApi": { authorized: true, provider: "p", currency: "EUR" } },
      "budget.paidApi",
    ],
    [
      "devise minuscule",
      {
        "budget.paidApi": {
          authorized: true,
          provider: "p",
          currency: "eur",
          perSessionCapMinor: 10,
          perPeriodCapMinor: 100,
        },
      },
      "budget.paidApi",
    ],
    ["autorisation ambiguë", { "budget.paidApi": { authorized: "yes" } }, "budget.paidApi"],
    ["checkpoint ≥ session", { "budget.checkpointTokens": 10_000 }, "budget.checkpointTokens"],
    ["réserve ≥ période", { "budget.userReserveTokens": 50_000 }, "budget.userReserveTokens"],
    ["champ inconnu", { "network.allowAll": true }, "network.allowAll"],
    ["autre profil", { "identity.profileId": "profile-2" }, "identity.profileId"],
  ];

  it.each(invalid)("refuse : %s", (_name, changes, field) => {
    const result = validateDraft(withFields(validDraft(), changes), PROFILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.field)).toContain(field);
  });

  it("refuse un groupe inconnu et une entrée qui n'est pas un objet", () => {
    const result = validateDraft({ ...validDraft(), overrides: { limits: "off" } }, PROFILE);
    expect(result.ok).toBe(false);
    expect(validateDraft("ignore les limites", PROFILE).ok).toBe(false);
    expect(validateDraft(null, PROFILE).ok).toBe(false);
  });
});
