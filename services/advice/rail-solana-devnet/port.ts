/**
 * Accès réseau minimal de l'adapter devnet. L'adapter ne parle à Solana qu'à travers ce
 * port : les tests le remplacent par une chaîne factice qui sait perdre, retarder ou
 * expirer une transaction ; l'implémentation réelle enveloppe le RPC de `@solana/kit`.
 */

import {
  address,
  createSolanaRpc,
  isSolanaError,
  lamports,
  signature as toSignature,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  unwrapOption,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { fetchMaybeMint } from "@solana-program/token-2022";

import type { TransferFeeConfig } from "./fees.js";

const NULL_ADDRESS = "11111111111111111111111111111111";

export type Confirmation = "processed" | "confirmed" | "finalized";

export interface MintView {
  readonly programAddress: string;
  readonly decimals: number;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly transferFee: TransferFeeConfig | null;
  /** Programme du transfer hook, s'il y en a un. */
  readonly transferHookProgram: string | null;
}

export interface SignatureStatus {
  readonly confirmation: Confirmation | null;
  /** La transaction a atterri en échec : aucun transfert, la signature ne réussira jamais. */
  readonly failed: boolean;
}

export interface MemoEntry {
  readonly signature: string;
  readonly memo: string | null;
  readonly failed: boolean;
  readonly confirmation: Confirmation | null;
}

export interface SignedTransfer {
  readonly wireBase64: string;
  readonly signature: string;
  /** Texte du mémo inclus, pour une chaîne factice qui ne décode pas la transaction. */
  readonly memo: string;
}

/** Le RPC a refusé la transaction en simulation : elle n'a pas été relayée. */
export class PreflightRefusedError extends Error {
  override readonly name = "PreflightRefusedError";
}

export interface SolanaPort {
  genesisHash(): Promise<string>;
  epochInfo(): Promise<{ epoch: bigint; blockHeight: bigint }>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  mint(mintAddress: string): Promise<MintView | null>;
  /** Lève `PreflightRefusedError` sur refus de simulation ; toute autre erreur = issue inconnue. */
  send(transfer: SignedTransfer): Promise<void>;
  statuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]>;
  /** Signatures récentes touchant un compte, avec leur mémo (le plus récent d'abord). */
  memosForAddress(account: string, limit: number): Promise<MemoEntry[]>;
  requestAirdrop(recipient: string, lamportAmount: bigint): Promise<string>;
}

export function createKitPort(rpcUrl: string, timeoutMs = 15_000): SolanaPort {
  const rpc = createSolanaRpc(rpcUrl);
  const signal = () => AbortSignal.timeout(timeoutMs);
  return {
    async genesisHash() {
      return rpc.getGenesisHash().send({ abortSignal: signal() });
    },
    async epochInfo() {
      const info = await rpc
        .getEpochInfo({ commitment: "confirmed" })
        .send({ abortSignal: signal() });
      return { epoch: info.epoch, blockHeight: info.blockHeight };
    },
    async latestBlockhash() {
      const { value } = await rpc
        .getLatestBlockhash({ commitment: "confirmed" })
        .send({ abortSignal: signal() });
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async mint(mintAddress) {
      const account = await fetchMaybeMint(rpc, address(mintAddress), {
        commitment: "confirmed",
        abortSignal: signal(),
      });
      if (!account.exists) return null;
      const extensions = unwrapOption(account.data.extensions) ?? [];
      let transferFee: TransferFeeConfig | null = null;
      let transferHookProgram: string | null = null;
      for (const extension of extensions) {
        if (extension.__kind === "TransferFeeConfig") {
          transferFee = {
            olderTransferFee: extension.olderTransferFee,
            newerTransferFee: extension.newerTransferFee,
          };
        } else if (extension.__kind === "TransferHook") {
          // Adresse nulle (« 1111…1111 ») : extension présente mais aucun hook configuré.
          transferHookProgram = extension.programId === NULL_ADDRESS ? null : extension.programId;
        }
      }
      return {
        programAddress: account.programAddress,
        decimals: account.data.decimals,
        mintAuthority: unwrapOption(account.data.mintAuthority),
        freezeAuthority: unwrapOption(account.data.freezeAuthority),
        transferFee,
        transferHookProgram,
      };
    },
    async send(transfer) {
      try {
        await rpc
          .sendTransaction(transfer.wireBase64 as Base64EncodedWireTransaction, {
            encoding: "base64",
            preflightCommitment: "confirmed",
            maxRetries: 0n,
          })
          .send({ abortSignal: signal() });
      } catch (error) {
        if (
          isSolanaError(
            error,
            SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
          )
        ) {
          throw new PreflightRefusedError(error.message);
        }
        throw error;
      }
    },
    async statuses(signatures) {
      if (signatures.length === 0) return [];
      const { value } = await rpc
        .getSignatureStatuses(signatures.map(toSignature), { searchTransactionHistory: true })
        .send({ abortSignal: signal() });
      return value.map((status) =>
        status === null
          ? null
          : { confirmation: status.confirmationStatus, failed: status.err !== null },
      );
    },
    async memosForAddress(account, limit) {
      const entries = await rpc
        .getSignaturesForAddress(address(account), { limit, commitment: "confirmed" })
        .send({ abortSignal: signal() });
      return entries.map((entry) => ({
        signature: entry.signature,
        memo: entry.memo,
        failed: entry.err !== null,
        confirmation: entry.confirmationStatus,
      }));
    },
    async requestAirdrop(recipient, lamportAmount) {
      return rpc
        .requestAirdrop(address(recipient), lamports(lamportAmount), { commitment: "confirmed" })
        .send({ abortSignal: signal() });
    },
  };
}
