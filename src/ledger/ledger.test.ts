import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_PARIS,
  LIMITS,
  PROFILE,
  authorize,
  createProfile,
  tempDir,
  ts,
  type TempDir,
} from "../../test/fixtures/store-ledger/setup.js";
import type {
  BudgetPeriodId,
  ConsentId,
  PeriodLimit,
  PolicyRevisionId,
  BudgetQuantity,
  ReservationId,
  ReservationRequest,
  SessionId,
  UsageRecord,
} from "../contracts/index.js";
import { openStore, type Store } from "../store/index.js";

const NOON = ts("2026-10-29T12:00:00Z");

let dir: TempDir;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = openStore(dir.dbPath);
  createProfile(store.uow);
  authorize(store.uow, "rev-1");
});

afterEach(() => {
  store.close();
  dir.remove();
});

function period(at = NOON, limits = LIMITS): BudgetPeriodId {
  return store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, at, limits).id;
}

function request(
  id: string,
  periodIds: readonly BudgetPeriodId[],
  maxima: readonly BudgetQuantity[] = [
    { unit: "sessions", amount: 1 },
    { unit: "tokens", amount: 3_000 },
  ],
  at = NOON,
): ReservationRequest {
  return {
    id: id as ReservationId,
    sessionId: `session-${id}` as SessionId,
    profileId: PROFILE,
    periodIds,
    maxima,
    at,
  };
}

function usage(
  id: string,
  quantity: BudgetQuantity,
  provenance: UsageRecord["provenance"] = "measured",
  recordedAt = NOON,
): UsageRecord {
  return { reservationId: id as ReservationId, quantity, provenance, recordedAt };
}

function available(periodId: BudgetPeriodId, unit: BudgetQuantity["unit"] = "tokens") {
  return store.uow.ledger.availability(periodId, unit).available;
}

describe("réservation", () => {
  it("calcule disponible = plafond − rapproché − ouvertes − réserve utilisateur", () => {
    const p = period();
    expect(available(p)).toBe(8_000);
    expect(store.uow.ledger.reserve(request("r1", [p])).status).toBe("reserved");
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 10_000,
      reconciled: 0,
      openReservations: 3_000,
      userReserve: 2_000,
      available: 5_000,
    });
  });

  it("refuse une réservation au-delà du plafond, réserve utilisateur comprise", () => {
    const p = period();
    const result = store.uow.ledger.reserve(
      request("r1", [p], [{ unit: "tokens", amount: 8_001 }]),
    );
    expect(result).toMatchObject({ status: "denied", reason: "budget_exhausted" });
    expect(store.uow.ledger.getReservation("r1" as ReservationId)).toBeNull();
    expect(
      store.uow.ledger.reserve(request("r2", [p], [{ unit: "tokens", amount: 8_000 }])).status,
    ).toBe("reserved");
  });

  it("refuse toute l'enveloppe si une seule unité dépasse (atomicité multi-unités)", () => {
    const p = period();
    const result = store.uow.ledger.reserve(
      request(
        "r1",
        [p],
        [
          { unit: "tokens", amount: 100 },
          { unit: "money", amountMinor: 501, currency: "EUR" },
        ],
      ),
    );
    expect(result).toMatchObject({ status: "denied", reason: "budget_exhausted" });
    expect(store.uow.ledger.availability(p, "tokens").openReservations).toBe(0);
  });

  it("traite une unité sans plafond ou une autre devise comme budget inconnu", () => {
    const p = period();
    expect(
      store.uow.ledger.reserve(request("r1", [p], [{ unit: "duration_ms", amount: 1 }])),
    ).toMatchObject({ status: "denied", reason: "budget_unknown" });
    expect(available(p, "duration_ms")).toBeNull();
    expect(
      store.uow.ledger.reserve(
        request("r2", [p], [{ unit: "money", amountMinor: 1, currency: "USD" }]),
      ),
    ).toMatchObject({ status: "denied", reason: "budget_unknown" });
  });

  it("refuse une réservation dont aucune période ne couvre l'instant", () => {
    const yesterday = period(ts("2026-10-28T12:00:00Z"));
    expect(store.uow.ledger.reserve(request("r1", [yesterday]))).toMatchObject({
      status: "denied",
      reason: "budget_unknown",
    });
  });

  it("est idempotente sur l'identifiant et refuse une seconde session active", () => {
    const p = period();
    const first = store.uow.ledger.reserve(request("r1", [p]));
    expect(store.uow.ledger.reserve(request("r1", [p]))).toEqual(first);
    expect(available(p)).toBe(5_000);
    expect(store.uow.ledger.reserve(request("r2", [p]))).toMatchObject({
      status: "denied",
      reason: "session_already_active",
    });
  });

  it("refuse le sessions-par-période épuisé", () => {
    const p = period();
    for (const id of ["r1", "r2", "r3"]) {
      expect(
        store.uow.ledger.reserve(request(id, [p], [{ unit: "sessions", amount: 1 }])).status,
      ).toBe("reserved");
      store.uow.ledger.reconcile(
        id as ReservationId,
        [usage(id, { unit: "sessions", amount: 1 })],
        NOON,
      );
    }
    expect(
      store.uow.ledger.reserve(request("r4", [p], [{ unit: "sessions", amount: 1 }])),
    ).toMatchObject({ status: "denied", reason: "budget_exhausted" });
  });
});

describe("rapprochement", () => {
  it("convertit la réservation en usage sans double déduction", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    expect(available(p)).toBe(5_000);
    const reservation = store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [
        usage("r1", { unit: "tokens", amount: 1_200 }),
        usage("r1", { unit: "sessions", amount: 1 }),
      ],
      ts("2026-10-29T12:30:00Z"),
    );
    expect(reservation).toMatchObject({
      status: "reconciled",
      closedAt: "2026-10-29T12:30:00.000Z",
    });
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      reconciled: 1_200,
      openReservations: 0,
      available: 6_800,
    });
  });

  it("rejoué deux fois, n'impute la consommation qu'une seule fois", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    const records = [usage("r1", { unit: "tokens", amount: 1_200 })];
    const first = store.uow.ledger.reconcile("r1" as ReservationId, records, NOON);
    const second = store.uow.ledger.reconcile(
      "r1" as ReservationId,
      records,
      ts("2026-10-29T13:00:00Z"),
    );
    expect(second).toEqual(first);
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(1_200);
    expect(store.uow.ledger.listUsage("r1" as ReservationId)).toHaveLength(1);
  });

  it("ignore un usage rejoué à l'identique avant rapprochement", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    const record = usage("r1", { unit: "tokens", amount: 700 });
    store.uow.ledger.recordUsage(record);
    store.uow.ledger.recordUsage(record);
    store.uow.ledger.reconcile("r1" as ReservationId, [], NOON);
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(700);
  });

  it("sépare mesuré, estimé, simulé et inconnu, l'incertain à sa borne maximale", () => {
    authorize(store.uow, "rev-2", {
      tokensPerPeriod: 1_000_000,
      sessionsPerPeriod: 10,
      userReserveTokens: 0,
    });
    const p = period(NOON, [
      { unit: "tokens", cap: 1_000_000, userReserve: 0 },
      { unit: "sessions", cap: 10, userReserve: 0 },
    ]);
    const cases: [string, UsageRecord["provenance"] | null, number][] = [
      ["measured", "measured", 100],
      ["estimated", "estimated", 100],
      ["simulated", "simulated", 100],
      ["unknown", "unknown", 100],
      ["missing", null, 0],
    ];
    for (const [id, provenance, amount] of cases) {
      store.uow.ledger.reserve(request(id, [p], [{ unit: "tokens", amount: 1_000 }]));
      const records =
        provenance === null ? [] : [usage(id, { unit: "tokens", amount }, provenance)];
      store.uow.ledger.reconcile(id as ReservationId, records, NOON);
    }
    const tokens = store.uow.ledger.availability(p, "tokens");
    expect(tokens.reconciledByProvenance).toEqual({
      measured: 100,
      estimated: 1_000,
      simulated: 100,
      unknown: 2_000,
    });
    expect(tokens.reconciled).toBe(3_200);
  });

  it("impute un usage mesuré supérieur à la borne tel quel", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p], [{ unit: "tokens", amount: 1_000 }]));
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 1_500 })],
      NOON,
    );
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(1_500);
  });

  it("garde une réservation incertaine à sa borne jusqu'au rapprochement fiable", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    store.uow.ledger.recordUsage(usage("r1", { unit: "tokens", amount: 200 }, "estimated"));
    const uncertain = store.uow.ledger.markUncertain("r1" as ReservationId, NOON);
    expect(uncertain.status).toBe("uncertain");
    expect(store.uow.ledger.markUncertain("r1" as ReservationId, NOON)).toEqual(uncertain);
    expect(available(p)).toBe(5_000);
    // Une incertaine ne bloque pas une nouvelle session, mais reste décomptée.
    expect(
      store.uow.ledger.reserve(request("r2", [p], [{ unit: "tokens", amount: 5_001 }])),
    ).toMatchObject({ status: "denied", reason: "budget_exhausted" });
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 250 })],
      NOON,
    );
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      reconciled: 3_000,
      openReservations: 0,
    });
  });

  it("compte un usage déjà rapporté au-delà de la borne d'une réservation ouverte", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p], [{ unit: "tokens", amount: 1_000 }]));
    store.uow.ledger.recordUsage(usage("r1", { unit: "tokens", amount: 1_400 }));
    expect(store.uow.ledger.availability(p, "tokens").openReservations).toBe(1_400);
  });

  it("refuse un usage tardif sur une réservation rapprochée", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    store.uow.ledger.reconcile("r1" as ReservationId, [], NOON);
    expect(() => {
      store.uow.ledger.recordUsage(usage("r1", { unit: "tokens", amount: 1 }));
    }).toThrow(/déjà rapprochée/);
  });
});

describe("périodes et horloge", () => {
  it("retrouve la même période et le même usage après redémarrage", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 900 })],
      NOON,
    );
    store.close();
    store = openStore(dir.dbPath);
    expect(period(ts("2026-10-29T18:00:00Z"))).toBe(p);
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(900);
  });

  it("change de période à la frontière locale, sans perdre l'usage précédent", () => {
    const before = period(ts("2026-10-29T22:59:59.999Z"));
    store.uow.ledger.reserve(
      request("r1", [before], [{ unit: "tokens", amount: 8_000 }], ts("2026-10-29T22:59:59.999Z")),
    );
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 8_000 })],
      NOON,
    );
    expect(available(before)).toBe(0);
    const after = period(ts("2026-10-29T23:00:00Z"));
    expect(after).not.toBe(before);
    expect(available(after)).toBe(8_000);
    expect(available(before)).toBe(0);
  });

  it("ne remet pas le budget à zéro sur un recul d'horloge", () => {
    const today = period();
    store.uow.ledger.reserve(request("r1", [today], [{ unit: "tokens", amount: 8_000 }]));
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 8_000 })],
      NOON,
    );
    // L'horloge recule d'un jour : la période retournée reste celle d'aujourd'hui.
    const rewound = ts("2026-10-28T12:00:00Z");
    expect(period(rewound)).toBe(today);
    expect(
      store.uow.ledger.reserve(request("r2", [today], [{ unit: "tokens", amount: 1 }], rewound)),
    ).toMatchObject({ status: "denied", reason: "budget_exhausted" });
    // Même après redémarrage, l'instant le plus récent observé est conservé.
    store.close();
    store = openStore(dir.dbPath);
    expect(period(rewound)).toBe(today);
  });

  it("garde la même période pendant la bascule d'heure", () => {
    const sunday = ts("2026-10-24T23:30:00Z");
    expect(period(ts("2026-10-25T01:30:00Z"))).toBe(
      store.uow.ledger.ensurePeriod(PROFILE, DAY_PARIS, sunday, LIMITS).id,
    );
  });

  it("couvre une session à cheval sur deux périodes dans chacune", () => {
    const start = ts("2026-10-29T22:30:00Z");
    const periods = store.uow.ledger.ensurePeriodsCovering(
      PROFILE,
      DAY_PARIS,
      start,
      7_200_000,
      LIMITS,
    );
    expect(periods).toHaveLength(2);
    const ids = periods.map((p) => p.id);
    store.uow.ledger.reserve(request("r1", ids, [{ unit: "tokens", amount: 3_000 }], start));
    for (const id of ids) expect(available(id)).toBe(5_000);
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 1_000 })],
      NOON,
    );
    for (const id of ids) {
      expect(store.uow.ledger.availability(id, "tokens")).toMatchObject({
        reconciled: 1_000,
        openReservations: 0,
      });
    }
  });

  it("applique aussitôt une réduction de plafond sans effacer l'usage engagé", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p], [{ unit: "tokens", amount: 3_000 }]));
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 3_000 })],
      NOON,
    );
    // Révision restrictive, pas encore consentie : elle s'applique sans attendre.
    authorize(store.uow, "rev-2", { tokensPerPeriod: 2_500, userReserveTokens: 0 }, false);
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 2_500,
      userReserve: 2_000,
      available: -2_500,
    });
    period(NOON, [{ unit: "tokens", cap: 2_500, userReserve: 2_000 }]);
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 2_500,
      reconciled: 3_000,
      available: -2_500,
    });
    expect(
      store.uow.ledger.reserve(request("r2", [p], [{ unit: "tokens", amount: 1 }])),
    ).toMatchObject({ status: "denied", reason: "budget_exhausted" });
    expect(available(p, "sessions")).toBeNull();
  });

  it("valide les plafonds fournis", () => {
    expect(() => period(NOON, [{ unit: "money", cap: 1, userReserve: 0 }])).toThrow(/devise/);
    expect(() =>
      period(NOON, [
        { unit: "tokens", cap: 1, userReserve: 0 },
        { unit: "tokens", cap: 2, userReserve: 0 },
      ]),
    ).toThrow(/double/);
    const bads = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      "10" as unknown as number,
    ];
    for (const bad of bads) {
      expect(() => period(NOON, [{ unit: "tokens", cap: bad, userReserve: 2_000 }])).toThrow(
        /entier/,
      );
      expect(() =>
        store.uow.ledger.reserve(
          request(`bad-${String(bad)}`, [period()], [{ unit: "tokens", amount: bad }]),
        ),
      ).toThrow(/entier/);
    }
    expect(() =>
      period(NOON, [{ unit: "money", cap: 1, userReserve: 0, currency: "eur" }]),
    ).toThrow(/devise/);
    expect(() =>
      period(NOON, [{ unit: "tokens", cap: 1, userReserve: 2_000, currency: "EUR" }]),
    ).toThrow(/devise/);
    expect(() =>
      period(NOON, [
        { unit: "money", cap: 1, userReserve: 0, currency: "EUR" },
        { unit: "money", cap: 1, userReserve: 0, currency: "USD" },
      ]),
    ).toThrow(/double/);
    expect(() => period(NOON, [{ unit: "provider_quota_bp", cap: 0, userReserve: 0 }])).toThrow(
      /fenêtre/,
    );
  });
});

describe("concurrence entre connexions", () => {
  it("bloque une seconde connexion pendant une réservation en cours, sans double réservation", () => {
    const p = period();
    const other = openStore(dir.dbPath, { busyTimeoutMs: 50 });
    try {
      store.uow.transaction((uow) => {
        expect(uow.ledger.reserve(request("r1", [p])).status).toBe("reserved");
        expect(() => other.uow.ledger.reserve(request("r2", [p]))).toThrow(/locked|busy/i);
      });
      expect(other.uow.ledger.reserve(request("r2", [p]))).toMatchObject({
        status: "denied",
        reason: "session_already_active",
      });
    } finally {
      other.close();
    }
  });
});

describe("plafonds bornés par la policy consentie", () => {
  it("refuse tout plafond non nul sans révision consentie et effective", () => {
    store.close();
    dir.remove();
    dir = tempDir();
    store = openStore(dir.dbPath);
    createProfile(store.uow);
    expect(() => period()).toThrow(/aucune révision de policy consentie/);
    authorize(store.uow, "rev-1", {}, false);
    expect(() => period()).toThrow(/aucune révision de policy consentie/);
    // Des plafonds nuls restent possibles : rien n'est alors réservable.
    const p = period(NOON, [{ unit: "tokens", cap: 0, userReserve: 0 }]);
    expect(
      store.uow.ledger.reserve(request("r1", [p], [{ unit: "tokens", amount: 1 }])),
    ).toMatchObject({ status: "denied", reason: "budget_unknown" });
  });

  it("refuse les plafonds d'une révision ancienne plus large", () => {
    authorize(store.uow, "rev-2", { tokensPerPeriod: 5_000 });
    expect(() => period()).toThrow(/au-delà de la policy effective \(5000\)/);
    const p = period(NOON, [{ unit: "tokens", cap: 5_000, userReserve: 2_000 }]);
    expect(available(p)).toBe(3_000);
  });

  it("refuse un relèvement sans consentement et ne l'applique pas", () => {
    const p = period();
    authorize(store.uow, "rev-2", { tokensPerPeriod: 50_000, userReserveTokens: 0 }, false);
    expect(() => period(NOON, [{ unit: "tokens", cap: 50_000, userReserve: 0 }])).toThrow(
      /au-delà de la policy effective/,
    );
    expect(() => period(NOON, [{ unit: "tokens", cap: 10_000, userReserve: 0 }])).toThrow(
      /réserve utilisateur 0 sous la policy effective/,
    );
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 10_000,
      available: 8_000,
    });
    // Une fois consentie, la révision élargie devient effective.
    store.uow.policies.recordConsent({
      id: "consent-rev-2" as ConsentId,
      revisionId: "rev-2" as PolicyRevisionId,
      grantedAt: NOON,
      channel: "local_cli",
      proof: "test",
    });
    period(NOON, [{ unit: "tokens", cap: 50_000, userReserve: 0 }]);
    expect(available(p)).toBe(50_000);
  });

  it("borne un plafond déjà persisté par la policy effective courante", () => {
    const p = period();
    authorize(store.uow, "rev-2", { tokensPerPeriod: 4_000 });
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 4_000,
      available: 2_000,
    });
  });

  it("rend tout inconnu après révocation de la révision effective", () => {
    const p = period();
    store.uow.policies.recordRevocation({
      revisionId: "rev-1" as PolicyRevisionId,
      revokedAt: NOON,
      reason: "test",
    });
    expect(available(p)).toBeNull();
    expect(store.uow.ledger.reserve(request("r1", [p]))).toMatchObject({
      status: "denied",
      reason: "budget_unknown",
    });
  });

  it("refuse une définition de période différente de la policy", () => {
    expect(() =>
      store.uow.ledger.ensurePeriod(
        PROFILE,
        { kind: "week", timeZone: DAY_PARIS.timeZone },
        NOON,
        LIMITS,
      ),
    ).toThrow(/définition de période/);
  });

  it("refuse la monnaie sans API payante autorisée", () => {
    authorize(store.uow, "rev-2", { paidApi: { authorized: false } });
    expect(() => period()).toThrow(/money:EUR/);
  });
});

describe("conflits d'idempotence", () => {
  it("refuse une même clé de réservation avec un autre contenu", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    expect(() =>
      store.uow.ledger.reserve(request("r1", [p], [{ unit: "tokens", amount: 2_999 }])),
    ).toThrow(/autre contenu/);
    expect(() =>
      store.uow.ledger.reserve({ ...request("r1", [p]), sessionId: "autre" as SessionId }),
    ).toThrow(/autre contenu/);
    expect(store.uow.ledger.availability(p, "tokens").openReservations).toBe(3_000);
  });

  it("refuse un rapprochement rejoué avec un autre usage", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    const records = [usage("r1", { unit: "tokens", amount: 1_200 })];
    store.uow.ledger.reconcile("r1" as ReservationId, records, NOON);
    expect(store.uow.ledger.reconcile("r1" as ReservationId, records, NOON).status).toBe(
      "reconciled",
    );
    expect(() =>
      store.uow.ledger.reconcile(
        "r1" as ReservationId,
        [usage("r1", { unit: "tokens", amount: 9_999 })],
        NOON,
      ),
    ).toThrow(/autre usage/);
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(1_200);
  });

  it("refuse un usage rejoué avec un autre détail par catégorie", () => {
    const p = period();
    store.uow.ledger.reserve(request("r1", [p]));
    const base = usage("r1", { unit: "tokens", amount: 100 });
    store.uow.ledger.recordUsage({ ...base, tokenBreakdown: { input: 60, output: 40 } });
    store.uow.ledger.recordUsage({ ...base, tokenBreakdown: { input: 60, output: 40 } });
    expect(() => {
      store.uow.ledger.recordUsage({ ...base, tokenBreakdown: { input: 100 } });
    }).toThrow(/autre détail/);
  });
});

describe("périodes chevauchantes", () => {
  it("compte une fois dans la semaine une réservation liée à deux jours", () => {
    const start = ts("2026-10-29T22:30:00Z");
    const days = store.uow.ledger.ensurePeriodsCovering(
      PROFILE,
      DAY_PARIS,
      start,
      7_200_000,
      LIMITS,
    );
    store.uow.ledger.reserve(
      request(
        "r1",
        days.map((d) => d.id),
        [{ unit: "tokens", amount: 3_000 }],
        start,
      ),
    );
    // Changement consenti de définition : une période hebdomadaire chevauche les jours.
    const weekly = { kind: "week" as const, timeZone: DAY_PARIS.timeZone };
    authorize(store.uow, "rev-2", { period: weekly });
    const week = store.uow.ledger.ensurePeriod(PROFILE, weekly, start, LIMITS);
    expect(store.uow.ledger.availability(week.id, "tokens").openReservations).toBe(3_000);
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 900 })],
      start,
    );
    expect(store.uow.ledger.availability(week.id, "tokens")).toMatchObject({
      reconciled: 900,
      openReservations: 0,
    });
  });
});

describe("unité provider_quota_bp", () => {
  const SHORT = "codex:primary";
  const WEEKLY = "codex:secondary";
  const guard = {
    enabled: true as const,
    accountRiskAcknowledged: true as const,
    startBelowBasisPoints: 5_000,
    stopAtBasisPoints: 7_000,
    userReserveBasisPoints: 2_000,
    overshootBoundBasisPoints: 500,
    maxSnapshotAgeMs: 60_000,
    targetUsageBasisPoints: 7_000,
    initialRateBasisPointsPerHour: 2_000,
    pacingMarginRatio: 0.25,
  };
  const quotaLimits = (cap: number): PeriodLimit[] => [
    ...LIMITS,
    { unit: "provider_quota_bp", cap, userReserve: 0, windowKey: SHORT },
    { unit: "provider_quota_bp", cap, userReserve: 0, windowKey: WEEKLY },
  ];

  it("n'autorise aucun plafond sans garde consentie ou avec un dépassement non mesuré", () => {
    expect(() => period(NOON, quotaLimits(1_000))).toThrow(/provider_quota_bp/);
    authorize(store.uow, "rev-2", {
      subscriptionQuota: { ...guard, overshootBoundBasisPoints: null },
    });
    expect(() => period(NOON, quotaLimits(1_000))).toThrow(/provider_quota_bp/);
  });

  it("réserve et rapproche par fenêtre, sans conversion en tokens", () => {
    authorize(store.uow, "rev-2", { subscriptionQuota: guard });
    expect(() => period(NOON, quotaLimits(7_501))).toThrow(/au-delà/);
    const p = period(NOON, quotaLimits(7_500));
    expect(() => store.uow.ledger.availability(p, "provider_quota_bp")).toThrow(/fenêtre/);
    const result = store.uow.ledger.reserve(
      request(
        "r1",
        [p],
        [
          { unit: "provider_quota_bp", amount: 1_500, windowKey: SHORT },
          { unit: "tokens", amount: 100 },
        ],
      ),
    );
    expect(result.status).toBe("reserved");
    expect(store.uow.ledger.availability(p, "provider_quota_bp", SHORT)).toMatchObject({
      windowKey: SHORT,
      cap: 7_500,
      openReservations: 1_500,
      available: 6_000,
    });
    expect(store.uow.ledger.availability(p, "provider_quota_bp", WEEKLY).available).toBe(7_500);
    expect(store.uow.ledger.availability(p, "tokens").openReservations).toBe(100);

    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [
        usage("r1", { unit: "provider_quota_bp", amount: 300, windowKey: SHORT }, "measured"),
        usage("r1", { unit: "tokens", amount: 80 }),
      ],
      NOON,
    );
    expect(store.uow.ledger.availability(p, "provider_quota_bp", SHORT)).toMatchObject({
      reconciled: 300,
      available: 7_200,
    });
    expect(store.uow.ledger.availability(p, "tokens").reconciled).toBe(80);
    expect(store.uow.ledger.getReservation("r1" as ReservationId)?.maxima).toContainEqual({
      unit: "provider_quota_bp",
      amount: 1_500,
      windowKey: SHORT,
    });
  });

  it("garde une consommation de quota inconnue à la borne réservée", () => {
    authorize(store.uow, "rev-2", { subscriptionQuota: guard });
    const p = period(NOON, quotaLimits(7_500));
    store.uow.ledger.reserve(
      request("r1", [p], [{ unit: "provider_quota_bp", amount: 2_000, windowKey: WEEKLY }]),
    );
    store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "provider_quota_bp", amount: 10, windowKey: WEEKLY }, "unknown")],
      NOON,
    );
    expect(store.uow.ledger.availability(p, "provider_quota_bp", WEEKLY)).toMatchObject({
      reconciled: 2_000,
      reconciledByProvenance: { measured: 0, estimated: 0, simulated: 0, unknown: 2_000 },
    });
  });

  it("refuse une fenêtre sans plafond et une clé de fenêtre invalide", () => {
    authorize(store.uow, "rev-2", { subscriptionQuota: guard });
    const p = period(NOON, quotaLimits(7_500));
    expect(
      store.uow.ledger.reserve(
        request("r1", [p], [{ unit: "provider_quota_bp", amount: 1, windowKey: "codex:other" }]),
      ),
    ).toMatchObject({ status: "denied", reason: "budget_unknown" });
    expect(() =>
      store.uow.ledger.reserve(
        request("r2", [p], [{ unit: "provider_quota_bp", amount: 1, windowKey: "" }]),
      ),
    ).toThrow(/clé de fenêtre/);
  });
});
