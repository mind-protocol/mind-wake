/**
 * Adapter devnet contre une chaîne factice : garde-fous réseau et mint, frais, idempotence
 * par transaction persistée avant envoi, pertes, expirations, timeouts et rapprochement
 * par mémo. Aucun accès réseau ; la fumée réelle est dans `devnet-smoke.test.ts`.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_NETWORK_ID,
  DevnetGuardError,
  MAINNET_MIND_MINT,
  PreflightRefusedError,
  SolanaDevnetRail,
  type DevnetRailOptions,
  type MemoEntry,
  type MintView,
  type SignatureStatus,
  type SignedTransfer,
  type SolanaPort,
  type TransferFeeConfig,
} from "../../../services/advice/rail-solana-devnet/index.js";
import {
  AdviceSessionService,
  openAdviceDatabase,
  SettlementTimeoutError,
  SettlementUnavailableError,
  type TransferPayload,
} from "../../../services/advice/session/index.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const RECIPIENT = "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q";
const decoder = getAddressDecoder();
const randomKey = () => decoder.decode(randomBytes(32));
const TEST_MINT = randomKey();

type SendBehavior =
  "land" | "drop" | "land_then_network_error" | "network_error" | "preflight" | "land_failed";

const ONE_PERCENT_CONFIG: TransferFeeConfig = {
  olderTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 100 },
  newerTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 100 },
};

class FakeChain implements SolanaPort {
  genesis = DEVNET_GENESIS_HASH;
  epoch = 900n;
  blockHeight = 1_000n;
  mintView: MintView | null = {
    programAddress: TOKEN_2022,
    decimals: 9,
    mintAuthority: randomKey(),
    freezeAuthority: null,
    transferFee: ONE_PERCENT_CONFIG,
    transferHookProgram: null,
  };
  behaviors: SendBehavior[] = [];
  /** Signatures atterries, avec leur état. */
  readonly landed = new Map<
    string,
    { confirmation: SignatureStatus["confirmation"]; failed: boolean; memo: string }
  >();
  readonly sent: SignedTransfer[] = [];
  statusesUnavailable = 0;

  genesisHash() {
    return Promise.resolve(this.genesis);
  }
  epochInfo() {
    return Promise.resolve({ epoch: this.epoch, blockHeight: this.blockHeight });
  }
  latestBlockhash() {
    return Promise.resolve({
      blockhash: randomKey(),
      lastValidBlockHeight: this.blockHeight + 150n,
    });
  }
  mint() {
    return Promise.resolve(this.mintView);
  }
  send(transfer: SignedTransfer) {
    this.sent.push(transfer);
    const behavior = this.behaviors.shift() ?? "land";
    const land = (failed: boolean) => {
      if (!this.landed.has(transfer.signature)) {
        this.landed.set(transfer.signature, {
          confirmation: "confirmed",
          failed,
          memo: transfer.memo,
        });
      }
    };
    switch (behavior) {
      case "land":
        land(false);
        return Promise.resolve();
      case "land_failed":
        land(true);
        return Promise.resolve();
      case "drop":
        return Promise.resolve();
      case "land_then_network_error":
        land(false);
        return Promise.reject(new Error("ECONNRESET"));
      case "network_error":
        return Promise.reject(new Error("ETIMEDOUT"));
      case "preflight":
        return Promise.reject(new PreflightRefusedError("insufficient funds"));
    }
  }
  statuses(signatures: readonly string[]) {
    if (this.statusesUnavailable > 0) {
      this.statusesUnavailable -= 1;
      return Promise.reject(new Error("429"));
    }
    return Promise.resolve(
      signatures.map((sig) => {
        const status = this.landed.get(sig);
        return status === undefined
          ? null
          : { confirmation: status.confirmation, failed: status.failed };
      }),
    );
  }
  memosForAddress(): Promise<MemoEntry[]> {
    return Promise.resolve(
      [...this.landed.entries()].reverse().map(([signature, status]) => ({
        signature,
        memo: `[${String(status.memo.length)}] ${status.memo}`,
        failed: status.failed,
        confirmation: status.confirmation,
      })),
    );
  }
  requestAirdrop(): Promise<string> {
    return Promise.reject(new Error("non utilisé"));
  }
  finalizeAll() {
    for (const status of this.landed.values()) status.confirmation = "finalized";
  }
  landedTransfers() {
    return [...this.landed.values()].filter((status) => !status.failed);
  }
}

const dirs: string[] = [];
const rails: SolanaDevnetRail[] = [];
afterEach(() => {
  for (const rail of rails.splice(0)) rail.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "rail-devnet-"));
  dirs.push(dir);
  return join(dir, "rail-devnet.sqlite");
}

const SEED = new Uint8Array(randomBytes(32));

async function openRail(
  chain: FakeChain,
  overrides: Partial<DevnetRailOptions> = {},
): Promise<SolanaDevnetRail> {
  let now = 0;
  const rail = await SolanaDevnetRail.open({
    port: chain,
    dbPath: tempDb(),
    signerSeed: SEED,
    mint: TEST_MINT,
    decimals: 9,
    expectedFeeBasisPoints: 100,
    feeMode: "recipient_bears",
    resolveRecipient: (principal) => (principal === "guide-1" ? RECIPIENT : undefined),
    perTransferCap: 10n ** 12n,
    confirmTimeoutMs: 120_000,
    pollMs: 1_000,
    now: () => now,
    // Chaque attente avance l'horloge et la hauteur de bloc (≈ 2,5 blocs par seconde).
    sleep: (ms) => {
      now += ms;
      chain.blockHeight += BigInt(Math.ceil(ms / 400));
      return Promise.resolve();
    },
    ...overrides,
  });
  rails.push(rail);
  return rail;
}

function payload(overrides: Partial<TransferPayload> = {}): TransferPayload {
  return {
    simulated: false,
    settlementId: "stl-c1",
    contractId: "c1",
    contractDigest: "d".repeat(64),
    guidePrincipalId: "guide-1",
    recipientBindingVersion: "v1",
    assetId: TEST_MINT,
    networkId: DEVNET_NETWORK_ID,
    amount: "1000000000",
    ...overrides,
  };
}

describe("adapter devnet : garde-fous", () => {
  it("refuse le mint mainnet de $MIND sans même interroger le réseau", async () => {
    const chain = new FakeChain();
    chain.genesis = "mainnet";
    await expect(openRail(chain, { mint: MAINNET_MIND_MINT })).rejects.toThrow(/mainnet/);
  });

  it("refuse un réseau dont le genesis n'est pas devnet", async () => {
    const chain = new FakeChain();
    chain.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(openRail(chain)).rejects.toThrow(DevnetGuardError);
  });

  it("refuse un mint sans frais de transfert, hors Token-2022, avec hook ou mauvaises décimales", async () => {
    const variants: Partial<MintView>[] = [
      { transferFee: null },
      { programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { transferHookProgram: randomKey() },
      { decimals: 6 },
    ];
    for (const variant of variants) {
      const chain = new FakeChain();
      chain.mintView = { ...(chain.mintView as MintView), ...variant };
      await expect(openRail(chain)).rejects.toThrow(DevnetGuardError);
    }
  });

  it("n'est pas accepté par le service de séances, qui reste SIMULÉ", async () => {
    const rail = await openRail(new FakeChain());
    const db = openAdviceDatabase(join(mkdtempSync(join(tmpdir(), "svc-")), "a.sqlite"));
    expect(() => new AdviceSessionService({ db, rail })).toThrow(/SIMULÉ/);
    db.close();
  });

  it("refuse un payload simulé, un autre réseau ou actif, un montant hors plafond", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    for (const bad of [
      payload({ simulated: true }),
      payload({ networkId: "solana-mainnet" }),
      payload({ assetId: MAINNET_MIND_MINT }),
      payload({ amount: "0" }),
      payload({ amount: "01" }),
      payload({ amount: String(10n ** 13n) }),
    ]) {
      await expect(rail.submit("k", bad, 1)).resolves.toEqual({
        status: "rejected",
        reason: "invalid_payload",
      });
    }
    expect(chain.sent).toHaveLength(0);
  });

  it("refuse un bénéficiaire non résolu", async () => {
    const rail = await openRail(new FakeChain());
    await expect(rail.submit("k", payload({ guidePrincipalId: "inconnu" }), 1)).resolves.toEqual({
      status: "rejected",
      reason: "recipient_unresolved",
    });
  });
});

describe("adapter devnet : frais de 1 %", () => {
  it("le destinataire supporte les frais : reçu détaillé envoyé / frais / reçu", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    const result = await rail.submit("stl-c1", payload(), 1);
    expect(result.status).toBe("accepted");
    expect(rail.details("stl-c1")).toMatchObject({
      gross: 1_000_000_000n,
      fee: 10_000_000n,
      net: 990_000_000n,
      recipient: RECIPIENT,
    });
  });

  it("majoration : le guide reçoit exactement le montant du contrat", async () => {
    const rail = await openRail(new FakeChain(), { feeMode: "sender_grosses_up" });
    await rail.submit("stl-c1", payload(), 1);
    expect(rail.details("stl-c1")).toMatchObject({ net: 1_000_000_000n, fee: 10_101_011n });
  });

  it("refuse d'émettre si le taux change ou va changer à l'époque suivante", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    chain.mintView = {
      ...(chain.mintView as MintView),
      transferFee: {
        ...ONE_PERCENT_CONFIG,
        newerTransferFee: {
          epoch: chain.epoch + 1n,
          maximumFee: 10n ** 18n,
          transferFeeBasisPoints: 500,
        },
      },
    };
    await expect(rail.submit("stl-c1", payload(), 1)).resolves.toEqual({
      status: "rejected",
      reason: "fee_changed",
    });
    expect(chain.sent).toHaveLength(0);
  });
});

describe("adapter devnet : idempotence et incertitude", () => {
  it("un second submit avec la même clé ne crée aucun second transfert", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    const first = await rail.submit("stl-c1", payload(), 1);
    const second = await rail.submit("stl-c1", payload(), 2);
    expect(second).toEqual(first);
    expect(chain.landedTransfers()).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("refuse un payload différent pour la même clé et un jeton de fencing périmé", async () => {
    const rail = await openRail(new FakeChain());
    await rail.submit("stl-c1", payload(), 5);
    await expect(rail.submit("stl-c1", payload({ amount: "2000000000" }), 5)).resolves.toEqual({
      status: "rejected",
      reason: "payload_conflict",
    });
    await expect(rail.submit("stl-c1", payload(), 4)).resolves.toEqual({
      status: "rejected",
      reason: "stale_fencing_token",
    });
  });

  it("erreur réseau après relais : le suivi constate l'atterrissage, sans réémission", async () => {
    const chain = new FakeChain();
    chain.behaviors = ["land_then_network_error"];
    const rail = await openRail(chain);
    expect((await rail.submit("stl-c1", payload(), 1)).status).toBe("accepted");
    expect(chain.sent).toHaveLength(1);
  });

  it("transaction perdue : nouvelle transaction seulement après expiration de la première", async () => {
    const chain = new FakeChain();
    chain.behaviors = ["drop", "land"];
    const rail = await openRail(chain);
    const result = await rail.submit("stl-c1", payload(), 1);
    expect(result.status).toBe("accepted");
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[0]?.signature).not.toBe(chain.sent[1]?.signature);
    expect(chain.landedTransfers()).toHaveLength(1);
  });

  it("transaction atterrie en échec : jamais comptée, nouvelle tentative", async () => {
    const chain = new FakeChain();
    chain.behaviors = ["land_failed", "land"];
    const rail = await openRail(chain);
    expect((await rail.submit("stl-c1", payload(), 1)).status).toBe("accepted");
    expect(chain.landedTransfers()).toHaveLength(1);
  });

  it("délai dépassé tant qu'une tentative reste valide : issue inconnue, puis renvoi des mêmes octets", async () => {
    const chain = new FakeChain();
    chain.behaviors = ["network_error"];
    const rail = await openRail(chain, { confirmTimeoutMs: 5_000 });
    await expect(rail.submit("stl-c1", payload(), 1)).rejects.toThrow(SettlementTimeoutError);
    // La tentative peut encore atterrir : l'absence n'est pas probante.
    await expect(rail.lookup("stl-c1")).rejects.toThrow(SettlementUnavailableError);
    const retry = await rail.submit("stl-c1", payload(), 2);
    expect(retry.status).toBe("accepted");
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]?.wireBase64).toBe(chain.sent[0]?.wireBase64);
    expect(chain.landedTransfers()).toHaveLength(1);
  });

  it("refus de simulation : issue incertaine tant que valide, puis absence probante", async () => {
    const chain = new FakeChain();
    chain.behaviors = ["preflight"];
    const rail = await openRail(chain);
    await expect(rail.submit("stl-c1", payload(), 1)).rejects.toThrow(SettlementTimeoutError);
    chain.blockHeight += 200n;
    await expect(rail.lookup("stl-c1")).resolves.toEqual({ status: "not_found" });
    expect(chain.landedTransfers()).toHaveLength(0);
  });

  it("recherche indisponible : erreur explicite, jamais une absence", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    await rail.submit("stl-c1", payload(), 1);
    chain.statusesUnavailable = 1;
    await expect(rail.lookup("stl-c1")).rejects.toThrow(SettlementUnavailableError);
  });
});

describe("adapter devnet : rapprochement", () => {
  it("lookup rapporte confirming puis finalized, avec le digest du payload", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    const result = await rail.submit("stl-c1", payload(), 1);
    if (result.status !== "accepted") throw new Error("attendu : accepted");
    const confirming = await rail.lookup("stl-c1");
    expect(confirming).toMatchObject({
      status: "found",
      state: "confirming",
      externalRef: result.externalRef,
    });
    chain.finalizeAll();
    await expect(rail.lookup("stl-c1")).resolves.toMatchObject({ state: "finalized" });
  });

  it("base locale perdue : le mémo on-chain retrouve le transfert et son digest", async () => {
    const chain = new FakeChain();
    const first = await openRail(chain);
    const result = await first.submit("stl-c1", payload(), 1);
    const before = await first.lookup("stl-c1");
    const fresh = await openRail(chain); // nouvelle base vide, même signataire
    const after = await fresh.lookup("stl-c1");
    expect(after).toEqual(before);
    expect(after).toMatchObject({ externalRef: (result as { externalRef: string }).externalRef });
    await expect(fresh.lookup("autre-clé")).resolves.toEqual({ status: "not_found" });
  });

  it("le mémo public ne contient ni la clé, ni le principal, ni le montant en clair", async () => {
    const chain = new FakeChain();
    const rail = await openRail(chain);
    await rail.submit("stl-c1", payload(), 1);
    const memo = chain.sent[0]?.memo ?? "";
    expect(memo).toMatch(/^mind-wake\/devnet-test\/v1 k=[0-9a-f]{64} d=[0-9a-f]{64}$/);
    expect(memo).not.toContain("stl-c1");
    expect(memo).not.toContain("guide-1");
  });
});
