/**
 * État persistant du scheduler (migration `scheduler_state`) : échecs consécutifs,
 * fin du backoff et de la dernière session en UTC, dernier refus journalisé. Partage la
 * connexion du `UnitOfWork` : ses écritures entrent dans la même transaction.
 */

import type { ProfileId, UtcTimestamp } from "../contracts/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { normalizeUtcTimestamp } from "../ledger/index.js";

export interface SchedulerState {
  readonly profileId: ProfileId;
  readonly consecutiveFailures: number;
  readonly backoffUntil: UtcTimestamp | null;
  readonly lastSessionEndedAt: UtcTimestamp | null;
  /** Détail du dernier refus journalisé ; évite de répéter le même événement. */
  readonly lastDenial: string | null;
  readonly updatedAt: UtcTimestamp | null;
}

export interface SchedulerStateRepository {
  get(profileId: ProfileId): SchedulerState;
  save(state: SchedulerState, at: UtcTimestamp): void;
}

interface Row {
  profile_id: string;
  consecutive_failures: number;
  backoff_until: string | null;
  last_session_ended_at: string | null;
  last_denial: string | null;
  updated_at: string;
}

export function initialSchedulerState(profileId: ProfileId): SchedulerState {
  return {
    profileId,
    consecutiveFailures: 0,
    backoffUntil: null,
    lastSessionEndedAt: null,
    lastDenial: null,
    updatedAt: null,
  };
}

function optionalTs(value: UtcTimestamp | null): string | null {
  return value === null ? null : normalizeUtcTimestamp(value);
}

export class SqliteSchedulerStateRepository implements SchedulerStateRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(profileId: ProfileId): SchedulerState {
    const row = this.#db
      .prepare<[string], Row>("SELECT * FROM scheduler_state WHERE profile_id = ?")
      .get(profileId);
    if (row === undefined) return initialSchedulerState(profileId);
    return {
      profileId,
      consecutiveFailures: row.consecutive_failures,
      backoffUntil: row.backoff_until as UtcTimestamp | null,
      lastSessionEndedAt: row.last_session_ended_at as UtcTimestamp | null,
      lastDenial: row.last_denial,
      updatedAt: row.updated_at as UtcTimestamp,
    };
  }

  save(state: SchedulerState, at: UtcTimestamp): void {
    if (!Number.isSafeInteger(state.consecutiveFailures) || state.consecutiveFailures < 0) {
      throw new RangeError(`échecs consécutifs invalides : ${String(state.consecutiveFailures)}`);
    }
    this.#db
      .prepare(
        `INSERT INTO scheduler_state (profile_id, consecutive_failures, backoff_until,
           last_session_ended_at, last_denial, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id) DO UPDATE SET
           consecutive_failures = excluded.consecutive_failures,
           backoff_until = excluded.backoff_until,
           last_session_ended_at = excluded.last_session_ended_at,
           last_denial = excluded.last_denial,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.profileId,
        state.consecutiveFailures,
        optionalTs(state.backoffUntil),
        optionalTs(state.lastSessionEndedAt),
        state.lastDenial,
        normalizeUtcTimestamp(at),
      );
  }
}
