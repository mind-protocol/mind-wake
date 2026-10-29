import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_PARIS,
  LIMITS,
  PROFILE,
  createProfile,
  tempDir,
  ts,
  type TempDir,
} from "../../test/fixtures/store-ledger/setup.js";
import type {
  BudgetPeriodId,
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
    const third = store.uow.ledger.reconcile(
      "r1" as ReservationId,
      [usage("r1", { unit: "tokens", amount: 9_999 })],
      NOON,
    );
    expect(second).toEqual(first);
    expect(third).toEqual(first);
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
    period(NOON, [{ unit: "tokens", cap: 2_500, userReserve: 0 }]);
    expect(store.uow.ledger.availability(p, "tokens")).toMatchObject({
      cap: 2_500,
      reconciled: 3_000,
      available: -500,
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
    expect(() => period(NOON, [{ unit: "tokens", cap: -1, userReserve: 0 }])).toThrow(/entier/);
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
