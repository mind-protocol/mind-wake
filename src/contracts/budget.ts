/**
 * Unités de budget, périodes, réservations et usage (AGENTS §5, SPEC §6).
 * Les unités ne se convertissent jamais implicitement entre elles.
 */

import type {
  BudgetPeriodId,
  DurationMs,
  IanaTimeZone,
  ReservationId,
  SessionId,
  UtcTimestamp,
} from "./common.js";

/** Code devise ISO 4217 en majuscules, par exemple `EUR`. */
export type CurrencyCode = string;

export const BUDGET_UNITS = ["tokens", "sessions", "duration_ms", "money"] as const;

export type BudgetUnit = (typeof BUDGET_UNITS)[number];

/**
 * Quantité typée par unité. Toutes les valeurs sont des entiers positifs ou nuls.
 * La monnaie est exprimée en unités mineures (centimes) et porte toujours sa devise.
 */
export type BudgetQuantity =
  | { readonly unit: "tokens"; readonly amount: number }
  | { readonly unit: "sessions"; readonly amount: number }
  | { readonly unit: "duration_ms"; readonly amount: DurationMs }
  | { readonly unit: "money"; readonly amountMinor: number; readonly currency: CurrencyCode };

/**
 * Provenance d'une valeur de consommation. Elle doit rester visible partout où la
 * valeur est affichée (statut, bilan, export).
 */
export const USAGE_PROVENANCES = ["measured", "estimated", "simulated", "unknown"] as const;

export type UsageProvenance = (typeof USAGE_PROVENANCES)[number];

/**
 * Catégories de tokens qu'un adapter peut exposer. Une catégorie non exposée par le
 * runtime est couverte par la borne de `unexposed` dans la réservation (SPEC §6).
 */
export const TOKEN_CATEGORIES = [
  "input",
  "cached_input",
  "output",
  "reasoning",
  "tool",
  "unexposed",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/**
 * Définition explicite d'une période de budget. Les bornes sont calculées dans le
 * fuseau configuré puis persistées en UTC ; un redémarrage ou un changement d'heure ne
 * remet pas la période à zéro.
 */
export interface BudgetPeriodDefinition {
  readonly kind: "day" | "week" | "month";
  readonly timeZone: IanaTimeZone;
  /** Premier jour de la semaine pour `week` : 0 = dimanche … 6 = samedi. */
  readonly weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Plafond d'une unité pour une période, issu de la policy consentie en vigueur.
 * `cap` et `userReserve` sont des entiers dans l'unité (unités mineures pour la
 * monnaie, qui porte alors sa devise). Une unité sans plafond est inconnue, donc non
 * réservable.
 */
export interface PeriodLimit {
  readonly unit: BudgetUnit;
  readonly cap: number;
  readonly userReserve: number;
  /** Obligatoire pour `money`, absent sinon. */
  readonly currency?: CurrencyCode;
}

/** Instance persistée d'une période : intervalle semi-ouvert [startsAt, endsAt). */
export interface BudgetPeriod {
  readonly id: BudgetPeriodId;
  readonly definition: BudgetPeriodDefinition;
  readonly startsAt: UtcTimestamp;
  readonly endsAt: UtcTimestamp;
  /** Plafonds persistés avec la période, une entrée au plus par unité. */
  readonly limits: readonly PeriodLimit[];
}

/**
 * Statut d'une réservation.
 * - `open` : enveloppe maximale bloquée, session lancée ou sur le point de l'être.
 * - `reconciled` : consommation rapprochée ; conversion et clôture sont atomiques.
 * - `uncertain` : consommation non confirmée (crash, orpheline) ; reste comptée à sa
 *   borne maximale jusqu'à rapprochement fiable.
 */
export type ReservationStatus = "open" | "reconciled" | "uncertain";

/**
 * Réservation d'enveloppe pour une session. Elle couvre chaque période
 * potentiellement concernée si la session peut traverser une frontière.
 * L'identifiant sert de clé d'idempotence pour la création et la clôture.
 */
export interface Reservation {
  readonly id: ReservationId;
  readonly sessionId: SessionId;
  readonly periodIds: readonly BudgetPeriodId[];
  /** Bornes maximales réservées, une entrée par unité concernée. */
  readonly maxima: readonly BudgetQuantity[];
  readonly status: ReservationStatus;
  readonly createdAt: UtcTimestamp;
  readonly closedAt?: UtcTimestamp;
}

/** Consommation rapportée pour une réservation, avec sa provenance. */
export interface UsageRecord {
  readonly reservationId: ReservationId;
  readonly quantity: BudgetQuantity;
  readonly provenance: UsageProvenance;
  /** Détail facultatif des tokens par catégorie, si l'adapter l'expose. */
  readonly tokenBreakdown?: Readonly<Partial<Record<TokenCategory, number>>>;
  readonly recordedAt: UtcTimestamp;
}

/**
 * Disponibilité calculée pour une période et une unité :
 * `available = cap − reconciled − openReservations − userReserve`.
 * `available` est `null` si une composante est inconnue : un budget inconnu n'est
 * pas disponible et bloque le lancement.
 */
export interface BudgetAvailability {
  readonly periodId: BudgetPeriodId;
  readonly unit: BudgetUnit;
  readonly currency?: CurrencyCode;
  readonly cap: number;
  readonly reconciled: number;
  readonly openReservations: number;
  readonly userReserve: number;
  readonly available: number | null;
  /**
   * Décomposition de `reconciled` par provenance. Une consommation estimée ou inconnue
   * y figure à sa borne maximale.
   */
  readonly reconciledByProvenance?: Readonly<Record<UsageProvenance, number>>;
}
