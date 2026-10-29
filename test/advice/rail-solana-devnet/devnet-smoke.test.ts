/**
 * Fumée réelle sur Solana devnet (opt-in : MIND_WAKE_DEVNET_SMOKE=1). Prépare le kit de
 * test si besoin (faucet devnet, mint Token-2022 à 1 %), puis règle 1 jeton de test vers
 * le destinataire du kit et vérifie frais, idempotence et rapprochement on-chain.
 * Jetons de test sans valeur ; jamais mainnet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, createSolanaRpc } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { afterAll, describe, expect, it } from "vitest";

import {
  createKitPort,
  DEVNET_NETWORK_ID,
  ensureKit,
  MIND_PROFILE,
  seedBytes,
  SolanaDevnetRail,
} from "../../../services/advice/rail-solana-devnet/index.js";

const ENABLED = process.env["MIND_WAKE_DEVNET_SMOKE"] === "1";
const dir = mkdtempSync(join(tmpdir(), "rail-devnet-smoke-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("rail Solana devnet : fumée réelle (MIND_WAKE_DEVNET_SMOKE=1)", () => {
  it("règle 1 jeton de test avec 1 % de frais, sans doublon, retrouvé on-chain", async () => {
    const kit = await ensureKit(undefined, undefined, (line) => {
      console.log(line);
    });
    const port = createKitPort(kit.rpcUrl);
    const rail = await SolanaDevnetRail.open({
      port,
      dbPath: join(dir, "rail.sqlite"),
      signerSeed: seedBytes(kit.payerSeedHex),
      mint: kit.mint,
      decimals: MIND_PROFILE.decimals,
      expectedFeeBasisPoints: MIND_PROFILE.transferFeeBasisPoints,
      feeMode: "recipient_bears",
      resolveRecipient: (principal) => (principal === "guide-smoke" ? kit.recipient : undefined),
      perTransferCap: 10n * 10n ** 9n,
    });
    try {
      const key = `stl-smoke-${String(Date.now())}`;
      const payload = {
        simulated: false,
        settlementId: key,
        contractId: key,
        contractDigest: "0".repeat(64),
        guidePrincipalId: "guide-smoke",
        recipientBindingVersion: "v1",
        assetId: kit.mint,
        networkId: DEVNET_NETWORK_ID,
        amount: String(10n ** 9n),
      };
      const rpc = createSolanaRpc(kit.rpcUrl);
      const [ata] = await findAssociatedTokenPda({
        owner: address(kit.recipient),
        mint: address(kit.mint),
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      const balance = async () => {
        try {
          const { value } = await rpc
            .getTokenAccountBalance(ata, { commitment: "confirmed" })
            .send();
          return BigInt(value.amount);
        } catch {
          return 0n;
        }
      };
      const before = await balance();

      const result = await rail.submit(key, payload, 1);
      expect(result.status).toBe("accepted");
      console.log(`transfert devnet : ${JSON.stringify(result)}`);
      expect(rail.details(key)).toMatchObject({
        gross: 10n ** 9n,
        fee: 10n ** 7n,
        net: 990_000_000n,
      });

      const again = await rail.submit(key, payload, 2);
      expect(again).toEqual(result);

      const found = await rail.lookup(key);
      expect(found).toMatchObject({ status: "found" });
      expect(await balance()).toBe(before + 990_000_000n);
    } finally {
      rail.close();
    }
  }, 180_000);
});
