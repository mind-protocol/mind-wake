/**
 * Ledger FICTIF en partie double (TRANSACTIONS §7.3). Distinct du ledger de ressources
 * de Wake (`src/ledger`) : il compte des unités simulées, pas des tokens ni du temps.
 *
 * Une réservation dans ce ledger n'est PAS un escrow : elle empêche seulement deux
 * processus de ce service de promettre les mêmes unités fictives. Elle ne verrouille
 * aucun fonds externe (TRANSACTIONS §7.1). Aucun libellé ne doit la présenter comme
 * une garantie de paiement.
 *
 * Convention : chaque ligne est un mouvement signé du solde du compte ; une écriture
 * est équilibrée (somme nulle). La source fictive est la contrepartie des dotations.
 */

import { formatSigned, parseSigned } from "./amounts.js";
import type { AdviceDatabase } from "./db.js";
import type { ContractId, PoolId, PrincipalId, UtcTimestamp } from "./types.js";

export const FICTIVE_FUNDING_SOURCE = "sim:funding-source";

export const accounts = {
  available: (pool: PoolId) => `pool:${pool}:available`,
  reserved: (pool: PoolId) => `pool:${pool}:reserved`,
  due: (pool: PoolId) => `pool:${pool}:due`,
  settling: (pool: PoolId) => `pool:${pool}:settling`,
  guideSettled: (guide: PrincipalId) => `guide:${guide}:settled-simulated`,
} as const;

export class LedgerError extends Error {
  override readonly name = "LedgerError";
  readonly code: "unbalanced" | "conflict" | "negative_balance";

  constructor(code: "unbalanced" | "conflict" | "negative_balance", message: string) {
    super(message);
    this.code = code;
  }
}

export type LedgerLine = readonly [account: string, amount: bigint];

/**
 * Inscrit une écriture équilibrée, idempotente par `opKey` : rejouée avec les mêmes
 * lignes, elle est ignorée ; avec d'autres lignes, elle est refusée (conflit).
 * À appeler dans une transaction d'écriture.
 */
export function postEntry(
  db: AdviceDatabase,
  entry: {
    readonly opKey: string;
    readonly kind: string;
    readonly contractId: ContractId | null;
    readonly lines: readonly LedgerLine[];
    readonly at: UtcTimestamp;
  },
): "posted" | "already_posted" {
  const lines = entry.lines.filter(([, amount]) => amount !== 0n);
  const sum = lines.reduce((acc, [, amount]) => acc + amount, 0n);
  if (sum !== 0n) throw new LedgerError("unbalanced", `écriture ${entry.opKey} déséquilibrée`);
  const existing = db
    .prepare<[string], { entry_id: number }>("SELECT entry_id FROM ledger_entries WHERE op_key = ?")
    .get(entry.opKey);
  if (existing !== undefined) {
    const stored = db
      .prepare<[number], { account: string; amount: string }>(
        "SELECT account, amount FROM ledger_lines WHERE entry_id = ? ORDER BY rowid",
      )
      .all(existing.entry_id)
      .map((row) => `${row.account}=${row.amount}`)
      .join(";");
    const proposed = lines
      .map(([account, amount]) => `${account}=${formatSigned(amount)}`)
      .join(";");
    if (stored !== proposed) {
      throw new LedgerError("conflict", `clé ${entry.opKey} réutilisée avec d'autres montants`);
    }
    return "already_posted";
  }
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO ledger_entries (op_key, kind, contract_id, at, simulated) VALUES (?, ?, ?, ?, 1)",
    )
    .run(entry.opKey, entry.kind, entry.contractId, entry.at);
  const insertLine = db.prepare(
    "INSERT INTO ledger_lines (entry_id, account, amount) VALUES (?, ?, ?)",
  );
  for (const [account, amount] of lines) {
    insertLine.run(lastInsertRowid, account, formatSigned(amount));
  }
  for (const [account] of lines) {
    if (account.startsWith("pool:") && balance(db, account) < 0n) {
      throw new LedgerError("negative_balance", `solde négatif refusé sur ${account}`);
    }
  }
  return "posted";
}

/** Solde projeté, reconstruit depuis le journal comptable (jamais stocké). */
export function balance(db: AdviceDatabase, account: string): bigint {
  return db
    .prepare<[string], { amount: string }>("SELECT amount FROM ledger_lines WHERE account = ?")
    .all(account)
    .reduce((acc, row) => acc + parseSigned(row.amount), 0n);
}

export interface PoolBalances {
  readonly available: bigint;
  readonly reserved: bigint;
  readonly due: bigint;
  readonly settling: bigint;
}

export function poolBalances(db: AdviceDatabase, pool: PoolId): PoolBalances {
  return {
    available: balance(db, accounts.available(pool)),
    reserved: balance(db, accounts.reserved(pool)),
    due: balance(db, accounts.due(pool)),
    settling: balance(db, accounts.settling(pool)),
  };
}

/** Vérifie que chaque écriture du ledger est équilibrée. */
export function ledgerIsBalanced(db: AdviceDatabase): boolean {
  const rows = db
    .prepare<[], { entry_id: number; amount: string }>("SELECT entry_id, amount FROM ledger_lines")
    .all();
  const sums = new Map<number, bigint>();
  for (const row of rows) {
    sums.set(row.entry_id, (sums.get(row.entry_id) ?? 0n) + parseSigned(row.amount));
  }
  return [...sums.values()].every((sum) => sum === 0n);
}
