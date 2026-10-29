/**
 * Ledger de budget sur SQLite (SPEC §6).
 *
 * Pour une période et une unité :
 * `disponible = plafond − rapproché − réservations ouvertes − réserve utilisateur`.
 *
 * - Les réservations `open` et `uncertain` comptent à leur borne maximale, ou à l'usage
 *   déjà rapporté s'il la dépasse.
 * - Le rapprochement écrit la consommation imputée et clôt la réservation dans la même
 *   transaction : la réservation cesse de compter au moment exact où son usage compte.
 * - Une réservation couvre chaque période qu'elle cite ; son usage rapproché y est
 *   imputé en entier (borne prudente, faute de répartition fiable entre périodes).
 * - Les unités ne sont jamais converties ; une devise différente de celle du plafond
 *   rend la disponibilité monétaire inconnue.
 */

import { randomUUID } from "node:crypto";
import type {
  BudgetAvailability,
  BudgetPeriod,
  BudgetPeriodDefinition,
  BudgetPeriodId,
  BudgetQuantity,
  BudgetUnit,
  LedgerRepository,
  PeriodLimit,
  ProfileId,
  Reservation,
  ReservationId,
  ReservationRequest,
  ReservationResult,
  ReservationStatus,
  SessionId,
  UsageProvenance,
  UsageRecord,
  UtcTimestamp,
} from "../contracts/index.js";
import type { SqliteDatabase } from "../store/database.js";
import { StoreError } from "../store/errors.js";
import { immediate, optional } from "../store/sql.js";
import {
  assertAmount,
  assertCurrency,
  assertProvenance,
  assertQuantity,
  assertUnit,
  computeCharges,
  makeQuantity,
  quantityAmount,
  quantityCurrency,
  unitKey,
} from "./accounting.js";
import { DEFAULT_WEEK_STARTS_ON, periodBoundsAt, periodBoundsCovering } from "./periods.js";
import { normalizeUtcTimestamp, parseUtcTimestamp, toUtcTimestamp } from "./time.js";

interface PeriodRow {
  readonly id: string;
  readonly profile_id: string;
  readonly kind: BudgetPeriodDefinition["kind"];
  readonly time_zone: string;
  readonly week_starts_on: number;
  readonly starts_at: string;
  readonly ends_at: string;
}

interface LimitRow {
  readonly unit: BudgetUnit;
  readonly currency: string;
  readonly cap: number;
  readonly user_reserve: number;
}

interface ReservationRow {
  readonly id: string;
  readonly profile_id: string;
  readonly session_id: string;
  readonly status: ReservationStatus;
  readonly created_at: string;
  readonly closed_at: string | null;
}

interface QuantityRow {
  readonly unit: BudgetUnit;
  readonly currency: string;
  readonly amount: number;
}

interface UsageRow extends QuantityRow {
  readonly provenance: UsageProvenance;
  readonly token_breakdown_json: string | null;
  readonly recorded_at: string;
}

interface TotalRow {
  readonly currency: string;
  readonly provenance: UsageProvenance;
  readonly total: number;
}

const ZERO_BY_PROVENANCE: Readonly<Record<UsageProvenance, number>> = {
  measured: 0,
  estimated: 0,
  simulated: 0,
  unknown: 0,
};

function denied(
  reason: "budget_exhausted" | "budget_unknown" | "session_already_active",
  detail: string,
): ReservationResult {
  return { status: "denied", reason, detail };
}

/** Valeurs admises à l'exécution : les données peuvent venir d'un JSON non typé. */
const PERIOD_KINDS: readonly string[] = ["day", "week", "month"];

function normalizeDefinition(definition: BudgetPeriodDefinition): BudgetPeriodDefinition {
  if (!PERIOD_KINDS.includes(definition.kind)) {
    throw new RangeError(`type de période inconnu : ${definition.kind}`);
  }
  if (definition.kind === "week") {
    const startsOn = definition.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
    if (!Number.isInteger(startsOn) || startsOn < 0 || startsOn > 6) {
      throw new RangeError(`premier jour de semaine invalide : ${String(startsOn)}`);
    }
    return { kind: "week", timeZone: definition.timeZone, weekStartsOn: startsOn };
  }
  return { kind: definition.kind, timeZone: definition.timeZone };
}

function validateLimits(limits: readonly PeriodLimit[]): void {
  const seen = new Set<BudgetUnit>();
  for (const limit of limits) {
    assertUnit(limit.unit);
    if (seen.has(limit.unit)) {
      throw new RangeError(`plafond en double pour l'unité ${limit.unit}`);
    }
    seen.add(limit.unit);
    assertAmount(limit.cap, `plafond ${limit.unit}`);
    assertAmount(limit.userReserve, `réserve utilisateur ${limit.unit}`);
    if (limit.unit === "money") {
      if (limit.currency === undefined) {
        throw new RangeError("un plafond monétaire exige une devise");
      }
      assertCurrency(limit.currency);
    } else if (limit.currency !== undefined) {
      throw new RangeError(`l'unité ${limit.unit} ne porte pas de devise`);
    }
  }
}

export class SqliteLedgerRepository implements LedgerRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  ensurePeriod(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    at: UtcTimestamp,
    limits: readonly PeriodLimit[],
  ): BudgetPeriod {
    const normalized = normalizeDefinition(definition);
    validateLimits(limits);
    return immediate(this.#db, () => {
      const effectiveMs = this.#advanceClock(profileId, at);
      return this.#ensurePeriodAt(profileId, normalized, effectiveMs, limits);
    });
  }

  /**
   * Garantit toutes les périodes qu'une session lancée à `at` et bornée à
   * `maxDurationMs` peut traverser, avec les mêmes plafonds. Extension hors contrat,
   * utile au runner pour constituer `ReservationRequest.periodIds`.
   */
  ensurePeriodsCovering(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    at: UtcTimestamp,
    maxDurationMs: number,
    limits: readonly PeriodLimit[],
  ): readonly BudgetPeriod[] {
    const normalized = normalizeDefinition(definition);
    validateLimits(limits);
    return immediate(this.#db, () => {
      const effectiveMs = this.#advanceClock(profileId, at);
      return periodBoundsCovering(normalized, effectiveMs, maxDurationMs).map((bounds) =>
        this.#ensurePeriodAt(profileId, normalized, bounds.startsAtMs, limits),
      );
    });
  }

  reserve(request: ReservationRequest): ReservationResult {
    if (request.maxima.length === 0) {
      throw new StoreError("invalid_input", "une réservation exige au moins une borne");
    }
    if (request.periodIds.length === 0) {
      throw new StoreError("invalid_input", "une réservation exige au moins une période");
    }
    const keys = new Set<string>();
    for (const quantity of request.maxima) {
      assertQuantity(quantity);
      const key = unitKey(quantity.unit, quantityCurrency(quantity));
      if (keys.has(key)) {
        throw new StoreError("invalid_input", `borne en double pour ${key}`);
      }
      keys.add(key);
    }
    const periodIds = [...new Set(request.periodIds)];
    const createdAt = normalizeUtcTimestamp(request.at);

    return immediate(this.#db, (): ReservationResult => {
      const existing = this.#reservationRow(request.id);
      if (existing !== undefined) {
        if (
          existing.session_id !== request.sessionId ||
          existing.profile_id !== request.profileId
        ) {
          throw new StoreError(
            "conflict",
            `réservation ${request.id} déjà attribuée à une autre session`,
          );
        }
        return { status: "reserved", reservation: this.#load(existing) };
      }

      const effectiveMs = this.#advanceClock(request.profileId, createdAt);

      const active = this.#db
        .prepare<[string], { id: string }>(
          "SELECT id FROM reservations WHERE profile_id = ? AND status = 'open' LIMIT 1",
        )
        .get(request.profileId);
      if (active !== undefined) {
        return denied(
          "session_already_active",
          `réservation ${active.id} encore ouverte pour ce profil`,
        );
      }

      const periods = periodIds.map((id) => {
        const row = this.#periodRow(id);
        if (row?.profile_id !== request.profileId) {
          throw new StoreError("not_found", `période ${id} inconnue pour ce profil`);
        }
        return row;
      });
      const covering = periods.some(
        (row) =>
          parseUtcTimestamp(row.starts_at) <= effectiveMs &&
          effectiveMs < parseUtcTimestamp(row.ends_at),
      );
      if (!covering) {
        return denied(
          "budget_unknown",
          `aucune période fournie ne couvre l'instant ${toUtcTimestamp(effectiveMs)}`,
        );
      }

      for (const period of periods) {
        for (const quantity of request.maxima) {
          const availability = this.#availability(period.id as BudgetPeriodId, quantity.unit);
          const label = `${quantity.unit} sur la période ${period.id}`;
          if (availability.available === null) {
            return denied("budget_unknown", `disponibilité inconnue pour ${label}`);
          }
          if (quantity.unit === "money" && availability.currency !== quantity.currency) {
            return denied(
              "budget_unknown",
              `devise ${quantity.currency} différente du plafond (${String(availability.currency)}) pour ${label}`,
            );
          }
          const amount = quantityAmount(quantity);
          if (amount > availability.available) {
            return denied(
              "budget_exhausted",
              `${String(amount)} demandés, ${String(Math.max(0, availability.available))} disponibles pour ${label}`,
            );
          }
        }
      }

      this.#db
        .prepare(
          "INSERT INTO reservations (id, profile_id, session_id, status, created_at, closed_at) VALUES (?, ?, ?, 'open', ?, NULL)",
        )
        .run(request.id, request.profileId, request.sessionId, createdAt);
      const linkPeriod = this.#db.prepare(
        "INSERT INTO reservation_periods (reservation_id, period_id) VALUES (?, ?)",
      );
      for (const id of periodIds) linkPeriod.run(request.id, id);
      const addMaximum = this.#db.prepare(
        "INSERT INTO reservation_maxima (reservation_id, unit, currency, amount) VALUES (?, ?, ?, ?)",
      );
      for (const quantity of request.maxima) {
        addMaximum.run(
          request.id,
          quantity.unit,
          quantityCurrency(quantity),
          quantityAmount(quantity),
        );
      }
      const reservation = this.getReservation(request.id);
      if (reservation === null) {
        throw new StoreError("not_found", `réservation ${request.id} introuvable après écriture`);
      }
      return { status: "reserved", reservation };
    });
  }

  recordUsage(usage: UsageRecord): void {
    this.#validateUsage(usage);
    immediate(this.#db, () => {
      const row = this.#requireReservation(usage.reservationId);
      if (row.status === "reconciled") {
        throw new StoreError(
          "closed",
          `réservation ${row.id} déjà rapprochée : usage tardif à traiter explicitement`,
        );
      }
      this.#insertUsage(usage);
    });
  }

  reconcile(id: ReservationId, usage: readonly UsageRecord[], at: UtcTimestamp): Reservation {
    for (const record of usage) {
      if (record.reservationId !== id) {
        throw new StoreError(
          "invalid_input",
          `usage d'une autre réservation (${record.reservationId})`,
        );
      }
      this.#validateUsage(record);
    }
    const closedAt = normalizeUtcTimestamp(at);
    return immediate(this.#db, () => {
      const row = this.#requireReservation(id);
      if (row.status === "reconciled") {
        // Rejeu : la consommation a déjà été imputée une fois, rien ne change.
        return this.#load(row);
      }
      for (const record of usage) this.#insertUsage(record);
      const reservation = this.#load(row);
      const recorded = this.#usage(id);
      const insertCharge = this.#db.prepare(
        "INSERT INTO reservation_charges (reservation_id, unit, currency, amount, provenance) VALUES (?, ?, ?, ?, ?)",
      );
      for (const charge of computeCharges(reservation.maxima, recorded)) {
        insertCharge.run(id, charge.unit, charge.currency, charge.amount, charge.provenance);
      }
      const closed = this.#db
        .prepare(
          "UPDATE reservations SET status = 'reconciled', closed_at = ? WHERE id = ? AND status <> 'reconciled'",
        )
        .run(closedAt, id);
      if (closed.changes !== 1) {
        throw new StoreError("conflict", `réservation ${id} clôturée concurremment`);
      }
      return this.#load(this.#requireReservation(id));
    });
  }

  /** `at` est validé mais pas persisté : le contrat `Reservation` n'a pas de date de passage. */
  markUncertain(id: ReservationId, at: UtcTimestamp): Reservation {
    normalizeUtcTimestamp(at);
    return immediate(this.#db, () => {
      const row = this.#requireReservation(id);
      if (row.status === "open") {
        this.#db.prepare("UPDATE reservations SET status = 'uncertain' WHERE id = ?").run(id);
        return this.#load(this.#requireReservation(id));
      }
      return this.#load(row);
    });
  }

  getReservation(id: ReservationId): Reservation | null {
    const row = this.#reservationRow(id);
    return row === undefined ? null : this.#load(row);
  }

  /**
   * Réservations non rapprochées d'un profil (`open` ou `uncertain`), les plus
   * anciennes d'abord : point de départ de la réconciliation des orphelines.
   */
  listUnreconciled(profileId: ProfileId): readonly Reservation[] {
    return this.#db
      .prepare<[string], ReservationRow>(
        "SELECT * FROM reservations WHERE profile_id = ? AND status <> 'reconciled' ORDER BY created_at, id",
      )
      .all(profileId)
      .map((row) => this.#load(row));
  }

  /** Usage rapporté pour une réservation, dans l'ordre d'enregistrement. */
  listUsage(id: ReservationId): readonly UsageRecord[] {
    return this.#usage(id);
  }

  getPeriod(id: BudgetPeriodId): BudgetPeriod | null {
    const row = this.#periodRow(id);
    return row === undefined ? null : this.#toPeriod(row);
  }

  availability(periodId: BudgetPeriodId, unit: BudgetUnit): BudgetAvailability {
    assertUnit(unit);
    if (this.#periodRow(periodId) === undefined) {
      throw new StoreError("not_found", `période ${periodId} inconnue`);
    }
    return this.#availability(periodId, unit);
  }

  #availability(periodId: BudgetPeriodId, unit: BudgetUnit): BudgetAvailability {
    const limit = this.#db
      .prepare<[string, string], LimitRow>(
        "SELECT unit, currency, cap, user_reserve FROM period_limits WHERE period_id = ? AND unit = ?",
      )
      .get(periodId, unit);

    const reconciledRows = this.#db
      .prepare<[string, string], TotalRow>(
        `SELECT c.currency, c.provenance, SUM(c.amount) AS total
           FROM reservation_charges c
           JOIN reservation_periods rp ON rp.reservation_id = c.reservation_id
           JOIN reservations r ON r.id = c.reservation_id
          WHERE rp.period_id = ? AND c.unit = ? AND r.status = 'reconciled'
          GROUP BY c.currency, c.provenance`,
      )
      .all(periodId, unit);

    const openRows = this.#db
      .prepare<{ period: string; unit: string }, { currency: string; total: number }>(
        `WITH open_reservations AS (
           SELECT r.id FROM reservations r
             JOIN reservation_periods rp ON rp.reservation_id = r.id
            WHERE rp.period_id = :period AND r.status IN ('open', 'uncertain')
         ),
         parts AS (
           SELECT reservation_id, currency, amount AS bound, 0 AS used
             FROM reservation_maxima
            WHERE unit = :unit AND reservation_id IN (SELECT id FROM open_reservations)
           UNION ALL
           SELECT reservation_id, currency, 0, amount
             FROM usage_records
            WHERE unit = :unit AND reservation_id IN (SELECT id FROM open_reservations)
         ),
         exposure AS (
           SELECT currency, MAX(SUM(bound), SUM(used)) AS amount
             FROM parts GROUP BY reservation_id, currency
         )
         SELECT currency, SUM(amount) AS total FROM exposure GROUP BY currency`,
      )
      .all({ period: periodId, unit });

    const currency = limit?.currency ?? "";
    const byProvenance: Record<UsageProvenance, number> = { ...ZERO_BY_PROVENANCE };
    let reconciled = 0;
    let foreignCurrency = false;
    for (const row of reconciledRows) {
      if (row.currency !== currency) {
        foreignCurrency = true;
        continue;
      }
      reconciled += row.total;
      byProvenance[row.provenance] += row.total;
    }
    let openReservations = 0;
    for (const row of openRows) {
      if (row.currency !== currency) {
        foreignCurrency = true;
        continue;
      }
      openReservations += row.total;
    }

    const cap = limit?.cap ?? 0;
    const userReserve = limit?.user_reserve ?? 0;
    const known = limit !== undefined && !foreignCurrency;
    return {
      periodId,
      unit,
      ...optional("currency", unit === "money" && currency !== "" ? currency : null),
      cap,
      reconciled,
      openReservations,
      userReserve,
      available: known ? cap - reconciled - openReservations - userReserve : null,
      reconciledByProvenance: byProvenance,
    };
  }

  /** Avance l'horloge du ledger ; retourne l'instant effectif (jamais en recul). */
  #advanceClock(profileId: ProfileId, at: UtcTimestamp): number {
    const atMs = parseUtcTimestamp(at);
    const row = this.#db
      .prepare<[string], { high_water_at: string }>(
        "SELECT high_water_at FROM ledger_clocks WHERE profile_id = ?",
      )
      .get(profileId);
    if (row !== undefined) {
      const highWater = parseUtcTimestamp(row.high_water_at);
      if (atMs <= highWater) return highWater;
    }
    this.#db
      .prepare(
        `INSERT INTO ledger_clocks (profile_id, high_water_at) VALUES (?, ?)
         ON CONFLICT (profile_id) DO UPDATE SET high_water_at = excluded.high_water_at`,
      )
      .run(profileId, toUtcTimestamp(atMs));
    return atMs;
  }

  #ensurePeriodAt(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    atMs: number,
    limits: readonly PeriodLimit[],
  ): BudgetPeriod {
    const bounds = periodBoundsAt(definition, atMs);
    const weekStartsOn = definition.kind === "week" ? (definition.weekStartsOn ?? -1) : -1;
    const startsAt = toUtcTimestamp(bounds.startsAtMs);
    this.#db
      .prepare(
        `INSERT INTO budget_periods (id, profile_id, kind, time_zone, week_starts_on, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, kind, time_zone, week_starts_on, starts_at) DO NOTHING`,
      )
      .run(
        randomUUID(),
        profileId,
        definition.kind,
        definition.timeZone,
        weekStartsOn,
        startsAt,
        toUtcTimestamp(bounds.endsAtMs),
      );
    const row = this.#db
      .prepare<[string, string, string, number, string], PeriodRow>(
        `SELECT * FROM budget_periods
          WHERE profile_id = ? AND kind = ? AND time_zone = ? AND week_starts_on = ? AND starts_at = ?`,
      )
      .get(profileId, definition.kind, definition.timeZone, weekStartsOn, startsAt);
    if (row === undefined) {
      throw new StoreError("not_found", "période introuvable après écriture");
    }
    this.#db.prepare("DELETE FROM period_limits WHERE period_id = ?").run(row.id);
    const insertLimit = this.#db.prepare(
      "INSERT INTO period_limits (period_id, unit, currency, cap, user_reserve) VALUES (?, ?, ?, ?, ?)",
    );
    for (const limit of limits) {
      insertLimit.run(row.id, limit.unit, limit.currency ?? "", limit.cap, limit.userReserve);
    }
    return this.#toPeriod(row);
  }

  #toPeriod(row: PeriodRow): BudgetPeriod {
    const definition: BudgetPeriodDefinition =
      row.kind === "week"
        ? {
            kind: "week",
            timeZone: row.time_zone as BudgetPeriodDefinition["timeZone"],
            weekStartsOn: row.week_starts_on as NonNullable<BudgetPeriodDefinition["weekStartsOn"]>,
          }
        : { kind: row.kind, timeZone: row.time_zone as BudgetPeriodDefinition["timeZone"] };
    const limits = this.#db
      .prepare<[string], LimitRow>(
        "SELECT unit, currency, cap, user_reserve FROM period_limits WHERE period_id = ? ORDER BY unit",
      )
      .all(row.id)
      .map((limit): PeriodLimit => ({
        unit: limit.unit,
        cap: limit.cap,
        userReserve: limit.user_reserve,
        ...optional("currency", limit.currency === "" ? null : limit.currency),
      }));
    return {
      id: row.id as BudgetPeriodId,
      definition,
      startsAt: row.starts_at as UtcTimestamp,
      endsAt: row.ends_at as UtcTimestamp,
      limits,
    };
  }

  #periodRow(id: string): PeriodRow | undefined {
    return this.#db
      .prepare<[string], PeriodRow>("SELECT * FROM budget_periods WHERE id = ?")
      .get(id);
  }

  #reservationRow(id: string): ReservationRow | undefined {
    return this.#db
      .prepare<[string], ReservationRow>("SELECT * FROM reservations WHERE id = ?")
      .get(id);
  }

  #requireReservation(id: ReservationId): ReservationRow {
    const row = this.#reservationRow(id);
    if (row === undefined) {
      throw new StoreError("not_found", `réservation ${id} inconnue`);
    }
    return row;
  }

  #load(row: ReservationRow): Reservation {
    const periodIds = this.#db
      .prepare<[string], { period_id: string }>(
        "SELECT period_id FROM reservation_periods WHERE reservation_id = ? ORDER BY period_id",
      )
      .all(row.id)
      .map((link) => link.period_id as BudgetPeriodId);
    const maxima = this.#db
      .prepare<[string], QuantityRow>(
        "SELECT unit, currency, amount FROM reservation_maxima WHERE reservation_id = ? ORDER BY unit, currency",
      )
      .all(row.id)
      .map((q): BudgetQuantity => makeQuantity(q.unit, q.amount, q.currency));
    return {
      id: row.id as ReservationId,
      sessionId: row.session_id as SessionId,
      periodIds,
      maxima,
      status: row.status,
      createdAt: row.created_at as UtcTimestamp,
      ...optional("closedAt", row.closed_at as UtcTimestamp | null),
    };
  }

  #usage(id: ReservationId): readonly UsageRecord[] {
    return this.#db
      .prepare<[string], UsageRow>(
        `SELECT unit, currency, amount, provenance, token_breakdown_json, recorded_at
           FROM usage_records WHERE reservation_id = ? ORDER BY seq`,
      )
      .all(id)
      .map((row): UsageRecord => ({
        reservationId: id,
        quantity: makeQuantity(row.unit, row.amount, row.currency),
        provenance: row.provenance,
        ...optional(
          "tokenBreakdown",
          row.token_breakdown_json === null
            ? null
            : (JSON.parse(row.token_breakdown_json) as UsageRecord["tokenBreakdown"]),
        ),
        recordedAt: row.recorded_at as UtcTimestamp,
      }));
  }

  #validateUsage(usage: UsageRecord): void {
    assertQuantity(usage.quantity);
    assertProvenance(usage.provenance);
    normalizeUtcTimestamp(usage.recordedAt);
    if (usage.tokenBreakdown !== undefined) {
      if (usage.quantity.unit !== "tokens") {
        throw new StoreError(
          "invalid_input",
          "un détail par catégorie ne vaut que pour les tokens",
        );
      }
      for (const [category, amount] of Object.entries(usage.tokenBreakdown)) {
        assertAmount(amount, `tokens ${category}`);
      }
    }
  }

  #insertUsage(usage: UsageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO usage_records
           (reservation_id, unit, currency, amount, provenance, token_breakdown_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (reservation_id, unit, currency, provenance, recorded_at, amount) DO NOTHING`,
      )
      .run(
        usage.reservationId,
        usage.quantity.unit,
        quantityCurrency(usage.quantity),
        quantityAmount(usage.quantity),
        usage.provenance,
        usage.tokenBreakdown === undefined ? null : JSON.stringify(usage.tokenBreakdown),
        normalizeUtcTimestamp(usage.recordedAt),
      );
  }
}
