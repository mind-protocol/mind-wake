/**
 * Frais Token-2022 en entiers exacts : arrondi supérieur, plafond, époque, majoration.
 */

import { describe, expect, it } from "vitest";
import {
  activeTransferFee,
  breakdown,
  feeChangePending,
  feeFor,
  type TransferFee,
  type TransferFeeConfig,
} from "../../../services/advice/rail-solana-devnet/fees.js";

const ONE_PERCENT: TransferFee = {
  epoch: 0n,
  maximumFee: 1_000_000_000_000_000_000n,
  transferFeeBasisPoints: 100,
};

function config(older: TransferFee, newer: TransferFee = older): TransferFeeConfig {
  return { olderTransferFee: older, newerTransferFee: newer };
}

describe("frais de transfert Token-2022", () => {
  it("arrondit au supérieur comme le programme", () => {
    expect(feeFor(100n, ONE_PERCENT)).toBe(1n);
    expect(feeFor(101n, ONE_PERCENT)).toBe(2n);
    expect(feeFor(1n, ONE_PERCENT)).toBe(1n);
    expect(feeFor(0n, ONE_PERCENT)).toBe(0n);
    expect(feeFor(10n ** 9n, ONE_PERCENT)).toBe(10n ** 7n);
  });

  it("applique le plafond maximumFee", () => {
    expect(feeFor(1_000_000n, { ...ONE_PERCENT, maximumFee: 5n })).toBe(5n);
  });

  it("choisit la configuration selon l'époque", () => {
    const newer = { ...ONE_PERCENT, epoch: 10n, transferFeeBasisPoints: 250 };
    expect(activeTransferFee(config(ONE_PERCENT, newer), 9n).transferFeeBasisPoints).toBe(100);
    expect(activeTransferFee(config(ONE_PERCENT, newer), 10n).transferFeeBasisPoints).toBe(250);
  });

  it("signale un changement de taux en vigueur ou programmé pour l'époque suivante", () => {
    expect(feeChangePending(config(ONE_PERCENT), 5n, 100)).toBe(false);
    expect(feeChangePending(config(ONE_PERCENT), 5n, 50)).toBe(true);
    const soon = { ...ONE_PERCENT, epoch: 6n, transferFeeBasisPoints: 200 };
    expect(feeChangePending(config(ONE_PERCENT, soon), 5n, 100)).toBe(true);
    const later = { ...ONE_PERCENT, epoch: 9n, transferFeeBasisPoints: 200 };
    expect(feeChangePending(config(ONE_PERCENT, later), 5n, 100)).toBe(false);
  });

  it("le destinataire supporte les frais : envoyé = montant, reçu = montant − frais", () => {
    expect(breakdown(10n ** 9n, ONE_PERCENT, "recipient_bears")).toEqual({
      gross: 10n ** 9n,
      fee: 10n ** 7n,
      net: 990_000_000n,
      basisPoints: 100,
    });
  });

  it("majoration : le guide reçoit exactement le montant, avec le plus petit brut possible", () => {
    for (const amount of [1n, 99n, 100n, 101n, 9_999n, 10n ** 9n, 123_456_789_012n]) {
      const result = breakdown(amount, ONE_PERCENT, "sender_grosses_up");
      expect(result.net).toBeGreaterThanOrEqual(amount);
      expect(result.fee).toBe(feeFor(result.gross, ONE_PERCENT));
      expect(result.gross - 1n - feeFor(result.gross - 1n, ONE_PERCENT)).toBeLessThan(amount);
    }
  });

  it("majoration avec plafond atteint", () => {
    const capped = { ...ONE_PERCENT, maximumFee: 3n };
    expect(breakdown(10_000n, capped, "sender_grosses_up")).toMatchObject({
      gross: 10_003n,
      fee: 3n,
      net: 10_000n,
    });
  });

  it("refuse un montant nul ou négatif", () => {
    expect(() => breakdown(0n, ONE_PERCENT, "recipient_bears")).toThrow(RangeError);
    expect(() => feeFor(-1n, ONE_PERCENT)).toThrow(RangeError);
  });
});
