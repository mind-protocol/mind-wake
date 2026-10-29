/**
 * Frais de transfert Token-2022 (extension TransferFeeConfig), en entiers exacts.
 *
 * Le programme Token-2022 prélève `ceil(montant × bps / 10 000)`, plafonné à `maximumFee`,
 * avec la configuration « newer » à partir de son époque et « older » avant.
 */

export interface TransferFee {
  readonly epoch: bigint;
  readonly maximumFee: bigint;
  readonly transferFeeBasisPoints: number;
}

export interface TransferFeeConfig {
  readonly olderTransferFee: TransferFee;
  readonly newerTransferFee: TransferFee;
}

/** Qui supporte les frais : le guide reçoit le net, ou l'envoi est majoré pour qu'il reçoive le montant. */
export type FeeMode = "recipient_bears" | "sender_grosses_up";

export interface TransferBreakdown {
  /** Montant débité de la source. */
  readonly gross: bigint;
  /** Frais retenus sur le compte destinataire. */
  readonly fee: bigint;
  /** Montant effectivement crédité au guide. */
  readonly net: bigint;
  readonly basisPoints: number;
}

const BPS_DENOMINATOR = 10_000n;

export function activeTransferFee(config: TransferFeeConfig, epoch: bigint): TransferFee {
  return epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
}

export function feeFor(amount: bigint, fee: TransferFee): bigint {
  if (amount < 0n) throw new RangeError("montant négatif");
  const bps = BigInt(fee.transferFeeBasisPoints);
  if (bps === 0n || amount === 0n) return 0n;
  const raw = (amount * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return raw > fee.maximumFee ? fee.maximumFee : raw;
}

/**
 * Taux qui s'appliquera à une transaction émise maintenant. Un changement programmé pour
 * l'époque suivante compte aussi : la transaction peut atterrir après la bascule.
 */
export function feeChangePending(
  config: TransferFeeConfig,
  epoch: bigint,
  expectedBasisPoints: number,
): boolean {
  const current = activeTransferFee(config, epoch);
  const next = activeTransferFee(config, epoch + 1n);
  return (
    current.transferFeeBasisPoints !== expectedBasisPoints ||
    next.transferFeeBasisPoints !== expectedBasisPoints ||
    current.maximumFee !== next.maximumFee
  );
}

export function breakdown(amount: bigint, fee: TransferFee, mode: FeeMode): TransferBreakdown {
  if (amount <= 0n) throw new RangeError("montant nul ou négatif");
  const basisPoints = fee.transferFeeBasisPoints;
  if (mode === "recipient_bears") {
    const charged = feeFor(amount, fee);
    return { gross: amount, fee: charged, net: amount - charged, basisPoints };
  }
  // Plus petit brut g tel que g − frais(g) ≥ montant.
  const bps = BigInt(basisPoints);
  if (bps >= BPS_DENOMINATOR) throw new RangeError("frais de 100 % : majoration impossible");
  let gross = (amount * BPS_DENOMINATOR + (BPS_DENOMINATOR - bps) - 1n) / (BPS_DENOMINATOR - bps);
  if (gross - amount > fee.maximumFee) gross = amount + fee.maximumFee;
  while (gross - feeFor(gross, fee) < amount) gross += 1n;
  while (gross > amount && gross - 1n - feeFor(gross - 1n, fee) >= amount) gross -= 1n;
  const charged = feeFor(gross, fee);
  return { gross, fee: charged, net: gross - charged, basisPoints };
}
