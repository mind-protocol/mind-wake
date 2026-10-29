/**
 * Adapter de règlement Solana **devnet** : intégration de test, jetons sans valeur
 * (AGENTS.md, révision du 29 octobre 2026 ; TRANSACTIONS.md §12, §19.1).
 *
 * Il refuse tout réseau dont le genesis n'est pas celui de devnet, refuse le mint mainnet
 * de $MIND et tout payload marqué simulé. Le service de séances ne l'accepte pas.
 *
 * Idempotence sans clé native côté chaîne :
 * - la transaction est signée puis **persistée avant l'envoi** (signature, octets,
 *   `lastValidBlockHeight`) ; un renvoi réutilise les mêmes octets, donc la même signature ;
 * - une nouvelle transaction n'est construite que lorsque toutes les précédentes ont expiré
 *   (hauteur de bloc dépassée) sans atterrir : elles ne peuvent plus jamais réussir ;
 * - un mémo `k=<sha256(clé)> d=<digest du payload>` permet un rapprochement depuis la chaîne.
 *
 * Le fencing est imposé par la base locale du signataire, pas par la chaîne.
 */

import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedWithFeeInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";

import { canonicalJson, sha256 } from "../session/contract.js";
import { openSqlite, type AdviceDatabase } from "../session/db.js";
import {
  SettlementTimeoutError,
  SettlementUnavailableError,
  type LookupResult,
  type SettlementAdapter,
  type SettlementAdapterCapabilities,
  type SubmitResult,
  type TransferPayload,
} from "../session/rail.js";
import {
  activeTransferFee,
  breakdown,
  feeChangePending,
  type FeeMode,
  type TransferBreakdown,
} from "./fees.js";
import { PreflightRefusedError, type SignatureStatus, type SolanaPort } from "./port.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Mint mainnet de $MIND (TRANSACTIONS.md §19.1) : jamais utilisable par cet adapter. */
export const MAINNET_MIND_MINT = "EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p";
export const DEVNET_NETWORK_ID = "solana-devnet";
export const DEVNET_LABEL = "TEST DEVNET — jetons de test sans valeur, aucun paiement réel";
const MEMO_PREFIX = "mind-wake/devnet-test/v1";

export class DevnetGuardError extends Error {
  override readonly name = "DevnetGuardError";
}

export interface DevnetRailOptions {
  readonly port: SolanaPort;
  /** Base locale de l'adapter (tentatives, fencing) ; fichier distinct du service. */
  readonly dbPath: string;
  /** Clé privée de test (32 octets) du payeur et propriétaire de la source. */
  readonly signerSeed: Uint8Array;
  readonly mint: string;
  readonly decimals: number;
  readonly expectedFeeBasisPoints: number;
  readonly feeMode: FeeMode;
  /** Résolution du bénéficiaire (TRANSACTIONS §4) ; `undefined` si aucune liaison vérifiée. */
  readonly resolveRecipient: (
    guidePrincipalId: string,
    bindingVersion: string,
  ) => string | undefined;
  /** Garde-fou : brut maximal d'un transfert, en unités de base. */
  readonly perTransferCap: bigint;
  readonly lookupRetentionMs?: number;
  /** Délai maximal d'attente de confirmation dans `submit`. */
  readonly confirmTimeoutMs?: number;
  readonly pollMs?: number;
  /** Nombre maximal de transactions successives (après expiration) par `submit`. */
  readonly maxAttempts?: number;
  /** Profondeur de la recherche par mémo. */
  readonly memoScanLimit?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  key TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  max_fencing_token INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  gross TEXT NOT NULL,
  fee TEXT NOT NULL,
  net TEXT NOT NULL,
  basis_points INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  label TEXT NOT NULL
) STRICT;
-- Tentatives signées, persistées AVANT l'envoi ; jamais supprimées.
CREATE TABLE IF NOT EXISTS attempts (
  signature TEXT PRIMARY KEY,
  key TEXT NOT NULL REFERENCES transfers(key),
  wire_base64 TEXT NOT NULL,
  memo TEXT NOT NULL,
  last_valid_block_height TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS attempts_by_key ON attempts(key, created_at_ms);
CREATE TABLE IF NOT EXISTS notifications (
  dedupe_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  label TEXT NOT NULL
) STRICT;
`;

interface TransferRow {
  key: string;
  payload_digest: string;
  max_fencing_token: number;
  recipient: string;
  gross: string;
  fee: string;
  net: string;
  basis_points: number;
}

interface AttemptRow {
  signature: string;
  wire_base64: string;
  memo: string;
  last_valid_block_height: string;
}

export interface DevnetTransferDetails extends TransferBreakdown {
  readonly key: string;
  readonly recipient: string;
  readonly signatures: readonly string[];
  readonly label: string;
}

const AMOUNT = /^(0|[1-9][0-9]*)$/;

export class SolanaDevnetRail implements SettlementAdapter {
  readonly #db: AdviceDatabase;
  readonly #port: SolanaPort;
  readonly #signer: KeyPairSigner;
  readonly #sourceAta: Address;
  readonly #options: DevnetRailOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retentionMs: number;

  private constructor(options: DevnetRailOptions, signer: KeyPairSigner, sourceAta: Address) {
    this.#options = options;
    this.#port = options.port;
    this.#signer = signer;
    this.#sourceAta = sourceAta;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#retentionMs = options.lookupRetentionMs ?? 7 * 24 * 3_600_000;
    this.#db = openSqlite(options.dbPath);
    this.#db.exec(SCHEMA);
  }

  /** Vérifie le réseau et le mint avant toute écriture locale. */
  static async open(options: DevnetRailOptions): Promise<SolanaDevnetRail> {
    if (options.mint === MAINNET_MIND_MINT) {
      throw new DevnetGuardError("mint mainnet de $MIND refusé : adapter devnet uniquement");
    }
    const genesis = await options.port.genesisHash();
    if (genesis !== DEVNET_GENESIS_HASH) {
      throw new DevnetGuardError(`réseau refusé : genesis ${genesis} n'est pas celui de devnet`);
    }
    const mint = await options.port.mint(options.mint);
    if (mint === null) throw new DevnetGuardError("mint introuvable sur devnet");
    if (mint.programAddress !== (TOKEN_2022_PROGRAM_ADDRESS as string)) {
      throw new DevnetGuardError("le mint n'appartient pas au programme Token-2022");
    }
    if (mint.decimals !== options.decimals) {
      throw new DevnetGuardError(
        `décimales ${String(mint.decimals)} ≠ ${String(options.decimals)}`,
      );
    }
    if (mint.transferFee === null) {
      throw new DevnetGuardError(
        "extension TransferFeeConfig absente : profil $MIND non reproduit",
      );
    }
    if (mint.transferHookProgram !== null) {
      throw new DevnetGuardError("transfer hook présent : non pris en charge");
    }
    if (options.perTransferCap <= 0n) throw new DevnetGuardError("plafond par transfert requis");
    const signer = await createKeyPairSignerFromPrivateKeyBytes(options.signerSeed);
    const [sourceAta] = await findAssociatedTokenPda({
      owner: signer.address,
      mint: address(options.mint),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    return new SolanaDevnetRail(options, signer, sourceAta);
  }

  get signerAddress(): string {
    return this.#signer.address;
  }

  get sourceTokenAccount(): string {
    return this.#sourceAta;
  }

  close(): void {
    this.#db.close();
  }

  capabilities(): SettlementAdapterCapabilities {
    return {
      simulated: false,
      label: DEVNET_LABEL,
      lookupRetentionMs: this.#retentionMs,
      fencing: true,
    };
  }

  async submit(key: string, payload: TransferPayload, fencingToken: number): Promise<SubmitResult> {
    const problem = this.#payloadProblem(payload);
    if (problem !== null) return { status: "rejected", reason: problem };
    const recipient = this.#options.resolveRecipient(
      payload.guidePrincipalId,
      payload.recipientBindingVersion,
    );
    if (recipient === undefined) return { status: "rejected", reason: "recipient_unresolved" };
    const digest = sha256(canonicalJson(payload));

    let fee: TransferBreakdown;
    try {
      fee = await this.#currentBreakdown(BigInt(payload.amount));
    } catch (error) {
      if (error instanceof FeeChangedError) return { status: "rejected", reason: "fee_changed" };
      throw new SettlementTimeoutError(`devnet : lecture du mint impossible (${describe(error)})`);
    }

    const recorded = this.#record(key, digest, fencingToken, recipient, fee);
    if (recorded !== "ok") return { status: "rejected", reason: recorded };
    // Un transfert déjà enregistré garde son brut et ses frais. Si le taux a changé depuis,
    // `#currentBreakdown` a déjà refusé ; une tentative ancienne encore valide échouerait
    // on-chain, Token-2022 vérifiant que les frais déclarés correspondent au taux en vigueur.
    const row = this.#transfer(key);
    if (row === undefined) throw new Error("transfert non enregistré");

    const deadline = this.#now() + (this.#options.confirmTimeoutMs ?? 90_000);
    const maxAttempts = this.#options.maxAttempts ?? 3;
    for (let built = 0; ;) {
      const pending = await this.#reconcileAttempts(key);
      if (pending.status === "landed")
        return { status: "accepted", externalRef: pending.signature };
      let attempt: AttemptRow;
      if (pending.status === "valid") {
        attempt = pending.attempt;
      } else {
        if (built >= maxAttempts) {
          throw new SettlementTimeoutError("devnet : transactions expirées sans confirmation");
        }
        attempt = await this.#buildAttempt(key, row, digest);
        built += 1;
      }
      try {
        await this.#port.send({
          wireBase64: attempt.wire_base64,
          signature: attempt.signature,
          memo: attempt.memo,
        });
      } catch (error) {
        if (error instanceof PreflightRefusedError) {
          // Non relayée. Une autre copie déjà relayée pourrait encore atterrir : ne rien
          // déclarer tant qu'une tentative reste valide.
          const again = await this.#reconcileAttempts(key);
          if (again.status === "landed")
            return { status: "accepted", externalRef: again.signature };
          if (again.status === "expired") return { status: "rejected", reason: "rail_refused" };
          throw new SettlementTimeoutError(`devnet : refus de simulation, issue incertaine`);
        }
        // Erreur réseau : la transaction a pu être relayée. On poursuit le suivi.
      }
      const outcome = await this.#awaitOutcome(attempt, deadline);
      if (outcome === "landed") return { status: "accepted", externalRef: attempt.signature };
      if (outcome === "deadline") {
        throw new SettlementTimeoutError("devnet : confirmation non obtenue dans le délai");
      }
      // « expired » ou « failed » : la tentative ne réussira jamais ; boucle.
    }
  }

  async lookup(key: string): Promise<LookupResult> {
    const row = this.#transfer(key);
    try {
      if (row !== undefined) {
        const attempts = this.#attempts(key);
        const statuses = await this.#port.statuses(attempts.map((a) => a.signature));
        for (const [index, status] of statuses.entries()) {
          const attempt = attempts[index];
          if (attempt !== undefined && landed(status)) {
            return found(attempt.signature, status, row.payload_digest);
          }
        }
        const { blockHeight } = await this.#port.epochInfo();
        if (attempts.some((a) => BigInt(a.last_valid_block_height) >= blockHeight)) {
          throw new SettlementUnavailableError(
            "devnet : tentative encore valide, issue indéterminée",
          );
        }
      }
      // Rapprochement depuis la chaîne : couvre une base locale perdue ou partielle.
      const entries = await this.#port.memosForAddress(
        this.#sourceAta,
        this.#options.memoScanLimit ?? 1_000,
      );
      const marker = `k=${sha256(key)} `;
      for (const entry of entries) {
        if (entry.failed || entry.memo === null || !entry.memo.includes(marker)) continue;
        if (entry.confirmation !== "confirmed" && entry.confirmation !== "finalized") continue;
        const digest = /d=([0-9a-f]{64})/.exec(entry.memo)?.[1];
        if (digest === undefined) continue;
        return found(entry.signature, { confirmation: entry.confirmation, failed: false }, digest);
      }
      return { status: "not_found" };
    } catch (error) {
      if (error instanceof SettlementUnavailableError) throw error;
      throw new SettlementUnavailableError(`devnet : recherche impossible (${describe(error)})`);
    }
  }

  notify(dedupeKey: string, payload: unknown): Promise<"sent" | "duplicate"> {
    const { changes } = this.#db
      .prepare("INSERT OR IGNORE INTO notifications (dedupe_key, payload, label) VALUES (?, ?, ?)")
      .run(dedupeKey, canonicalJson(payload), DEVNET_LABEL);
    return Promise.resolve(changes === 1 ? "sent" : "duplicate");
  }

  /** Décomposition envoyé / frais / reçu d'un transfert, pour le reçu. */
  details(key: string): DevnetTransferDetails | undefined {
    const row = this.#transfer(key);
    if (row === undefined) return undefined;
    return {
      key,
      recipient: row.recipient,
      gross: BigInt(row.gross),
      fee: BigInt(row.fee),
      net: BigInt(row.net),
      basisPoints: row.basis_points,
      signatures: this.#attempts(key).map((a) => a.signature),
      label: DEVNET_LABEL,
    };
  }

  // -------------------------------------------------------------------------

  #payloadProblem(payload: TransferPayload): "invalid_payload" | null {
    // Le payload vient du stockage local : sa forme est revérifiée à l'exécution.
    const declared: { simulated?: unknown } = payload;
    if (declared.simulated !== false) return "invalid_payload";
    if (typeof payload.amount !== "string" || !AMOUNT.test(payload.amount))
      return "invalid_payload";
    if (payload.networkId !== DEVNET_NETWORK_ID || payload.assetId !== this.#options.mint) {
      return "invalid_payload";
    }
    const amount = BigInt(payload.amount);
    if (amount <= 0n || amount > this.#options.perTransferCap) return "invalid_payload";
    return null;
  }

  async #currentBreakdown(amount: bigint): Promise<TransferBreakdown> {
    const [mint, { epoch }] = await Promise.all([
      this.#port.mint(this.#options.mint),
      this.#port.epochInfo(),
    ]);
    if (mint?.transferFee == null) throw new FeeChangedError();
    if (feeChangePending(mint.transferFee, epoch, this.#options.expectedFeeBasisPoints)) {
      throw new FeeChangedError();
    }
    const result = breakdown(
      amount,
      activeTransferFee(mint.transferFee, epoch),
      this.#options.feeMode,
    );
    if (result.gross > this.#options.perTransferCap) throw new FeeChangedError();
    return result;
  }

  #record(
    key: string,
    digest: string,
    fencingToken: number,
    recipient: string,
    fee: TransferBreakdown,
  ): "ok" | "stale_fencing_token" | "payload_conflict" {
    return this.#db
      .transaction((): "ok" | "stale_fencing_token" | "payload_conflict" => {
        const existing = this.#transfer(key);
        if (existing !== undefined) {
          if (fencingToken < existing.max_fencing_token) return "stale_fencing_token";
          if (existing.payload_digest !== digest) return "payload_conflict";
          this.#db
            .prepare("UPDATE transfers SET max_fencing_token = ? WHERE key = ?")
            .run(fencingToken, key);
          return "ok";
        }
        this.#db
          .prepare(
            "INSERT INTO transfers (key, payload_digest, max_fencing_token, recipient, gross, fee, net, basis_points, created_at_ms, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            key,
            digest,
            fencingToken,
            recipient,
            fee.gross.toString(),
            fee.fee.toString(),
            fee.net.toString(),
            fee.basisPoints,
            this.#now(),
            DEVNET_LABEL,
          );
        return "ok";
      })
      .immediate();
  }

  #transfer(key: string): TransferRow | undefined {
    return this.#db
      .prepare<[string], TransferRow>(
        "SELECT key, payload_digest, max_fencing_token, recipient, gross, fee, net, basis_points FROM transfers WHERE key = ?",
      )
      .get(key);
  }

  #attempts(key: string): AttemptRow[] {
    return this.#db
      .prepare<[string], AttemptRow>(
        "SELECT signature, wire_base64, memo, last_valid_block_height FROM attempts WHERE key = ? ORDER BY created_at_ms, rowid",
      )
      .all(key);
  }

  /** État combiné des tentatives : l'une a atterri, l'une reste valide, ou toutes ont expiré. */
  async #reconcileAttempts(
    key: string,
  ): Promise<
    | { status: "landed"; signature: string }
    | { status: "valid"; attempt: AttemptRow }
    | { status: "expired" }
  > {
    const attempts = this.#attempts(key);
    if (attempts.length === 0) return { status: "expired" };
    const statuses = await this.#port.statuses(attempts.map((a) => a.signature));
    for (const [index, status] of statuses.entries()) {
      const attempt = attempts[index];
      if (attempt !== undefined && landed(status)) {
        return { status: "landed", signature: attempt.signature };
      }
    }
    const { blockHeight } = await this.#port.epochInfo();
    for (const [index, attempt] of attempts.entries()) {
      if (statuses[index]?.failed === true) continue;
      if (BigInt(attempt.last_valid_block_height) >= blockHeight)
        return { status: "valid", attempt };
    }
    return { status: "expired" };
  }

  async #buildAttempt(key: string, row: TransferRow, digest: string): Promise<AttemptRow> {
    const mint = address(this.#options.mint);
    const owner = address(row.recipient);
    const [destination] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const memo = `${MEMO_PREFIX} k=${sha256(key)} d=${digest}`;
    const latest = await this.#port.latestBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.#signer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.blockhash),
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getCreateAssociatedTokenIdempotentInstruction({
              payer: this.#signer,
              ata: destination,
              owner,
              mint,
              tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            }),
            getTransferCheckedWithFeeInstruction({
              source: this.#sourceAta,
              mint,
              destination,
              authority: this.#signer,
              amount: BigInt(row.gross),
              decimals: this.#options.decimals,
              fee: BigInt(row.fee),
            }),
            getAddMemoInstruction({ memo }),
          ],
          m,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const attempt: AttemptRow = {
      signature: getSignatureFromTransaction(signed),
      wire_base64: getBase64EncodedWireTransaction(signed),
      memo,
      last_valid_block_height: latest.lastValidBlockHeight.toString(),
    };
    // Persistée avant l'envoi : après un crash, on renvoie ces octets au lieu d'en signer d'autres.
    this.#db
      .prepare(
        "INSERT INTO attempts (signature, key, wire_base64, memo, last_valid_block_height, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        attempt.signature,
        key,
        attempt.wire_base64,
        attempt.memo,
        attempt.last_valid_block_height,
        this.#now(),
      );
    return attempt;
  }

  async #awaitOutcome(
    attempt: AttemptRow,
    deadline: number,
  ): Promise<"landed" | "failed" | "expired" | "deadline"> {
    const lastValid = BigInt(attempt.last_valid_block_height);
    for (;;) {
      try {
        const [status] = await this.#port.statuses([attempt.signature]);
        if (landed(status)) return "landed";
        if (status?.failed === true) return "failed";
        const { blockHeight } = await this.#port.epochInfo();
        if (blockHeight > lastValid) {
          // Une dernière lecture : elle a pu atterrir juste avant l'expiration.
          const [last] = await this.#port.statuses([attempt.signature]);
          return landed(last) ? "landed" : "expired";
        }
      } catch {
        // Lecture indisponible : on réessaie jusqu'à l'échéance, sans conclure.
      }
      if (this.#now() >= deadline) return "deadline";
      await this.#sleep(this.#options.pollMs ?? 1_000);
    }
  }
}

class FeeChangedError extends Error {}

function landed(status: SignatureStatus | null | undefined): status is SignatureStatus & {
  failed: false;
  confirmation: "confirmed" | "finalized";
} {
  return (
    status != null &&
    !status.failed &&
    (status.confirmation === "confirmed" || status.confirmation === "finalized")
  );
}

function found(signature: string, status: SignatureStatus, payloadDigest: string): LookupResult {
  return {
    status: "found",
    externalRef: signature,
    payloadDigest,
    state: status.confirmation === "finalized" ? "finalized" : "confirming",
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
