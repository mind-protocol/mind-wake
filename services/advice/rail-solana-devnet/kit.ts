/**
 * Kit de test devnet : clés de test locales, SOL de faucet devnet et mint Token-2022 qui
 * reproduit le profil de $MIND (9 décimales, frais de 1 %, plafond de frais non contraignant).
 *
 * Tout est stocké dans `.local/solana-devnet/kit.json` (ignoré par git). Ces clés n'ont de
 * sens que sur devnet ; ne jamais y placer une clé réelle. Relancer est idempotent.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  extension,
  fetchMaybeMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getInitializeTransferFeeConfigInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";

import { DEVNET_GENESIS_HASH } from "./rail.js";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_KIT_PATH = ".local/solana-devnet/kit.json";

/** Profil de $MIND mainnet (TRANSACTIONS.md §19.1), reproduit sur le mint de test. */
export const MIND_PROFILE = {
  decimals: 9,
  transferFeeBasisPoints: 100,
  maximumFee: 1_000_000_000_000_000_000n,
  supply: 1_000_000n * 10n ** 9n,
} as const;

export interface DevnetKit {
  readonly rpcUrl: string;
  /** Clés privées de test (32 octets, hexadécimal). */
  readonly payerSeedHex: string;
  readonly mintSeedHex: string;
  readonly recipientSeedHex: string;
  readonly mint: string;
  readonly payer: string;
  readonly recipient: string;
}

export function loadKit(path = DEFAULT_KIT_PATH): DevnetKit | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DevnetKit;
  } catch {
    return undefined;
  }
}

export function seedBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("graine de test invalide");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Le faucet RPC a refusé : financer le payeur à la main sur devnet, puis relancer. */
export class KitFundingError extends Error {
  override readonly name = "KitFundingError";
  readonly payer: string;
  constructor(payer: string, cause: unknown) {
    super(
      `airdrop devnet refusé (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Envoyer au moins 0,2 SOL devnet à ${payer} (https://faucet.solana.com, réseau devnet), puis relancer.`,
    );
    this.payer = payer;
  }
}

type Log = (line: string) => void;

export async function ensureKit(
  path = DEFAULT_KIT_PATH,
  rpcUrl = DEVNET_RPC_URL,
  log: Log = () => undefined,
): Promise<DevnetKit> {
  const rpc = createSolanaRpc(rpcUrl);
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new Error(`réseau refusé : genesis ${genesis} n'est pas celui de devnet`);
  }

  const previous = loadKit(path);
  const seeds = {
    payerSeedHex: previous?.payerSeedHex ?? randomBytes(32).toString("hex"),
    mintSeedHex: previous?.mintSeedHex ?? randomBytes(32).toString("hex"),
    recipientSeedHex: previous?.recipientSeedHex ?? randomBytes(32).toString("hex"),
  };
  const payer = await createKeyPairSignerFromPrivateKeyBytes(seedBytes(seeds.payerSeedHex));
  const mint = await createKeyPairSignerFromPrivateKeyBytes(seedBytes(seeds.mintSeedHex));
  const recipient = await createKeyPairSignerFromPrivateKeyBytes(seedBytes(seeds.recipientSeedHex));
  const kit: DevnetKit = {
    rpcUrl,
    ...seeds,
    mint: mint.address,
    payer: payer.address,
    recipient: recipient.address,
  };
  // Écrit avant toute opération réseau : une coupure ne perd pas les clés déjà financées.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(kit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  log(`kit : ${path} (payeur ${payer.address}, destinataire ${recipient.address})`);

  const { value: balance } = await rpc
    .getBalance(payer.address, { commitment: "confirmed" })
    .send();
  if (balance < 200_000_000n) {
    log("airdrop devnet de 1 SOL vers le payeur…");
    try {
      const sig = await rpc
        .requestAirdrop(payer.address, lamports(1_000_000_000n), { commitment: "confirmed" })
        .send();
      await waitConfirmed(rpc, sig);
    } catch (error) {
      throw new KitFundingError(payer.address, error);
    }
  }

  const existing = await fetchMaybeMint(rpc, mint.address, { commitment: "confirmed" });
  if (!existing.exists) {
    log(`création du mint Token-2022 de test ${mint.address}…`);
    const feeExtension = extension("TransferFeeConfig", {
      transferFeeConfigAuthority: payer.address,
      withdrawWithheldAuthority: payer.address,
      withheldAmount: 0n,
      olderTransferFee: {
        epoch: 0n,
        maximumFee: MIND_PROFILE.maximumFee,
        transferFeeBasisPoints: MIND_PROFILE.transferFeeBasisPoints,
      },
      newerTransferFee: {
        epoch: 0n,
        maximumFee: MIND_PROFILE.maximumFee,
        transferFeeBasisPoints: MIND_PROFILE.transferFeeBasisPoints,
      },
    });
    const space = getMintSize([feeExtension]);
    const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    await sendInstructions(rpc, payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeTransferFeeConfigInstruction({
        mint: mint.address,
        transferFeeConfigAuthority: payer.address,
        withdrawWithheldAuthority: payer.address,
        transferFeeBasisPoints: MIND_PROFILE.transferFeeBasisPoints,
        maximumFee: MIND_PROFILE.maximumFee,
      }),
      getInitializeMintInstruction({
        mint: mint.address,
        decimals: MIND_PROFILE.decimals,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
    ]);
  }

  const current = await fetchMaybeMint(rpc, mint.address, { commitment: "confirmed" });
  if (current.exists && current.data.supply === 0n) {
    log("émission de 1 000 000 jetons de test vers le payeur…");
    const [payerAta] = await findAssociatedTokenPda({
      owner: payer.address,
      mint: mint.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    await sendInstructions(rpc, payer, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: payerAta,
        owner: payer.address,
        mint: mint.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getMintToCheckedInstruction({
        mint: mint.address,
        token: payerAta,
        mintAuthority: payer,
        amount: MIND_PROFILE.supply,
        decimals: MIND_PROFILE.decimals,
      }),
    ]);
  }
  log("kit devnet prêt.");
  return kit;
}

type Rpc = ReturnType<typeof createSolanaRpc>;

async function sendInstructions(
  rpc: Rpc,
  payer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<void> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.blockhash),
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
  await waitConfirmed(rpc, getSignatureFromTransaction(signed));
}

async function waitConfirmed(rpc: Rpc, sig: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const { value } = await rpc.getSignatureStatuses([toSignature(sig)]).send();
    const status = value[0];
    if (status?.err != null) throw new Error(`transaction ${sig} en échec`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`transaction ${sig} non confirmée`);
}
