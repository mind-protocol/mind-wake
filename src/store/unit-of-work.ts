/**
 * Point d'entrée transactionnel sur une connexion SQLite (`UnitOfWork`).
 */

import type { UnitOfWork } from "../contracts/index.js";
import { SqliteLedgerRepository } from "../ledger/sqlite-ledger.js";
import { openDatabase, type OpenDatabaseOptions, type SqliteDatabase } from "./database.js";
import { StoreError } from "./errors.js";
import {
  SqliteCheckpointRepository,
  SqliteExperimentRepository,
  SqliteJournalRepository,
  SqlitePolicyRepository,
  SqliteProfileRepository,
  SqliteSessionRepository,
} from "./repositories.js";
import { immediate } from "./sql.js";

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class SqliteUnitOfWork implements UnitOfWork {
  readonly profiles: SqliteProfileRepository;
  readonly policies: SqlitePolicyRepository;
  readonly experiments: SqliteExperimentRepository;
  readonly sessions: SqliteSessionRepository;
  readonly ledger: SqliteLedgerRepository;
  readonly journal: SqliteJournalRepository;
  readonly checkpoints: SqliteCheckpointRepository;
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.profiles = new SqliteProfileRepository(db);
    this.policies = new SqlitePolicyRepository(db);
    this.experiments = new SqliteExperimentRepository(db);
    this.sessions = new SqliteSessionRepository(db);
    this.ledger = new SqliteLedgerRepository(db);
    this.journal = new SqliteJournalRepository(db);
    this.checkpoints = new SqliteCheckpointRepository(db);
  }

  /**
   * Exécute `fn` en `BEGIN IMMEDIATE` : validé au retour, annulé sur exception.
   * Imbriquée, elle devient un savepoint. `fn` doit être synchrone (ADR-001) : une
   * promesse retournée annule la transaction.
   */
  transaction<T>(fn: (uow: UnitOfWork) => T): T {
    return immediate(this.#db, () => {
      const result = fn(this);
      if (isThenable(result)) {
        throw new StoreError(
          "async_transaction",
          "une transaction ne peut pas contenir d'opération asynchrone",
        );
      }
      return result;
    });
  }
}

export interface Store {
  readonly db: SqliteDatabase;
  readonly uow: SqliteUnitOfWork;
  close(): void;
}

/** Ouvre la base de contrôle, applique les migrations et expose les dépôts. */
export function openStore(path: string, options: OpenDatabaseOptions = {}): Store {
  const db = openDatabase(path, options);
  return {
    db,
    uow: new SqliteUnitOfWork(db),
    close: () => {
      db.close();
    },
  };
}
