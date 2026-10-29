/**
 * Service de séances de conseil SIMULÉ (SPEC §14.3–14.4, §17 ; TRANSACTIONS §5–§13).
 *
 * Applique le contrat immuable, la machine à états, le comptage d'échanges, le mandat
 * borné, la réservation fictive et le pipeline de règlement simulé. Toutes les
 * écritures passent par des transactions SQLite immédiates ; le règlement passe par une
 * outbox traitée par des workers à bail et jeton de fencing.
 *
 * Rien ici ne déplace de fonds réels. La réservation est interne : ce n'est pas un
 * escrow, et elle ne protège pas contre un retrait externe (TRANSACTIONS §7.1, P04).
 */

import { sanitizeMetadata, sanitizeReason } from "../../../src/journal/sanitize.js";
import { formatAmount, multiplyAmount, parseAmount } from "./amounts.js";
import {
  assertOpaqueId,
  buildContract,
  canTransition,
  canonicalJson,
  contractDigest,
  parseStoredContract,
  parseStoredMandate,
  sha256,
  ContractError,
  type ContractOffer,
} from "./contract.js";
import { immediate, type AdviceDatabase } from "./db.js";
import { eventDigest, InvalidEventError, parseExchangeEvent } from "./events.js";
import {
  accounts,
  FICTIVE_FUNDING_SOURCE,
  postEntry,
  poolBalances,
  type PoolBalances,
} from "./ledger.js";
import {
  SettlementTimeoutError,
  SettlementUnavailableError,
  type SettlementAdapter,
  type TransferPayload,
} from "./rail.js";
import { buildReceipt, type Receipt } from "./receipt.js";
import {
  FICTIVE_ASSET_ID,
  SIMULATION_LABEL,
  type CloseReason,
  type ContractId,
  type ContractState,
  type ExchangeEvent,
  type ExchangeState,
  type IngestOutcome,
  type MandateId,
  type PaymentMandate,
  type PoolId,
  type PrincipalId,
  type ReservationState,
  type SessionContract,
  type SettlementId,
  type SettlementState,
  type UtcTimestamp,
} from "./types.js";

export class AdviceError extends Error {
  override readonly name = "AdviceError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Points d'arrêt observables par les tests de crash (aucun effet en production). */
export type CrashPoint =
  | "prepare:in_txn"
  | "prepare:after_commit"
  | "worker:after_lease"
  | "worker:after_submission_pending"
  | "worker:after_rail_submit"
  | "worker:after_finalize"
  | "notify:after_send";

export interface AdviceServiceOptions {
  readonly db: AdviceDatabase;
  readonly rail: SettlementAdapter;
  readonly now?: () => number;
  /** Durée du bail d'un worker sur un événement d'outbox. */
  readonly leaseMs?: number;
  readonly hooks?: { reached(point: CrashPoint): void };
}

export interface ContractStatus {
  readonly contract: SessionContract;
  readonly digest: string;
  readonly state: ContractState;
  readonly closeReason: CloseReason | null;
  readonly earnedExchanges: number | null;
  readonly principalDue: bigint | null;
  readonly reservation: {
    readonly state: ReservationState;
    readonly amount: bigint;
    readonly released: bigint;
  } | null;
  readonly settlement: {
    readonly settlementId: SettlementId;
    readonly state: SettlementState;
    readonly frozenReason: string | null;
    readonly externalRef: string | null;
  } | null;
  readonly label: typeof SIMULATION_LABEL;
}

export interface WorkerReport {
  readonly workerId: string;
  readonly handled: readonly { readonly outboxId: number; readonly result: string }[];
}

interface ContractRow {
  body: string;
  digest: string;
  state: ContractState;
  state_version: number;
  close_reason: CloseReason | null;
  closed_at: string | null;
  last_activity_at: string;
  earned_exchanges: number | null;
  principal_due: string | null;
  reservation_period: number | null;
  request_id: string;
  request_digest: string;
}

interface ExchangeRow {
  exchange_id: string;
  seq: number;
  state: ExchangeState;
}

interface IntentRow {
  settlement_id: SettlementId;
  contract_id: ContractId;
  payload: string;
  payload_digest: string;
  state: SettlementState;
  frozen_reason: string | null;
  external_ref: string | null;
}

interface OutboxRow {
  outbox_id: number;
  topic: "settlement" | "notification";
  dedupe_key: string;
  payload: string;
}

class StaleLeaseError extends Error {
  override readonly name = "StaleLeaseError";
}

export class AdviceSessionService {
  readonly #db: AdviceDatabase;
  readonly #rail: SettlementAdapter;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #hooks: { reached(point: CrashPoint): void } | undefined;

  constructor(options: AdviceServiceOptions) {
    this.#db = options.db;
    this.#rail = options.rail;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#hooks = options.hooks;
    const capabilities: { simulated?: unknown } = this.#rail.capabilities();
    if (capabilities.simulated !== true) {
      throw new AdviceError("not_simulated", "seul un adapter de règlement SIMULÉ est accepté");
    }
  }

  #ts(ms = this.#now()): UtcTimestamp {
    return new Date(ms).toISOString() as UtcTimestamp;
  }

  #hook(point: CrashPoint): void {
    this.#hooks?.reached(point);
  }

  // -------------------------------------------------------------------------
  // Journal

  #journal(entry: {
    readonly contractId: ContractId | null;
    readonly kind: string;
    readonly from?: string | null;
    readonly to?: string | null;
    readonly reason: string;
    readonly metadata?: unknown;
  }): void {
    this.#db
      .prepare(
        "INSERT INTO journal (at, contract_id, kind, from_state, to_state, reason, metadata, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      )
      .run(
        this.#ts(),
        entry.contractId,
        entry.kind,
        entry.from ?? null,
        entry.to ?? null,
        `[SIMULÉ] ${sanitizeReason(entry.reason)}`,
        JSON.stringify(sanitizeMetadata(entry.metadata ?? {})),
      );
  }

  journalEntries(contractId?: ContractId): {
    kind: string;
    from: string | null;
    to: string | null;
    reason: string;
    metadata: string;
  }[] {
    const rows =
      contractId === undefined
        ? this.#db
            .prepare<
              [],
              {
                kind: string;
                from_state: string | null;
                to_state: string | null;
                reason: string;
                metadata: string;
              }
            >("SELECT kind, from_state, to_state, reason, metadata FROM journal ORDER BY seq")
            .all()
        : this.#db
            .prepare<
              [string],
              {
                kind: string;
                from_state: string | null;
                to_state: string | null;
                reason: string;
                metadata: string;
              }
            >(
              "SELECT kind, from_state, to_state, reason, metadata FROM journal WHERE contract_id = ? ORDER BY seq",
            )
            .all(contractId);
    return rows.map((row) => ({
      kind: row.kind,
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
      metadata: row.metadata,
    }));
  }

  // -------------------------------------------------------------------------
  // Contrôles : gel d'urgence financier (distinct de l'arrêt conversationnel)

  isFrozen(): boolean {
    return (
      this.#db.prepare<[], { frozen: number }>("SELECT frozen FROM controls WHERE id = 1").get()
        ?.frozen === 1
    );
  }

  freeze(actor: string, reason: string): void {
    immediate(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE controls SET frozen = 1, reason = ?, changed_by = ?, changed_at = ? WHERE id = 1",
        )
        .run(sanitizeReason(reason), assertOpaqueId(actor, "actor"), this.#ts());
      this.#journal({
        contractId: null,
        kind: "freeze",
        reason: `gel d'urgence : ${reason}`,
        metadata: { actor },
      });
    });
  }

  /**
   * Reprise explicite après gel. Refusée tant qu'une intention reste à l'état incertain :
   * le rapprochement précède la réouverture (TRANSACTIONS §14.2, P20).
   */
  unfreeze(actor: string, reason: string): void {
    immediate(this.#db, () => {
      const pending = this.#db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM settlement_intents WHERE state IN ('unknown', 'submission_pending')",
        )
        .get();
      if ((pending?.n ?? 0) > 0) {
        throw new AdviceError(
          "reconcile_first",
          "intentions incertaines à rapprocher avant reprise",
        );
      }
      this.#db
        .prepare(
          "UPDATE controls SET frozen = 0, reason = ?, changed_by = ?, changed_at = ? WHERE id = 1",
        )
        .run(sanitizeReason(reason), assertOpaqueId(actor, "actor"), this.#ts());
      this.#journal({
        contractId: null,
        kind: "unfreeze",
        reason: `reprise explicite : ${reason}`,
        metadata: { actor },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Enveloppe fictive et mandat

  createPool(poolId: PoolId, payer: PrincipalId): void {
    immediate(this.#db, () => {
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO pools (pool_id, payer_principal_id, asset_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          assertOpaqueId(poolId, "poolId"),
          assertOpaqueId(payer, "payer"),
          FICTIVE_ASSET_ID,
          this.#ts(),
        );
    });
  }

  /** Dotation FICTIVE d'une enveloppe : aucun fonds réel n'est déposé. */
  fundPool(poolId: PoolId, amount: string | bigint, opKey: string): void {
    const value = parseAmount(amount, "dotation");
    immediate(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM pools WHERE pool_id = ?").get(poolId) === undefined) {
        throw new AdviceError("unknown_pool", "enveloppe inconnue");
      }
      const posted = postEntry(this.#db, {
        opKey: `fund:${assertOpaqueId(opKey, "opKey")}`,
        kind: "fund_simulated",
        contractId: null,
        lines: [
          [FICTIVE_FUNDING_SOURCE, -value],
          [accounts.available(poolId), value],
        ],
        at: this.#ts(),
      });
      if (posted === "posted") {
        this.#journal({
          contractId: null,
          kind: "fund_simulated",
          reason: "dotation fictive de l'enveloppe",
          metadata: { poolId, amount: formatAmount(value) },
        });
      }
    });
  }

  poolBalances(poolId: PoolId): PoolBalances {
    return poolBalances(this.#db, poolId);
  }

  registerMandate(mandate: PaymentMandate): void {
    const body = canonicalJson(mandate);
    const digest = sha256(body);
    immediate(this.#db, () => {
      const existing = this.#db
        .prepare<[string, number], { digest: string }>(
          "SELECT digest FROM mandates WHERE mandate_id = ? AND version = ?",
        )
        .get(mandate.mandateId, mandate.version);
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          throw new AdviceError(
            "conflict",
            "version de mandat déjà enregistrée avec un autre contenu",
          );
        }
        return;
      }
      this.#db
        .prepare("INSERT INTO mandates (mandate_id, version, body, digest) VALUES (?, ?, ?, ?)")
        .run(mandate.mandateId, mandate.version, body, digest);
      this.#journal({
        contractId: null,
        kind: "mandate_registered",
        reason: "mandat borné enregistré",
        metadata: { mandateId: mandate.mandateId, version: mandate.version },
      });
    });
  }

  revokeMandate(mandateId: MandateId, version: number): void {
    immediate(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE mandates SET revoked_at = COALESCE(revoked_at, ?) WHERE mandate_id = ? AND version = ?",
        )
        .run(this.#ts(), mandateId, version);
      this.#journal({
        contractId: null,
        kind: "mandate_revoked",
        reason: "mandat révoqué : aucun nouvel engagement",
        metadata: { mandateId, version },
      });
    });
  }

  #mandate(mandateId: MandateId, version: number): { mandate: PaymentMandate; revoked: boolean } {
    const row = this.#db
      .prepare<[string, number], { body: string; revoked_at: string | null }>(
        "SELECT body, revoked_at FROM mandates WHERE mandate_id = ? AND version = ?",
      )
      .get(mandateId, version);
    if (row === undefined) throw new AdviceError("unknown_mandate", "mandat inconnu");
    return { mandate: parseStoredMandate(row.body), revoked: row.revoked_at !== null };
  }

  /** Contrôles statiques du mandat ; rejoués dans la transaction de réservation. */
  #checkMandate(contract: SessionContract, mandate: PaymentMandate, revoked: boolean): void {
    const now = this.#now();
    if (revoked) throw new AdviceError("mandate_revoked", "mandat révoqué");
    if (now < Date.parse(mandate.validFrom) || now >= Date.parse(mandate.expiresAt)) {
      throw new AdviceError("mandate_not_in_effect", "mandat hors de sa période de validité");
    }
    if (contract.agentId !== mandate.agentId) {
      throw new AdviceError("mandate_agent_mismatch", "le mandat ne couvre pas cet agent");
    }
    // Contrat et mandat sont relus depuis le stockage : l'égalité est revérifiée.
    if ((contract.assetId as string) !== (mandate.assetId as string)) {
      throw new AdviceError("mandate_asset_mismatch", "actif hors mandat");
    }
    if (contract.unitPrice > mandate.perExchangeCap) {
      throw new AdviceError("over_exchange_cap", "prix par échange au-dessus du plafond du mandat");
    }
    if (contract.maxPrincipal > mandate.perSessionCap) {
      throw new AdviceError("over_session_cap", "montant maximal au-dessus du plafond par séance");
    }
    if (
      mandate.guideRule.kind === "allow_list" &&
      !mandate.guideRule.guides.includes(contract.guidePrincipalId)
    ) {
      throw new AdviceError("guide_not_allowed", "guide hors de la règle de sélection du mandat");
    }
  }

  // -------------------------------------------------------------------------
  // Contrat

  #row(contractId: ContractId): ContractRow & { contract: SessionContract } {
    const row = this.#db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE contract_id = ?")
      .get(contractId);
    if (row === undefined) throw new AdviceError("unknown_contract", "contrat inconnu");
    return { ...row, contract: parseStoredContract(row.body) };
  }

  #transition(
    contractId: ContractId,
    to: ContractState,
    reason: string,
    metadata?: unknown,
  ): ContractState {
    const row = this.#row(contractId);
    if (!canTransition(row.state, to)) {
      throw new AdviceError("invalid_transition", `transition ${row.state} → ${to} refusée`);
    }
    const { changes } = this.#db
      .prepare(
        "UPDATE contracts SET state = ?, state_version = state_version + 1 WHERE contract_id = ? AND state_version = ?",
      )
      .run(to, contractId, row.state_version);
    if (changes !== 1) throw new AdviceError("conflict", "version du contrat modifiée");
    this.#journal({
      contractId,
      kind: "contract_transition",
      from: row.state,
      to,
      reason,
      metadata,
    });
    return row.state;
  }

  /**
   * Crée une offre. Idempotente par `requestId` : la même demande retourne le même
   * contrat ; d'autres paramètres sous la même clé sont un conflit.
   */
  offer(
    requestId: string,
    offer: ContractOffer,
    mandateRef: { readonly mandateId: MandateId; readonly version: number },
  ): SessionContract {
    assertOpaqueId(requestId, "requestId");
    const requestDigest = sha256(canonicalJson({ offer, mandateRef }));
    return immediate(this.#db, () => {
      const prior = this.#db
        .prepare<[string], { contract_id: ContractId; request_digest: string }>(
          "SELECT contract_id, request_digest FROM contracts WHERE request_id = ?",
        )
        .get(requestId);
      if (prior !== undefined) {
        if (prior.request_digest !== requestDigest) {
          throw new AdviceError("conflict", "clé de demande réutilisée avec d'autres paramètres");
        }
        return this.#row(prior.contract_id).contract;
      }
      const { mandate, revoked } = this.#mandate(mandateRef.mandateId, mandateRef.version);
      let contract: SessionContract;
      try {
        contract = buildContract(offer, mandate, this.#ts());
      } catch (error) {
        if (error instanceof ContractError) throw new AdviceError(error.code, error.message);
        throw error;
      }
      this.#checkMandate(contract, mandate, revoked);
      if (
        this.#db
          .prepare("SELECT 1 FROM contracts WHERE contract_id = ?")
          .get(contract.contractId) !== undefined
      ) {
        throw new AdviceError("conflict", "identifiant de contrat déjà utilisé");
      }
      this.#db
        .prepare(
          `INSERT INTO contracts (contract_id, body, digest, request_id, request_digest, agent_id,
             guide_principal_id, state, state_version, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', 1, ?)`,
        )
        .run(
          contract.contractId,
          canonicalJson(contract),
          contractDigest(contract),
          requestId,
          requestDigest,
          contract.agentId,
          contract.guidePrincipalId,
          contract.createdAt,
        );
      this.#journal({
        contractId: contract.contractId,
        kind: "contract_transition",
        to: "offered",
        reason: "offre de séance créée (unités fictives)",
        metadata: {
          maxExchanges: contract.maxExchanges,
          unitPrice: formatAmount(contract.unitPrice),
          maxPrincipal: formatAmount(contract.maxPrincipal),
        },
      });
      return contract;
    });
  }

  #expireIfPastDeadline(row: ContractRow & { contract: SessionContract }): boolean {
    if (!["offered", "accepted", "reserved"].includes(row.state)) return false;
    if (this.#now() < Date.parse(row.contract.activationDeadline)) return false;
    this.#releaseReservation(row.contract, "expiration technique avant activation");
    this.#transition(row.contract.contractId, "expired", "expiration technique avant activation");
    return true;
  }

  /** Acceptation par le guide désigné, selon les conditions versionnées du contrat. */
  accept(contractId: ContractId, guide: PrincipalId, guideTermsVersion: string): void {
    immediate(this.#db, () => {
      const row = this.#row(contractId);
      if (row.state !== "offered") {
        if (row.state === "accepted") return;
        throw new AdviceError("invalid_transition", `acceptation impossible depuis ${row.state}`);
      }
      if (guide !== row.contract.guidePrincipalId) {
        throw new AdviceError("not_contract_guide", "seul le guide du contrat peut accepter");
      }
      if (guideTermsVersion !== row.contract.guideTermsVersion) {
        throw new AdviceError("terms_mismatch", "conditions du guide différentes du contrat");
      }
      if (this.#expireIfPastDeadline(row)) return;
      this.#transition(contractId, "accepted", "acceptée par le guide");
    });
  }

  /**
   * Réserve atomiquement le montant maximal dans l'enveloppe fictive, avec les plafonds
   * du mandat. Ce verrou interne n'est pas un escrow.
   */
  reserve(contractId: ContractId): void {
    const outcome = immediate(this.#db, () => this.#reserveInTxn(contractId));
    if (outcome === "expired") throw new AdviceError("expired", "contrat expiré avant réservation");
  }

  #reserveInTxn(contractId: ContractId): "reserved" | "expired" {
    const row = this.#row(contractId);
    const contract = row.contract;
    if (row.state !== "accepted") {
      if (["reserved", "active"].includes(row.state)) return "reserved";
      throw new AdviceError("invalid_transition", `réservation impossible depuis ${row.state}`);
    }
    if (this.isFrozen()) throw new AdviceError("frozen", "gel d'urgence : aucun nouvel engagement");
    if (this.#expireIfPastDeadline(row)) return "expired";
    const { mandate, revoked } = this.#mandate(contract.mandateId, contract.mandateVersion);
    this.#checkMandate(contract, mandate, revoked);

    const open = this.#db
      .prepare<[string, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM reservations r JOIN contracts c ON c.contract_id = r.contract_id
         WHERE json_extract(c.body, '$.mandateId') = ? AND json_extract(c.body, '$.mandateVersion') = ?
           AND r.state IN ('held', 'partially_released', 'uncertain')`,
      )
      .get(mandate.mandateId, mandate.version);
    if ((open?.n ?? 0) >= mandate.maxOpenReservations) {
      throw new AdviceError(
        "too_many_open_reservations",
        "plafond de réservations ouvertes atteint",
      );
    }

    const period = Math.floor((this.#now() - Date.parse(mandate.validFrom)) / mandate.periodMs);
    const committed = parseAmount(
      this.#db
        .prepare<[string, number, number], { committed: string }>(
          "SELECT committed FROM mandate_usage WHERE mandate_id = ? AND version = ? AND period_index = ?",
        )
        .get(mandate.mandateId, mandate.version, period)?.committed ?? "0",
    );
    if (committed + contract.maxPrincipal > mandate.perPeriodCap) {
      throw new AdviceError("over_period_cap", "plafond de période du mandat atteint");
    }
    const balances = poolBalances(this.#db, contract.poolId);
    if (balances.available < contract.maxPrincipal) {
      throw new AdviceError(
        "insufficient_fictive_funds",
        "enveloppe fictive insuffisante pour couvrir le montant maximal",
      );
    }
    postEntry(this.#db, {
      opKey: `reserve:${contractId}`,
      kind: "reserve",
      contractId,
      lines: [
        [accounts.available(contract.poolId), -contract.maxPrincipal],
        [accounts.reserved(contract.poolId), contract.maxPrincipal],
      ],
      at: this.#ts(),
    });
    this.#db
      .prepare(
        `INSERT INTO mandate_usage (mandate_id, version, period_index, committed) VALUES (?, ?, ?, ?)
         ON CONFLICT (mandate_id, version, period_index) DO UPDATE SET committed = excluded.committed`,
      )
      .run(
        mandate.mandateId,
        mandate.version,
        period,
        formatAmount(committed + contract.maxPrincipal),
      );
    this.#db
      .prepare(
        "INSERT INTO reservations (contract_id, pool_id, amount, released, state, updated_at) VALUES (?, ?, ?, '0', 'held', ?)",
      )
      .run(contractId, contract.poolId, formatAmount(contract.maxPrincipal), this.#ts());
    this.#db
      .prepare("UPDATE contracts SET reservation_period = ? WHERE contract_id = ?")
      .run(period, contractId);
    try {
      this.#transition(contractId, "reserved", "réservation interne fictive (pas un escrow)", {
        amount: formatAmount(contract.maxPrincipal),
      });
    } catch (error) {
      if (String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
        throw new AdviceError("party_already_in_session", "agent ou guide déjà dans une rencontre");
      }
      throw error;
    }
    return "reserved";
  }

  #setReservation(contractId: ContractId, state: ReservationState, released?: bigint): void {
    this.#db
      .prepare(
        "UPDATE reservations SET state = ?, released = COALESCE(?, released), updated_at = ? WHERE contract_id = ?",
      )
      .run(state, released === undefined ? null : formatAmount(released), this.#ts(), contractId);
  }

  /** Libère entièrement une réservation encore détenue (annulation, expiration). */
  #releaseReservation(contract: SessionContract, reason: string): void {
    const res = this.#db
      .prepare<[string], { amount: string; state: ReservationState }>(
        "SELECT amount, state FROM reservations WHERE contract_id = ?",
      )
      .get(contract.contractId);
    if (res?.state !== "held") return;
    const amount = parseAmount(res.amount);
    postEntry(this.#db, {
      opKey: `release:${contract.contractId}`,
      kind: "release",
      contractId: contract.contractId,
      lines: [
        [accounts.reserved(contract.poolId), -amount],
        [accounts.available(contract.poolId), amount],
      ],
      at: this.#ts(),
    });
    this.#reduceMandateUsage(contract, amount);
    this.#setReservation(contract.contractId, "released", amount);
    this.#journal({
      contractId: contract.contractId,
      kind: "reservation_released",
      reason,
      metadata: { amount: res.amount },
    });
  }

  #reduceMandateUsage(contract: SessionContract, amount: bigint): void {
    if (amount === 0n) return;
    const period = this.#db
      .prepare<[string], { reservation_period: number | null }>(
        "SELECT reservation_period FROM contracts WHERE contract_id = ?",
      )
      .get(contract.contractId)?.reservation_period;
    if (period === null || period === undefined) return;
    const row = this.#db
      .prepare<[string, number, number], { committed: string }>(
        "SELECT committed FROM mandate_usage WHERE mandate_id = ? AND version = ? AND period_index = ?",
      )
      .get(contract.mandateId, contract.mandateVersion, period);
    if (row === undefined) return;
    this.#db
      .prepare(
        "UPDATE mandate_usage SET committed = ? WHERE mandate_id = ? AND version = ? AND period_index = ?",
      )
      .run(
        formatAmount(parseAmount(row.committed) - amount),
        contract.mandateId,
        contract.mandateVersion,
        period,
      );
  }

  activate(contractId: ContractId): void {
    immediate(this.#db, () => {
      const row = this.#row(contractId);
      if (row.state === "active") return;
      if (row.state === "reserved" && this.#expireIfPastDeadline(row)) {
        return;
      }
      this.#transition(contractId, "active", "rencontre ouverte");
      this.#db
        .prepare("UPDATE contracts SET last_activity_at = ? WHERE contract_id = ?")
        .run(this.#ts(), contractId);
    });
    if (this.#row(contractId).state === "expired") {
      throw new AdviceError("expired", "contrat expiré avant activation");
    }
  }

  cancel(contractId: ContractId, reason: string): void {
    immediate(this.#db, () => {
      const row = this.#row(contractId);
      if (row.state === "cancelled") return;
      if (!["offered", "accepted", "reserved"].includes(row.state)) {
        throw new AdviceError("invalid_transition", `annulation impossible depuis ${row.state}`);
      }
      this.#releaseReservation(row.contract, `annulation : ${reason}`);
      this.#transition(contractId, "cancelled", reason);
    });
  }

  // -------------------------------------------------------------------------
  // Comptage d'échanges (TRANSACTIONS §8, SPEC §17.3)

  /**
   * Applique un événement de conversation. Les rejeux (même producteur et identifiant)
   * retournent le résultat d'origine ; un identifiant réutilisé avec un autre contenu
   * est un conflit. Aucun texte de message n'est conservé.
   */
  ingest(input: unknown): IngestOutcome {
    let event: ExchangeEvent;
    try {
      event = parseExchangeEvent(input);
    } catch (error) {
      if (error instanceof InvalidEventError) return { status: "refused", reason: "invalid_event" };
      throw error;
    }
    const digest = eventDigest(event);
    return immediate(this.#db, () => {
      const prior = this.#db
        .prepare<[string, string], { payload_digest: string; outcome: string }>(
          "SELECT payload_digest, outcome FROM inbox WHERE producer = ? AND event_id = ?",
        )
        .get(event.producer, event.eventId);
      if (prior !== undefined) {
        if (prior.payload_digest !== digest) {
          return { status: "conflict", reason: "event_id_reused_with_other_payload" };
        }
        return { status: "duplicate", original: JSON.parse(prior.outcome) as IngestOutcome };
      }
      const outcome = this.#applyEvent(event);
      const seq =
        (this.#db.prepare<[], { s: number | null }>("SELECT MAX(seq) AS s FROM inbox").get()?.s ??
          0) + 1;
      this.#db
        .prepare(
          "INSERT INTO inbox (producer, event_id, payload_digest, contract_id, kind, outcome, received_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.producer,
          event.eventId,
          digest,
          event.contractId,
          event.kind,
          JSON.stringify(outcome),
          this.#ts(),
          seq,
        );
      if (outcome.status === "applied") {
        this.#db
          .prepare("UPDATE contracts SET last_activity_at = ? WHERE contract_id = ?")
          .run(this.#ts(), event.contractId);
      }
      return outcome;
    });
  }

  #exchange(contractId: ContractId, exchangeId: string): ExchangeRow | undefined {
    return this.#db
      .prepare<[string, string], ExchangeRow>(
        "SELECT exchange_id, seq, state FROM exchanges WHERE contract_id = ? AND exchange_id = ?",
      )
      .get(contractId, exchangeId);
  }

  #setExchange(
    contractId: ContractId,
    exchangeId: string,
    from: ExchangeState,
    to: ExchangeState,
    columns: Record<string, string | null> = {},
  ): void {
    const sets = Object.keys(columns).map((column) => `${column} = ?`);
    const { changes } = this.#db
      .prepare(
        `UPDATE exchanges SET ${["state = ?", ...sets].join(", ")} WHERE contract_id = ? AND exchange_id = ? AND state = ?`,
      )
      .run(to, ...Object.values(columns), contractId, exchangeId, from);
    if (changes !== 1) throw new AdviceError("conflict", "état d'échange modifié");
    this.#journal({
      contractId,
      kind: "exchange_transition",
      from,
      to,
      reason: `échange ${exchangeId}`,
      metadata: { exchangeId },
    });
  }

  #applyEvent(event: ExchangeEvent): IngestOutcome {
    switch (event.kind) {
      case "free_text_claim":
        this.#journal({
          contractId: null,
          kind: "claim_ignored",
          reason: "texte libre sans autorité : aucun effet sur le contrat ni le règlement",
          metadata: { contractRef: event.contractId, length: event.claim.length },
        });
        return { status: "not_payable", reason: "free_text_has_no_authority" };
      case "technical":
        return { status: "not_payable", reason: `technical:${event.subtype}` };
      case "final_summary":
        return { status: "not_payable", reason: "final_summary_not_billed" };
      default:
        break;
    }
    const found = this.#db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE contract_id = ?")
      .get(event.contractId);
    if (found === undefined) return { status: "refused", reason: "unknown_contract" };
    const row = { ...found, contract: parseStoredContract(found.body) };
    const contractId = row.contract.contractId;
    const inGrace =
      row.state === "submitted" &&
      row.closed_at !== null &&
      this.#now() <= Date.parse(row.closed_at) + row.contract.closeGraceMs;

    if (event.kind === "agent_point") {
      if (row.state !== "active") return { status: "refused", reason: "admission_closed" };
      if (this.#exchange(contractId, event.exchangeId) !== undefined) {
        return { status: "not_payable", reason: "exchange_already_open" };
      }
      const all = this.#db
        .prepare<[string], ExchangeRow>(
          "SELECT exchange_id, seq, state FROM exchanges WHERE contract_id = ? ORDER BY seq",
        )
        .all(contractId);
      if (all.some((x) => !["earned", "void", "disputed"].includes(x.state))) {
        return { status: "refused", reason: "previous_exchange_unfinished" };
      }
      if (all.filter((x) => x.state !== "void").length >= row.contract.maxExchanges) {
        return { status: "refused", reason: "max_exchanges_reached" };
      }
      this.#db
        .prepare(
          "INSERT INTO exchanges (contract_id, exchange_id, seq, state, agent_point_ref, opened_at) VALUES (?, ?, ?, 'opened', ?, ?)",
        )
        .run(contractId, event.exchangeId, all.length + 1, event.messageId, this.#ts());
      this.#journal({
        contractId,
        kind: "exchange_transition",
        to: "opened",
        reason: `échange ${event.exchangeId} ouvert`,
        metadata: { exchangeId: event.exchangeId, seq: all.length + 1 },
      });
      return { status: "applied", effect: "exchange_opened", exchangeState: "opened" };
    }

    const exchange = this.#exchange(contractId, event.exchangeId);
    if (exchange === undefined) return { status: "refused", reason: "unknown_exchange" };
    if (exchange.state === "void" || exchange.state === "disputed") {
      return { status: "refused", reason: `exchange_${exchange.state}` };
    }

    switch (event.kind) {
      case "agent_clarification":
        return { status: "not_payable", reason: "clarification_same_exchange" };
      case "human_contribution": {
        if (row.state !== "active") return { status: "refused", reason: "admission_closed" };
        if (event.provenance !== "human_explicit") {
          return { status: "not_payable", reason: `provenance:${event.provenance}` };
        }
        if (event.authorPrincipalId !== row.contract.guidePrincipalId) {
          return { status: "refused", reason: "author_not_contract_guide" };
        }
        if (exchange.state !== "opened") {
          return { status: "not_payable", reason: "same_exchange_clarification" };
        }
        this.#setExchange(contractId, event.exchangeId, "opened", "human_submitted", {
          human_message_ref: event.messageId,
          human_principal_id: event.authorPrincipalId,
        });
        return { status: "applied", effect: "human_submitted", exchangeState: "human_submitted" };
      }
      case "agent_reply": {
        if (row.state !== "active" && !inGrace) {
          return { status: "refused", reason: "admission_closed" };
        }
        if (!event.part.final) return { status: "not_payable", reason: "stream_fragment" };
        if (!event.substantive) return { status: "not_payable", reason: "non_substantive_reply" };
        if (exchange.state === "opened")
          return { status: "refused", reason: "no_human_contribution" };
        if (exchange.state !== "human_submitted") {
          return { status: "not_payable", reason: "reply_already_recorded" };
        }
        this.#setExchange(contractId, event.exchangeId, "human_submitted", "agent_replied", {
          agent_reply_ref: event.messageId,
        });
        return { status: "applied", effect: "agent_replied", exchangeState: "agent_replied" };
      }
      case "agent_checkpoint": {
        if (row.state !== "active" && !inGrace) {
          return { status: "refused", reason: "admission_closed" };
        }
        if (exchange.state === "earned") return { status: "not_payable", reason: "already_earned" };
        if (exchange.state !== "agent_replied")
          return { status: "refused", reason: "reply_missing" };
        this.#setExchange(contractId, event.exchangeId, "agent_replied", "checkpointed", {
          checkpoint_ref: event.checkpointRef,
        });
        const acquired = this.#db
          .prepare(
            "INSERT OR IGNORE INTO acquisitions (contract_id, exchange_id, rule_version, acquired_at) VALUES (?, ?, ?, ?)",
          )
          .run(contractId, event.exchangeId, row.contract.countingRuleVersion, this.#ts());
        if (acquired.changes !== 1) throw new AdviceError("conflict", "acquisition déjà inscrite");
        this.#setExchange(contractId, event.exchangeId, "checkpointed", "earned", {
          earned_at: this.#ts(),
        });
        return { status: "applied", effect: "exchange_earned", exchangeState: "earned" };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Clôture, approbation, préparation du règlement

  /**
   * Ferme l'admission (watermark). Idempotente : une seconde demande retourne la même
   * clôture, avec son motif d'origine. N'efface aucun échange acquis.
   */
  close(
    contractId: ContractId,
    reason: CloseReason,
  ): { status: "closed" | "already_closed"; closeReason: CloseReason } {
    return immediate(this.#db, () => {
      const row = this.#row(contractId);
      if (row.close_reason !== null)
        return { status: "already_closed", closeReason: row.close_reason };
      if (row.state !== "active") {
        throw new AdviceError("invalid_transition", `clôture impossible depuis ${row.state}`);
      }
      this.#db
        .prepare("UPDATE contracts SET close_reason = ?, closed_at = ? WHERE contract_id = ?")
        .run(reason, this.#ts(), contractId);
      for (const x of this.#db
        .prepare<[string], ExchangeRow>(
          "SELECT exchange_id, seq, state FROM exchanges WHERE contract_id = ? AND state = 'opened'",
        )
        .all(contractId)) {
        this.#setExchange(contractId, x.exchange_id, "opened", "void", {
          void_reason: "no_human_contribution_before_close",
        });
      }
      this.#transition(contractId, "submitted", `clôture : ${reason}`, { closeReason: reason });
      return { status: "closed", closeReason: reason };
    });
  }

  /**
   * Validation backend sous mandat (pas un bouton, pas une approbation du modèle) :
   * fige le compteur une seule fois, inscrit le dû et libère l'excédent.
   */
  approve(contractId: ContractId): { earnedExchanges: number; principalDue: bigint } {
    return immediate(this.#db, () => {
      const row = this.#row(contractId);
      if (row.earned_exchanges !== null && row.principal_due !== null) {
        return {
          earnedExchanges: row.earned_exchanges,
          principalDue: parseAmount(row.principal_due),
        };
      }
      if (row.state !== "submitted" || row.closed_at === null) {
        throw new AdviceError("invalid_transition", `approbation impossible depuis ${row.state}`);
      }
      const contract = row.contract;
      const pending = this.#db
        .prepare<[string], ExchangeRow>(
          "SELECT exchange_id, seq, state FROM exchanges WHERE contract_id = ? AND state IN ('human_submitted', 'agent_replied')",
        )
        .all(contractId);
      if (pending.length > 0) {
        if (this.#now() <= Date.parse(row.closed_at) + contract.closeGraceMs) {
          throw new AdviceError(
            "grace_pending",
            "unités admises en attente de réponse ou sauvegarde",
          );
        }
        for (const x of pending) {
          // Travail humain possiblement fourni mais non attesté jusqu'au bout : non compté
          // automatiquement, signalé pour une résolution séparée.
          this.#setExchange(contractId, x.exchange_id, x.state, "void", {
            void_reason: "incomplete_after_grace_needs_review",
          });
        }
      }
      const earned =
        this.#db
          .prepare<[string], { n: number }>(
            "SELECT COUNT(*) AS n FROM acquisitions WHERE contract_id = ?",
          )
          .get(contractId)?.n ?? 0;
      if (earned > contract.maxExchanges) {
        throw new AdviceError("counter_out_of_bounds", "compteur au-delà du maximum contractuel");
      }
      const due = multiplyAmount(contract.unitPrice, earned, "montant dû");
      const reservation = this.#db
        .prepare<[string], { amount: string }>(
          "SELECT amount FROM reservations WHERE contract_id = ?",
        )
        .get(contractId);
      const reserved = parseAmount(reservation?.amount ?? "0");
      if (due > reserved || due > contract.maxPrincipal) {
        throw new AdviceError("due_exceeds_reservation", "montant dû au-delà de la réservation");
      }
      const excess = reserved - due;
      postEntry(this.#db, {
        opKey: `approve:${contractId}`,
        kind: "approve",
        contractId,
        lines: [
          [accounts.reserved(contract.poolId), -reserved],
          [accounts.due(contract.poolId), due],
          [accounts.available(contract.poolId), excess],
        ],
        at: this.#ts(),
      });
      this.#reduceMandateUsage(contract, excess);
      this.#setReservation(
        contractId,
        due === 0n ? "released" : excess > 0n ? "partially_released" : "held",
        excess,
      );
      this.#db
        .prepare(
          "UPDATE contracts SET earned_exchanges = ?, principal_due = ? WHERE contract_id = ?",
        )
        .run(earned, formatAmount(due), contractId);
      this.#transition(contractId, "approved", "compteur figé sous mandat", {
        earnedExchanges: earned,
        principalDue: formatAmount(due),
        released: formatAmount(excess),
      });
      return { earnedExchanges: earned, principalDue: due };
    });
  }

  #expectedPayload(contract: SessionContract, digest: string, due: bigint): TransferPayload {
    return {
      simulated: true,
      settlementId: `stl-${contract.contractId}`,
      contractId: contract.contractId,
      contractDigest: digest,
      guidePrincipalId: contract.guidePrincipalId,
      recipientBindingVersion: contract.recipientBindingVersion,
      assetId: contract.assetId,
      networkId: contract.networkId,
      amount: formatAmount(due),
    };
  }

  /**
   * Inscrit en une transaction le dû, l'intention immuable et l'événement d'outbox. Rien
   * n'est émis ici. Si rien n'est dû, la séance est clôturée sans transfert.
   */
  prepareSettlement(contractId: ContractId): {
    status: "prepared" | "already_prepared" | "settled_without_transfer";
    settlementId: SettlementId | null;
  } {
    const result = immediate(this.#db, () => {
      const row = this.#row(contractId);
      const existing = this.#db
        .prepare<[string], { settlement_id: SettlementId }>(
          "SELECT settlement_id FROM settlement_intents WHERE contract_id = ?",
        )
        .get(contractId);
      if (existing !== undefined) {
        return { status: "already_prepared" as const, settlementId: existing.settlement_id };
      }
      if (row.state === "settled")
        return { status: "settled_without_transfer" as const, settlementId: null };
      if (row.state !== "approved" || row.principal_due === null) {
        throw new AdviceError("invalid_transition", `préparation impossible depuis ${row.state}`);
      }
      if (this.isFrozen()) throw new AdviceError("frozen", "gel d'urgence : préparation suspendue");
      const due = parseAmount(row.principal_due);
      if (due === 0n) {
        this.#transition(contractId, "settled", "aucun échange dû : clôture sans transfert");
        this.#storeReceipt(contractId);
        return { status: "settled_without_transfer" as const, settlementId: null };
      }
      const payload = this.#expectedPayload(row.contract, row.digest, due);
      const body = canonicalJson(payload);
      const settlementId = payload.settlementId as SettlementId;
      this.#db
        .prepare(
          `INSERT INTO settlement_intents (settlement_id, contract_id, settlement_kind, payload, payload_digest, state, created_at, updated_at)
           VALUES (?, ?, 'initial', ?, ?, 'prepared', ?, ?)`,
        )
        .run(settlementId, contractId, body, sha256(body), this.#ts(), this.#ts());
      this.#db
        .prepare(
          "INSERT INTO outbox (topic, dedupe_key, payload, state, created_at) VALUES ('settlement', ?, ?, 'pending', ?)",
        )
        .run(`settlement:${contractId}:initial`, JSON.stringify({ settlementId }), this.#ts());
      this.#transition(contractId, "settlement_pending", "intention de règlement simulé préparée", {
        settlementId,
        amount: payload.amount,
      });
      this.#hook("prepare:in_txn");
      return { status: "prepared" as const, settlementId };
    });
    this.#hook("prepare:after_commit");
    return result;
  }

  // -------------------------------------------------------------------------
  // Worker de règlement : outbox, bail, fencing, rapprochement avant émission

  #lease(outboxId: number, workerId: string): number | null {
    return immediate(this.#db, () => {
      const now = this.#now();
      const { changes } = this.#db
        .prepare(
          `UPDATE outbox SET lease_owner = ?, lease_until = ?, fencing_token = fencing_token + 1
           WHERE outbox_id = ? AND state = 'pending' AND (lease_until IS NULL OR lease_until < ?)`,
        )
        .run(workerId, now + this.#leaseMs, outboxId, now);
      if (changes !== 1) return null;
      return (
        this.#db
          .prepare<[number], { fencing_token: number }>(
            "SELECT fencing_token FROM outbox WHERE outbox_id = ?",
          )
          .get(outboxId)?.fencing_token ?? null
      );
    });
  }

  /** Écrit seulement si ce worker détient encore le jeton courant (fencing). */
  #fenced<T>(outboxId: number, token: number, fn: () => T): T {
    return immediate(this.#db, () => {
      const row = this.#db
        .prepare<[number], { fencing_token: number; state: string }>(
          "SELECT fencing_token, state FROM outbox WHERE outbox_id = ?",
        )
        .get(outboxId);
      if (row?.fencing_token !== token || row.state !== "pending") {
        throw new StaleLeaseError("jeton de fencing périmé");
      }
      return fn();
    });
  }

  #intent(settlementId: string): IntentRow {
    const row = this.#db
      .prepare<[string], IntentRow>("SELECT * FROM settlement_intents WHERE settlement_id = ?")
      .get(settlementId);
    if (row === undefined) throw new AdviceError("unknown_settlement", "intention inconnue");
    return row;
  }

  #setIntent(
    settlementId: string,
    to: SettlementState,
    extra: { frozenReason?: string; externalRef?: string } = {},
  ): void {
    const from = this.#intent(settlementId);
    this.#db
      .prepare(
        "UPDATE settlement_intents SET state = ?, frozen_reason = COALESCE(?, frozen_reason), external_ref = COALESCE(?, external_ref), updated_at = ? WHERE settlement_id = ?",
      )
      .run(to, extra.frozenReason ?? null, extra.externalRef ?? null, this.#ts(), settlementId);
    this.#journal({
      contractId: from.contract_id,
      kind: "settlement_transition",
      from: from.state,
      to,
      reason: extra.frozenReason ?? `règlement simulé : ${to}`,
      metadata: { settlementId, externalRef: extra.externalRef ?? from.external_ref },
    });
  }

  /**
   * Traite les événements d'outbox en attente. Plusieurs workers peuvent tourner en
   * parallèle : le bail et le jeton de fencing empêchent un worker périmé d'écrire, et
   * le rail simulé refuse un jeton plus ancien.
   */
  async runWorker(workerId: string): Promise<WorkerReport> {
    assertOpaqueId(workerId, "workerId");
    const handled: { outboxId: number; result: string }[] = [];
    const rows = this.#db
      .prepare<[], OutboxRow>(
        "SELECT outbox_id, topic, dedupe_key, payload FROM outbox WHERE state = 'pending' ORDER BY outbox_id",
      )
      .all();
    for (const row of rows) {
      const token = this.#lease(row.outbox_id, workerId);
      if (token === null) {
        handled.push({ outboxId: row.outbox_id, result: "not_leased" });
        continue;
      }
      this.#hook("worker:after_lease");
      try {
        const result =
          row.topic === "settlement"
            ? await this.#processSettlement(row, token, workerId)
            : await this.#processNotification(row, token);
        // Libère le bail d'un événement non terminé : un autre passage pourra reprendre,
        // avec un nouveau jeton.
        immediate(this.#db, () => {
          this.#db
            .prepare(
              "UPDATE outbox SET lease_owner = NULL, lease_until = NULL WHERE outbox_id = ? AND fencing_token = ? AND state = 'pending'",
            )
            .run(row.outbox_id, token);
        });
        handled.push({ outboxId: row.outbox_id, result });
      } catch (error) {
        if (error instanceof StaleLeaseError) {
          handled.push({ outboxId: row.outbox_id, result: "stale_lease" });
          continue;
        }
        throw error;
      }
    }
    return { workerId, handled };
  }

  async #processNotification(row: OutboxRow, token: number): Promise<string> {
    const { dedupeKey, payload } = JSON.parse(row.payload) as {
      dedupeKey: string;
      payload: unknown;
    };
    const sent = await this.#rail.notify(dedupeKey, payload);
    this.#hook("notify:after_send");
    this.#fenced(row.outbox_id, token, () => {
      this.#db
        .prepare("UPDATE outbox SET state = 'done', done_at = ? WHERE outbox_id = ?")
        .run(this.#ts(), row.outbox_id);
    });
    return `notification_${sent}`;
  }

  async #processSettlement(row: OutboxRow, token: number, workerId: string): Promise<string> {
    const { settlementId } = JSON.parse(row.payload) as { settlementId: SettlementId };
    for (let step = 0; step < 8; step += 1) {
      // Un worker qui a perdu son bail ne lit plus ni ne rapporte un état comme le sien.
      this.#fenced(row.outbox_id, token, () => undefined);
      const intent = this.#intent(settlementId);
      const frozen = this.isFrozen();
      switch (intent.state) {
        case "finalized":
          return "finalized";
        case "frozen":
        case "failed_definitive":
          return intent.state;
        case "prepared": {
          if (frozen) return "frozen_globally";
          this.#fenced(row.outbox_id, token, () => {
            const problem = this.#authorizationProblem(intent);
            if (problem === null) this.#setIntent(settlementId, "authorized");
            else
              this.#setIntent(settlementId, "frozen", {
                frozenReason: `autorisation refusée : ${problem}`,
              });
          });
          continue;
        }
        case "authorized": {
          if (frozen) return "frozen_globally";
          this.#fenced(row.outbox_id, token, () => {
            this.#db
              .prepare(
                "INSERT INTO transfer_attempts (settlement_id, fencing_token, worker_id, state, started_at, updated_at) VALUES (?, ?, ?, 'submission_pending', ?, ?)",
              )
              .run(settlementId, token, workerId, this.#ts(), this.#ts());
            this.#setIntent(settlementId, "submission_pending");
          });
          this.#hook("worker:after_submission_pending");
          const submitted = await this.#submit(row, token, intent);
          if (submitted !== "accepted") return submitted;
          continue;
        }
        case "submission_pending":
        case "unknown": {
          // Rapprochement d'un statut incertain avant toute nouvelle émission.
          const lookup = await this.#lookup(row, token, intent);
          if (lookup === "unavailable") return "lookup_unavailable";
          if (lookup === "found") continue;
          if (lookup === "mismatch") return "frozen";
          const firstAttempt = this.#db
            .prepare<[string], { started: string | null }>(
              "SELECT MIN(started_at) AS started FROM transfer_attempts WHERE settlement_id = ?",
            )
            .get(settlementId)?.started;
          const retention = this.#rail.capabilities().lookupRetentionMs;
          if (firstAttempt == null || this.#now() - Date.parse(firstAttempt) >= retention) {
            // L'absence n'est plus probante : la clé a pu être oubliée par le rail.
            this.#fenced(row.outbox_id, token, () => {
              this.#setIntent(settlementId, "frozen", {
                frozenReason:
                  "statut irrésoluble : fenêtre d'idempotence expirée, aucune réémission",
              });
              this.#setReservation(intent.contract_id, "uncertain");
            });
            return "frozen";
          }
          // Absence probante : aucun transfert n'a eu lieu.
          this.#fenced(row.outbox_id, token, () => {
            this.#db
              .prepare(
                "UPDATE transfer_attempts SET state = 'not_submitted', updated_at = ? WHERE settlement_id = ? AND state IN ('submission_pending', 'unknown')",
              )
              .run(this.#ts(), settlementId);
            this.#setIntent(settlementId, "authorized");
          });
          continue;
        }
        case "submitted":
        case "confirming": {
          const found = await this.#safeLookup(intent.settlement_id);
          if (found === "unavailable") return "lookup_unavailable";
          if (found.status === "not_found") {
            this.#fenced(row.outbox_id, token, () => {
              this.#setIntent(settlementId, "frozen", {
                frozenReason: "transfert accepté introuvable : rapprochement manuel requis",
              });
            });
            return "frozen";
          }
          if (found.state !== "finalized") return "awaiting_finality";
          this.#finalize(row, token, intent);
          this.#hook("worker:after_finalize");
          return "finalized";
        }
      }
    }
    return "step_limit";
  }

  /** Vérification indépendante du payload contre le contrat figé et le mandat. */
  #authorizationProblem(intent: IntentRow): string | null {
    const row = this.#row(intent.contract_id);
    if (row.principal_due === null) return "montant dû absent";
    const expected = canonicalJson(
      this.#expectedPayload(
        row.contract,
        contractDigest(row.contract),
        parseAmount(row.principal_due),
      ),
    );
    if (row.digest !== contractDigest(row.contract)) return "digest du contrat altéré";
    if (expected !== intent.payload || sha256(intent.payload) !== intent.payload_digest) {
      return "payload différent du contrat (bénéficiaire, montant ou actif)";
    }
    const { mandate } = this.#mandate(row.contract.mandateId, row.contract.mandateVersion);
    if (parseAmount(row.principal_due) > mandate.perSessionCap)
      return "au-delà du plafond par séance";
    return null;
  }

  async #submit(row: OutboxRow, token: number, intent: IntentRow): Promise<string> {
    const payload = JSON.parse(intent.payload) as TransferPayload;
    let result;
    try {
      result = await this.#rail.submit(intent.settlement_id, payload, token);
    } catch (error) {
      if (error instanceof SettlementTimeoutError) {
        this.#fenced(row.outbox_id, token, () => {
          this.#db
            .prepare(
              "UPDATE transfer_attempts SET state = 'unknown', updated_at = ? WHERE settlement_id = ? AND state = 'submission_pending'",
            )
            .run(this.#ts(), intent.settlement_id);
          this.#setIntent(intent.settlement_id, "unknown");
          this.#setReservation(intent.contract_id, "uncertain");
        });
        return "unknown_after_timeout";
      }
      throw error;
    }
    if (result.status === "rejected") {
      if (result.reason === "stale_fencing_token")
        throw new StaleLeaseError("jeton refusé par le rail");
      this.#fenced(row.outbox_id, token, () => {
        this.#setIntent(intent.settlement_id, "frozen", {
          frozenReason: `rail simulé : ${result.reason}`,
        });
      });
      return "frozen";
    }
    this.#hook("worker:after_rail_submit");
    this.#fenced(row.outbox_id, token, () => {
      this.#recordAccepted(intent, result.externalRef);
    });
    return "accepted";
  }

  #recordAccepted(intent: IntentRow, externalRef: string): void {
    const row = this.#row(intent.contract_id);
    const amount = parseAmount(row.principal_due ?? "0");
    this.#db
      .prepare(
        "UPDATE transfer_attempts SET state = 'accepted', updated_at = ? WHERE settlement_id = ? AND state IN ('submission_pending', 'unknown')",
      )
      .run(this.#ts(), intent.settlement_id);
    this.#setIntent(intent.settlement_id, "submitted", { externalRef });
    postEntry(this.#db, {
      opKey: `settling:${intent.settlement_id}`,
      kind: "settling",
      contractId: intent.contract_id,
      lines: [
        [accounts.due(row.contract.poolId), -amount],
        [accounts.settling(row.contract.poolId), amount],
      ],
      at: this.#ts(),
    });
    this.#setIntent(intent.settlement_id, "confirming");
    // Statut rapproché : la réservation n'est plus incertaine, le dû reste immobilisé.
    const released = parseAmount(
      this.#db
        .prepare<[string], { released: string }>(
          "SELECT released FROM reservations WHERE contract_id = ?",
        )
        .get(intent.contract_id)?.released ?? "0",
    );
    this.#setReservation(intent.contract_id, released > 0n ? "partially_released" : "held");
  }

  async #safeLookup(settlementId: string) {
    try {
      return await this.#rail.lookup(settlementId);
    } catch (error) {
      if (error instanceof SettlementUnavailableError) return "unavailable" as const;
      throw error;
    }
  }

  async #lookup(
    row: OutboxRow,
    token: number,
    intent: IntentRow,
  ): Promise<"found" | "not_found" | "unavailable" | "mismatch"> {
    const found = await this.#safeLookup(intent.settlement_id);
    if (found === "unavailable") {
      this.#fenced(row.outbox_id, token, () => {
        if (intent.state !== "unknown") this.#setIntent(intent.settlement_id, "unknown");
        this.#setReservation(intent.contract_id, "uncertain");
      });
      return "unavailable";
    }
    if (found.status === "not_found") return "not_found";
    if (found.payloadDigest !== intent.payload_digest) {
      this.#fenced(row.outbox_id, token, () => {
        this.#setIntent(intent.settlement_id, "frozen", {
          frozenReason: "payload externe différent",
        });
      });
      return "mismatch";
    }
    this.#fenced(row.outbox_id, token, () => {
      this.#recordAccepted(intent, found.externalRef);
    });
    return "found";
  }

  #finalize(row: OutboxRow, token: number, intent: IntentRow): void {
    this.#fenced(row.outbox_id, token, () => {
      const contractRow = this.#row(intent.contract_id);
      const amount = parseAmount(contractRow.principal_due ?? "0");
      postEntry(this.#db, {
        opKey: `finalize:${intent.settlement_id}`,
        kind: "finalize_simulated",
        contractId: intent.contract_id,
        lines: [
          [accounts.settling(contractRow.contract.poolId), -amount],
          [accounts.guideSettled(contractRow.contract.guidePrincipalId), amount],
        ],
        at: this.#ts(),
      });
      this.#setIntent(intent.settlement_id, "finalized");
      this.#setReservation(intent.contract_id, "consumed");
      this.#transition(
        intent.contract_id,
        "settled",
        "règlement SIMULÉ finalisé par l'adapter simulé",
      );
      const receipt = this.#storeReceipt(intent.contract_id);
      this.#db
        .prepare("UPDATE outbox SET state = 'done', done_at = ? WHERE outbox_id = ?")
        .run(this.#ts(), row.outbox_id);
      const dedupeKey = `notify:${intent.settlement_id}:settled_simulated:guide`;
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO outbox (topic, dedupe_key, payload, state, created_at) VALUES ('notification', ?, ?, 'pending', ?)",
        )
        .run(dedupeKey, JSON.stringify({ dedupeKey, payload: receipt }), this.#ts());
    });
  }

  // -------------------------------------------------------------------------
  // Expirations et inactivité

  /** Tâche bornée et déterministe : expirations techniques et clôtures d'inactivité. */
  sweep(): { expired: ContractId[]; closedForInactivity: ContractId[] } {
    const expired: ContractId[] = [];
    const closed: ContractId[] = [];
    const candidates = this.#db
      .prepare<[], { contract_id: ContractId }>(
        "SELECT contract_id FROM contracts WHERE state IN ('offered', 'accepted', 'reserved', 'active')",
      )
      .all();
    for (const { contract_id: id } of candidates) {
      immediate(this.#db, () => {
        const row = this.#row(id);
        if (this.#expireIfPastDeadline(row)) {
          expired.push(id);
        }
      });
      const row = this.#row(id);
      if (
        row.state === "active" &&
        this.#now() >= Date.parse(row.last_activity_at) + row.contract.inactivityTimeoutMs
      ) {
        this.close(id, "inactivity_expired");
        closed.push(id);
      }
    }
    return { expired, closedForInactivity: closed };
  }

  // -------------------------------------------------------------------------
  // Lecture et reçu

  status(contractId: ContractId): ContractStatus {
    const row = this.#row(contractId);
    const res = this.#db
      .prepare<[string], { state: ReservationState; amount: string; released: string }>(
        "SELECT state, amount, released FROM reservations WHERE contract_id = ?",
      )
      .get(contractId);
    const intent = this.#db
      .prepare<[string], IntentRow>("SELECT * FROM settlement_intents WHERE contract_id = ?")
      .get(contractId);
    return {
      contract: row.contract,
      digest: row.digest,
      state: row.state,
      closeReason: row.close_reason,
      earnedExchanges: row.earned_exchanges,
      principalDue: row.principal_due === null ? null : parseAmount(row.principal_due),
      reservation:
        res === undefined
          ? null
          : {
              state: res.state,
              amount: parseAmount(res.amount),
              released: parseAmount(res.released),
            },
      settlement:
        intent === undefined
          ? null
          : {
              settlementId: intent.settlement_id,
              state: intent.state,
              frozenReason: intent.frozen_reason,
              externalRef: intent.external_ref,
            },
      label: SIMULATION_LABEL,
    };
  }

  exchanges(contractId: ContractId): { exchangeId: string; seq: number; state: ExchangeState }[] {
    return this.#db
      .prepare<[string], ExchangeRow>(
        "SELECT exchange_id, seq, state FROM exchanges WHERE contract_id = ? ORDER BY seq",
      )
      .all(contractId)
      .map((x) => ({ exchangeId: x.exchange_id, seq: x.seq, state: x.state }));
  }

  /** Reçu courant ; jamais de contenu de conversation. */
  receipt(contractId: ContractId): Receipt {
    const stored = this.#db
      .prepare<[string], { body: string }>("SELECT body FROM receipts WHERE contract_id = ?")
      .get(contractId);
    if (stored !== undefined) return JSON.parse(stored.body) as Receipt;
    return this.#buildReceipt(contractId);
  }

  #buildReceipt(contractId: ContractId): Receipt {
    const status = this.status(contractId);
    const row = this.#row(contractId);
    return buildReceipt(status, row.closed_at);
  }

  #storeReceipt(contractId: ContractId): Receipt {
    const receipt = this.#buildReceipt(contractId);
    this.#db
      .prepare("INSERT OR IGNORE INTO receipts (contract_id, body, created_at) VALUES (?, ?, ?)")
      .run(contractId, JSON.stringify(receipt), this.#ts());
    return receipt;
  }
}
