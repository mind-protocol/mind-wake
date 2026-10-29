/**
 * Ledger de ressources sur SQLite (SPEC §6). Ce n'est ni un escrow ni une preuve de
 * fonds (TRANSACTIONS.md §7.1) : il compte des tokens, sessions, durées, centimes d'API
 * autorisée et parts de fenêtre de quota, sans rien verrouiller chez un tiers.
 *
 * Pour une période, une unité et son qualifiant (devise ou fenêtre de quota) :
 * `disponible = plafond − rapproché − réservations ouvertes − réserve utilisateur`.
 *
 * - Plafond et réserve effectifs : ceux de la période, bornés par la révision de policy
 *   consentie et effective du profil (voir `authorization.ts`). Sans révision effective,
 *   la disponibilité est inconnue.
 * - Les réservations `open` et `uncertain` comptent à leur borne maximale, ou à l'usage
 *   déjà rapporté s'il la dépasse.
 * - Le rapprochement écrit la consommation imputée et clôt la réservation dans la même
 *   transaction : la réservation cesse de compter au moment exact où son usage compte.
 * - Une période compte chaque réservation liée à une période du profil qui la chevauche
 *   dans le temps, une seule fois chacune ; son usage rapproché y est imputé en entier
 *   (borne prudente, faute de répartition fiable entre périodes).
 * - Les unités ne sont jamais converties ; une autre devise que celle du plafond rend la
 *   disponibilité monétaire inconnue, et chaque fenêtre de quota a son propre compte.
 * - Une même clé (réservation, rapprochement, usage) rejouée avec un contenu différent
 *   lève un conflit ; rejouée à l'identique, elle ne change rien.
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
  PolicyGroups,
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
  assertWindowKey,
  computeCharges,
  makeQuantity,
  quantityAmount,
  quantityQualifier,
  unitKey,
} from "./accounting.js";
import {
  ceilingFromPolicy,
  restrictCeiling,
  sameDefinition,
  unitCeiling,
  type AuthorizedCeiling,
} from "./authorization.js";
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
  readonly qualifier: string;
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
  readonly qualifier: string;
  readonly amount: number;
}

interface UsageRow extends QuantityRow {
  readonly provenance: UsageProvenance;
  readonly token_breakdown_json: string | null;
  readonly recorded_at: string;
}

interface RevisionAuthorityRow {
  readonly groups_json: string;
  readonly consented: number;
  readonly revoked: number;
}

const ZERO_BY_PROVENANCE: Readonly<Record<UsageProvenance, number>> = {
  measured: 0,
  estimated: 0,
  simulated: 0,
  unknown: 0,
};

/** Valeurs admises à l'exécution : les données peuvent venir d'un JSON non typé. */
const PERIOD_KINDS: readonly string[] = ["day", "week", "month"];

/** Réservations comptées dans une période : liées à une période qui la chevauche. */
const RESERVATIONS_IN_SCOPE = `
  SELECT DISTINCT rp.reservation_id AS id
    FROM budget_periods p
    JOIN budget_periods q
      ON q.profile_id = p.profile_id AND q.starts_at < p.ends_at AND q.ends_at > p.starts_at
    JOIN reservation_periods rp ON rp.period_id = q.id
   WHERE p.id = :period`;

function denied(
  reason: "budget_exhausted" | "budget_unknown" | "session_already_active",
  detail: string,
): ReservationResult {
  return { status: "denied", reason, detail };
}

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

function limitQualifier(limit: PeriodLimit): string {
  return limit.currency ?? limit.windowKey ?? "";
}

function validateLimits(limits: readonly PeriodLimit[]): void {
  const seen = new Set<string>();
  for (const limit of limits) {
    assertUnit(limit.unit);
    assertAmount(limit.cap, `plafond ${limit.unit}`);
    assertAmount(limit.userReserve, `réserve utilisateur ${limit.unit}`);
    if (limit.unit === "money") {
      if (limit.currency === undefined)
        throw new RangeError("un plafond monétaire exige une devise");
      assertCurrency(limit.currency);
    } else if (limit.currency !== undefined) {
      throw new RangeError(`l'unité ${limit.unit} ne porte pas de devise`);
    }
    if (limit.unit === "provider_quota_bp") {
      if (limit.windowKey === undefined) {
        throw new RangeError("un plafond de quota exige une clé de fenêtre");
      }
      assertWindowKey(limit.windowKey);
    } else if (limit.windowKey !== undefined) {
      throw new RangeError(`l'unité ${limit.unit} ne porte pas de clé de fenêtre`);
    }
    // Une seule devise par période ; un plafond par fenêtre de quota.
    const key = limit.unit === "money" ? "money" : unitKey(limit.unit, limitQualifier(limit));
    if (seen.has(key)) throw new RangeError(`plafond en double pour ${key}`);
    seen.add(key);
  }
}

function quantityKey(quantity: BudgetQuantity): string {
  return `${unitKey(quantity.unit, quantityQualifier(quantity))}=${String(quantityAmount(quantity))}`;
}

function usageKey(record: UsageRecord): string {
  return [
    quantityKey(record.quantity),
    record.provenance,
    normalizeUtcTimestamp(record.recordedAt),
  ].join("|");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

export class SqliteLedgerRepository implements LedgerRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /**
   * Crée ou retrouve la période et remplace ses plafonds. Refuse (`not_authorized`)
   * tout plafond non nul sans révision consentie et effective, au-delà de celle-ci, ou
   * avec une réserve humaine inférieure, ainsi qu'une définition de période différente.
   */
  ensurePeriod(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    at: UtcTimestamp,
    limits: readonly PeriodLimit[],
  ): BudgetPeriod {
    const normalized = normalizeDefinition(definition);
    validateLimits(limits);
    return immediate(this.#db, () => {
      this.#authorizeLimits(profileId, normalized, limits);
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
      this.#authorizeLimits(profileId, normalized, limits);
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
      const key = unitKey(quantity.unit, quantityQualifier(quantity));
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
        const reservation = this.#load(existing);
        const same =
          existing.session_id === request.sessionId &&
          existing.profile_id === request.profileId &&
          sameSet(reservation.periodIds, periodIds) &&
          sameSet(reservation.maxima.map(quantityKey), request.maxima.map(quantityKey));
        if (!same) {
          throw new StoreError(
            "conflict",
            `réservation ${request.id} déjà enregistrée avec un autre contenu`,
          );
        }
        return { status: "reserved", reservation };
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

      const ceiling = this.#ceiling(request.profileId);
      for (const period of periods) {
        for (const quantity of request.maxima) {
          const qualifier = quantityQualifier(quantity);
          const availability = this.#availability(
            period,
            quantity.unit,
            quantity.unit === "provider_quota_bp" ? qualifier : undefined,
            ceiling,
          );
          const label = `${unitKey(quantity.unit, qualifier)} sur la période ${period.id}`;
          if (availability.available === null) {
            return denied("budget_unknown", `disponibilité inconnue pour ${label}`);
          }
          if (quantity.unit === "money" && availability.currency !== quantity.currency) {
            return denied(
              "budget_unknown",
              `devise différente du plafond (${String(availability.currency)}) pour ${label}`,
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
        "INSERT INTO reservation_maxima (reservation_id, unit, qualifier, amount) VALUES (?, ?, ?, ?)",
      );
      for (const quantity of request.maxima) {
        addMaximum.run(
          request.id,
          quantity.unit,
          quantityQualifier(quantity),
          quantityAmount(quantity),
        );
      }
      return { status: "reserved", reservation: this.#load(this.#requireReservation(request.id)) };
    });
  }

  /**
   * Enregistre un incrément d'usage. Rejoué à l'identique, il est ignoré, y compris
   * après rapprochement ; un usage nouveau sur une réservation rapprochée est refusé.
   */
  recordUsage(usage: UsageRecord): void {
    this.#validateUsage(usage);
    immediate(this.#db, () => {
      const row = this.#requireReservation(usage.reservationId);
      if (row.status === "reconciled") {
        if (this.#hasUsage(usage)) return;
        throw new StoreError(
          "closed",
          `réservation ${row.id} déjà rapprochée : usage tardif à traiter explicitement`,
        );
      }
      this.#insertUsage(usage);
    });
  }

  /**
   * Rapproche et clôt la réservation. Rejoué avec un usage déjà enregistré, il ne
   * change rien ; rejoué avec un usage nouveau, il lève un conflit.
   */
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
        if (!usage.every((record) => this.#hasUsage(record))) {
          throw new StoreError("conflict", `réservation ${id} déjà rapprochée avec un autre usage`);
        }
        return this.#load(row);
      }
      for (const record of usage) this.#insertUsage(record);
      const reservation = this.#load(row);
      const insertCharge = this.#db.prepare(
        "INSERT INTO reservation_charges (reservation_id, unit, qualifier, amount, provenance) VALUES (?, ?, ?, ?, ?)",
      );
      for (const charge of computeCharges(reservation.maxima, this.#usage(id))) {
        insertCharge.run(id, charge.unit, charge.qualifier, charge.amount, charge.provenance);
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

  availability(periodId: BudgetPeriodId, unit: BudgetUnit, windowKey?: string): BudgetAvailability {
    assertUnit(unit);
    if (unit === "provider_quota_bp") {
      if (windowKey === undefined) {
        throw new StoreError("invalid_input", "la disponibilité d'un quota exige sa fenêtre");
      }
      assertWindowKey(windowKey);
    }
    const period = this.#periodRow(periodId);
    if (period === undefined) {
      throw new StoreError("not_found", `période ${periodId} inconnue`);
    }
    return this.#availability(
      period,
      unit,
      unit === "provider_quota_bp" ? windowKey : undefined,
      this.#ceiling(period.profile_id as ProfileId),
    );
  }

  #availability(
    period: PeriodRow,
    unit: BudgetUnit,
    windowKey: string | undefined,
    ceiling: AuthorizedCeiling | null,
  ): BudgetAvailability {
    const limit =
      unit === "provider_quota_bp"
        ? this.#db
            .prepare<[string, string, string], LimitRow>(
              "SELECT unit, qualifier, cap, user_reserve FROM period_limits WHERE period_id = ? AND unit = ? AND qualifier = ?",
            )
            .get(period.id, unit, windowKey ?? "")
        : this.#db
            .prepare<[string, string], LimitRow>(
              "SELECT unit, qualifier, cap, user_reserve FROM period_limits WHERE period_id = ? AND unit = ?",
            )
            .get(period.id, unit);
    const qualifier = unit === "provider_quota_bp" ? (windowKey ?? "") : (limit?.qualifier ?? "");

    const reconciledRows = this.#db
      .prepare<
        { period: string; unit: string },
        { qualifier: string; provenance: UsageProvenance; total: number }
      >(
        `SELECT c.qualifier, c.provenance, SUM(c.amount) AS total
           FROM reservation_charges c
           JOIN reservations r ON r.id = c.reservation_id
          WHERE c.reservation_id IN (${RESERVATIONS_IN_SCOPE})
            AND c.unit = :unit AND r.status = 'reconciled'
          GROUP BY c.qualifier, c.provenance`,
      )
      .all({ period: period.id, unit });

    const openRows = this.#db
      .prepare<{ period: string; unit: string }, { qualifier: string; total: number }>(
        `WITH open_reservations AS (
           SELECT id FROM reservations
            WHERE id IN (${RESERVATIONS_IN_SCOPE}) AND status IN ('open', 'uncertain')
         ),
         parts AS (
           SELECT reservation_id, qualifier, amount AS bound, 0 AS used
             FROM reservation_maxima
            WHERE unit = :unit AND reservation_id IN (SELECT id FROM open_reservations)
           UNION ALL
           SELECT reservation_id, qualifier, 0, amount
             FROM usage_records
            WHERE unit = :unit AND reservation_id IN (SELECT id FROM open_reservations)
         ),
         exposure AS (
           SELECT qualifier, MAX(SUM(bound), SUM(used)) AS amount
             FROM parts GROUP BY reservation_id, qualifier
         )
         SELECT qualifier, SUM(amount) AS total FROM exposure GROUP BY qualifier`,
      )
      .all({ period: period.id, unit });

    const byProvenance: Record<UsageProvenance, number> = { ...ZERO_BY_PROVENANCE };
    let reconciled = 0;
    let openReservations = 0;
    let foreignCurrency = false;
    for (const row of reconciledRows) {
      if (row.qualifier !== qualifier) {
        // Une autre fenêtre de quota est un autre compte ; une autre devise rend inconnu.
        if (unit === "money") foreignCurrency = true;
        continue;
      }
      reconciled += row.total;
      byProvenance[row.provenance] += row.total;
    }
    for (const row of openRows) {
      if (row.qualifier !== qualifier) {
        if (unit === "money") foreignCurrency = true;
        continue;
      }
      openReservations += row.total;
    }

    const authorized = ceiling === null ? null : unitCeiling(ceiling, unit, qualifier);
    const cap = Math.min(limit?.cap ?? 0, authorized?.cap ?? 0);
    const userReserve = Math.max(limit?.user_reserve ?? 0, authorized?.minUserReserve ?? 0);
    const known = limit !== undefined && authorized !== null && !foreignCurrency;
    return {
      periodId: period.id as BudgetPeriodId,
      unit,
      ...optional("currency", unit === "money" && qualifier !== "" ? qualifier : null),
      ...optional("windowKey", unit === "provider_quota_bp" ? qualifier : null),
      cap,
      reconciled,
      openReservations,
      userReserve,
      available: known ? cap - reconciled - openReservations - userReserve : null,
      reconciledByProvenance: byProvenance,
    };
  }

  /**
   * Plafonds autorisés : ceux de la dernière révision consentie, restreints par les
   * révisions ultérieures non consenties. `null` si aucune révision consentie, si elle
   * est révoquée ou si une révision est illisible.
   */
  #ceiling(profileId: ProfileId): AuthorizedCeiling | null {
    const rows = this.#db
      .prepare<[string], RevisionAuthorityRow>(
        `SELECT r.groups_json,
                EXISTS (SELECT 1 FROM policy_consents c WHERE c.revision_id = r.id) AS consented,
                EXISTS (SELECT 1 FROM permission_revocations v WHERE v.revision_id = r.id) AS revoked
           FROM policy_revisions r WHERE r.profile_id = ? ORDER BY r.rowid`,
      )
      .all(profileId);
    let effectiveIndex = -1;
    rows.forEach((row, i) => {
      if (row.consented === 1) effectiveIndex = i;
    });
    const effective = rows[effectiveIndex];
    if (effective === undefined || effective.revoked === 1) return null;
    try {
      let ceiling = ceilingFromPolicy(JSON.parse(effective.groups_json) as PolicyGroups);
      for (const later of rows.slice(effectiveIndex + 1)) {
        ceiling = restrictCeiling(
          ceiling,
          ceilingFromPolicy(JSON.parse(later.groups_json) as PolicyGroups),
        );
      }
      for (const unit of [ceiling.tokens, ceiling.sessions, ceiling.durationMs]) {
        assertAmount(unit.cap, "plafond de policy");
        assertAmount(unit.minUserReserve, "réserve de policy");
      }
      if (ceiling.money !== null) assertAmount(ceiling.money.cap, "plafond monétaire de policy");
      if (ceiling.providerQuota !== null) {
        assertAmount(ceiling.providerQuota.cap, "plafond de quota de policy");
      }
      return ceiling;
    } catch {
      return null;
    }
  }

  #authorizeLimits(
    profileId: ProfileId,
    definition: BudgetPeriodDefinition,
    limits: readonly PeriodLimit[],
  ): void {
    const granted = limits.filter((limit) => limit.cap > 0);
    if (granted.length === 0) return;
    const ceiling = this.#ceiling(profileId);
    if (ceiling === null) {
      throw new StoreError(
        "not_authorized",
        "aucune révision de policy consentie et effective n'autorise de plafond",
      );
    }
    if (!sameDefinition(definition, ceiling.definition)) {
      throw new StoreError(
        "not_authorized",
        "définition de période différente de celle de la policy effective",
      );
    }
    for (const limit of granted) {
      const authorized = unitCeiling(ceiling, limit.unit, limitQualifier(limit));
      const label = unitKey(limit.unit, limitQualifier(limit));
      if (limit.cap > authorized.cap) {
        throw new StoreError(
          "not_authorized",
          `plafond ${String(limit.cap)} au-delà de la policy effective (${String(authorized.cap)}) pour ${label}`,
        );
      }
      if (limit.userReserve < authorized.minUserReserve) {
        throw new StoreError(
          "not_authorized",
          `réserve utilisateur ${String(limit.userReserve)} sous la policy effective (${String(authorized.minUserReserve)}) pour ${label}`,
        );
      }
    }
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
      "INSERT INTO period_limits (period_id, unit, qualifier, cap, user_reserve) VALUES (?, ?, ?, ?, ?)",
    );
    for (const limit of limits) {
      insertLimit.run(row.id, limit.unit, limitQualifier(limit), limit.cap, limit.userReserve);
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
        "SELECT unit, qualifier, cap, user_reserve FROM period_limits WHERE period_id = ? ORDER BY unit, qualifier",
      )
      .all(row.id)
      .map((limit): PeriodLimit => ({
        unit: limit.unit,
        cap: limit.cap,
        userReserve: limit.user_reserve,
        ...optional("currency", limit.unit === "money" ? limit.qualifier : null),
        ...optional("windowKey", limit.unit === "provider_quota_bp" ? limit.qualifier : null),
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
        "SELECT unit, qualifier, amount FROM reservation_maxima WHERE reservation_id = ? ORDER BY unit, qualifier",
      )
      .all(row.id)
      .map((q): BudgetQuantity => makeQuantity(q.unit, q.amount, q.qualifier));
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
        `SELECT unit, qualifier, amount, provenance, token_breakdown_json, recorded_at
           FROM usage_records WHERE reservation_id = ? ORDER BY seq`,
      )
      .all(id)
      .map((row): UsageRecord => ({
        reservationId: id,
        quantity: makeQuantity(row.unit, row.amount, row.qualifier),
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

  /** Vrai si exactement cet usage (détail par catégorie compris) est déjà enregistré. */
  #hasUsage(usage: UsageRecord): boolean {
    const key = usageKey(usage);
    const breakdown =
      usage.tokenBreakdown === undefined ? null : JSON.stringify(usage.tokenBreakdown);
    return this.#usage(usage.reservationId).some(
      (stored) =>
        usageKey(stored) === key &&
        (stored.tokenBreakdown === undefined ? null : JSON.stringify(stored.tokenBreakdown)) ===
          breakdown,
    );
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
    const inserted = this.#db
      .prepare(
        `INSERT INTO usage_records
           (reservation_id, unit, qualifier, amount, provenance, token_breakdown_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (reservation_id, unit, qualifier, provenance, recorded_at, amount) DO NOTHING`,
      )
      .run(
        usage.reservationId,
        usage.quantity.unit,
        quantityQualifier(usage.quantity),
        quantityAmount(usage.quantity),
        usage.provenance,
        usage.tokenBreakdown === undefined ? null : JSON.stringify(usage.tokenBreakdown),
        normalizeUtcTimestamp(usage.recordedAt),
      );
    if (inserted.changes === 0 && !this.#hasUsage(usage)) {
      throw new StoreError("conflict", "usage déjà enregistré avec un autre détail par catégorie");
    }
  }
}
