/**
 * Adapter de règlement DÉTERMINISTE et SIMULÉ (TRANSACTIONS §12, §18). Il imite un rail
 * externe dans un fichier SQLite séparé pour que les crashs entre état local et effet
 * « externe » soient réels. Aucun réseau, wallet, chaîne ni argent : un « transfert »
 * est une ligne de ce fichier, marquée SIMULÉ.
 *
 * Il imite aussi les propriétés dangereuses d'un vrai rail, pour les tester :
 * - fenêtre d'idempotence bornée : passé `lookupRetentionMs`, la clé est oubliée ; une
 *   nouvelle soumission avec la même clé créerait un second transfert ;
 * - timeout après acceptation : l'appel échoue alors que le transfert a eu lieu ;
 * - indisponibilité de la recherche ;
 * - fencing : une soumission portant un jeton plus ancien que le dernier vu est refusée.
 */

import { canonicalJson, sha256 } from "./contract.js";
import { openSqlite, type AdviceDatabase } from "./db.js";
import { SIMULATION_LABEL } from "./types.js";

export interface TransferPayload {
  /** `true` pour le service de séances SIMULÉ ; un adapter réel refuse un payload simulé. */
  readonly simulated: boolean;
  readonly settlementId: string;
  readonly contractId: string;
  readonly contractDigest: string;
  readonly guidePrincipalId: string;
  readonly recipientBindingVersion: string;
  readonly assetId: string;
  readonly networkId: string;
  /** Montant en unités fictives, chaîne décimale exacte. */
  readonly amount: string;
}

export interface SettlementAdapterCapabilities {
  /** `false` seulement pour un adapter d'intégration de test (devnet), jamais accepté par le service. */
  readonly simulated: boolean;
  readonly label: string;
  /** Durée pendant laquelle une clé reste recherchable et dédupliquée. */
  readonly lookupRetentionMs: number;
  readonly fencing: boolean;
}

export type SubmitResult =
  | { readonly status: "accepted"; readonly externalRef: string }
  | {
      readonly status: "rejected";
      readonly reason:
        | "stale_fencing_token"
        | "payload_conflict"
        | "invalid_payload"
        | "fee_changed"
        | "recipient_unresolved"
        | "rail_refused";
    };

export type LookupResult =
  | {
      readonly status: "found";
      readonly externalRef: string;
      readonly state: "confirming" | "finalized";
      readonly payloadDigest: string;
    }
  | { readonly status: "not_found" };

/** Résultat inconnu : l'opération a pu avoir lieu. Ne jamais réémettre sur cette base. */
export class SettlementTimeoutError extends Error {
  override readonly name = "SettlementTimeoutError";
}

export class SettlementUnavailableError extends Error {
  override readonly name = "SettlementUnavailableError";
}

/**
 * Contrat d'un adapter de règlement. Le service de séances n'accepte que l'implémentation
 * simulée ; l'adapter devnet (`services/advice/rail-solana-devnet`) est une intégration de test.
 */
export interface SettlementAdapter {
  capabilities(): SettlementAdapterCapabilities;
  submit(key: string, payload: TransferPayload, fencingToken: number): Promise<SubmitResult>;
  lookup(key: string): Promise<LookupResult>;
  notify(dedupeKey: string, payload: unknown): Promise<"sent" | "duplicate">;
}

export interface SimulatedRailFaults {
  /** Accepte le prochain transfert puis signale un timeout. */
  timeoutAfterAccept?: number;
  /** Signale un timeout sans rien accepter. */
  timeoutBeforeAccept?: number;
  /** La recherche est indisponible tant que ce compteur est positif. */
  lookupUnavailable?: number;
}

export interface SimulatedRailOptions {
  readonly lookupRetentionMs?: number;
  /** Délai avant qu'un transfert accepté soit annoncé final. */
  readonly finalityDelayMs?: number;
  readonly now?: () => number;
  readonly faults?: SimulatedRailFaults;
}

const RAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  max_fencing_token INTEGER NOT NULL
) STRICT;
-- Historique des effets « externes » simulés : append-only, jamais purgé.
CREATE TABLE IF NOT EXISTS effects (
  effect_id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,
  guide_principal_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  label TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notifications (
  dedupe_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  label TEXT NOT NULL
) STRICT;
`;

export class SimulatedSettlementRail implements SettlementAdapter {
  readonly #db: AdviceDatabase;
  readonly #retentionMs: number;
  readonly #finalityDelayMs: number;
  readonly #now: () => number;
  readonly faults: SimulatedRailFaults;

  constructor(path: string, options: SimulatedRailOptions = {}) {
    this.#db = openSqlite(path);
    this.#db.exec(RAIL_SCHEMA);
    this.#retentionMs = options.lookupRetentionMs ?? 24 * 3_600_000;
    this.#finalityDelayMs = options.finalityDelayMs ?? 0;
    this.#now = options.now ?? Date.now;
    this.faults = options.faults ?? {};
  }

  close(): void {
    this.#db.close();
  }

  capabilities(): SettlementAdapterCapabilities {
    return {
      simulated: true,
      label: SIMULATION_LABEL,
      lookupRetentionMs: this.#retentionMs,
      fencing: true,
    };
  }

  /** Oublie les clés plus anciennes que la fenêtre, comme un fournisseur réel. */
  #purge(now: number): void {
    this.#db
      .prepare("DELETE FROM idempotency WHERE accepted_at_ms < ?")
      .run(now - this.#retentionMs);
  }

  submit(key: string, payload: TransferPayload, fencingToken: number): Promise<SubmitResult> {
    const now = this.#now();
    if (consume(this.faults, "timeoutBeforeAccept")) {
      return Promise.reject(new SettlementTimeoutError("SIMULÉ : timeout avant acceptation"));
    }
    // Le payload vient du stockage local : sa forme est revérifiée à l'exécution.
    const declared: { simulated?: unknown } = payload;
    if (declared.simulated !== true || !/^(0|[1-9][0-9]*)$/.test(payload.amount)) {
      return Promise.resolve({ status: "rejected", reason: "invalid_payload" });
    }
    const digest = sha256(canonicalJson(payload));
    const result = this.#db
      .transaction((): SubmitResult => {
        this.#purge(now);
        const existing = this.#db
          .prepare<
            [string],
            { payload_digest: string; external_ref: string; max_fencing_token: number }
          >("SELECT payload_digest, external_ref, max_fencing_token FROM idempotency WHERE key = ?")
          .get(key);
        if (existing !== undefined) {
          if (fencingToken < existing.max_fencing_token) {
            return { status: "rejected", reason: "stale_fencing_token" };
          }
          if (existing.payload_digest !== digest) {
            return { status: "rejected", reason: "payload_conflict" };
          }
          this.#db
            .prepare("UPDATE idempotency SET max_fencing_token = ? WHERE key = ?")
            .run(fencingToken, key);
          return { status: "accepted", externalRef: existing.external_ref };
        }
        const sequence =
          (
            this.#db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM effects").get() ?? {
              n: 0,
            }
          ).n + 1;
        const externalRef = `SIM-TX-${sha256(`${key}#${String(sequence)}`).slice(0, 16)}`;
        this.#db
          .prepare(
            "INSERT INTO idempotency (key, payload_digest, external_ref, accepted_at_ms, max_fencing_token) VALUES (?, ?, ?, ?, ?)",
          )
          .run(key, digest, externalRef, now, fencingToken);
        this.#db
          .prepare(
            "INSERT INTO effects (key, external_ref, guide_principal_id, amount, accepted_at_ms, label) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(key, externalRef, payload.guidePrincipalId, payload.amount, now, SIMULATION_LABEL);
        return { status: "accepted", externalRef };
      })
      .immediate();
    if (result.status === "accepted" && consume(this.faults, "timeoutAfterAccept")) {
      return Promise.reject(new SettlementTimeoutError("SIMULÉ : timeout après acceptation"));
    }
    return Promise.resolve(result);
  }

  lookup(key: string): Promise<LookupResult> {
    if (consume(this.faults, "lookupUnavailable")) {
      return Promise.reject(new SettlementUnavailableError("SIMULÉ : recherche indisponible"));
    }
    const now = this.#now();
    const row = this.#db
      .transaction(() => {
        this.#purge(now);
        return this.#db
          .prepare<
            [string],
            { payload_digest: string; external_ref: string; accepted_at_ms: number }
          >("SELECT payload_digest, external_ref, accepted_at_ms FROM idempotency WHERE key = ?")
          .get(key);
      })
      .immediate();
    if (row === undefined) return Promise.resolve({ status: "not_found" });
    return Promise.resolve({
      status: "found",
      externalRef: row.external_ref,
      payloadDigest: row.payload_digest,
      state: now - row.accepted_at_ms >= this.#finalityDelayMs ? "finalized" : "confirming",
    });
  }

  notify(dedupeKey: string, payload: unknown): Promise<"sent" | "duplicate"> {
    const { changes } = this.#db
      .prepare("INSERT OR IGNORE INTO notifications (dedupe_key, payload, label) VALUES (?, ?, ?)")
      .run(dedupeKey, canonicalJson(payload), SIMULATION_LABEL);
    return Promise.resolve(changes === 1 ? "sent" : "duplicate");
  }

  /** Inspection pour les tests : effets « externes » simulés réellement produits. */
  effects(): { key: string; externalRef: string; guidePrincipalId: string; amount: string }[] {
    return this.#db
      .prepare<
        [],
        { key: string; external_ref: string; guide_principal_id: string; amount: string }
      >("SELECT key, external_ref, guide_principal_id, amount FROM effects ORDER BY effect_id")
      .all()
      .map((row) => ({
        key: row.key,
        externalRef: row.external_ref,
        guidePrincipalId: row.guide_principal_id,
        amount: row.amount,
      }));
  }

  notifications(): { dedupeKey: string }[] {
    return this.#db
      .prepare<[], { dedupe_key: string }>("SELECT dedupe_key FROM notifications")
      .all()
      .map((row) => ({ dedupeKey: row.dedupe_key }));
  }
}

function consume(faults: SimulatedRailFaults, name: keyof SimulatedRailFaults): boolean {
  const remaining = faults[name] ?? 0;
  if (remaining <= 0) return false;
  faults[name] = remaining - 1;
  return true;
}
