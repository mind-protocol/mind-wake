/** Local preparation only. This is not a resolved or signable payment envelope. */
export type PaymentCommandOrigin =
  "owner_direct" | "ocr" | "quotation" | "third_party" | "notification" | "unknown";

export type PreparedPaymentCommand = Readonly<{
  status: "prepared";
  type: "payment";
  amount: string;
  amountAtomic: string;
  recipientUsername: string;
  canonicalCommand: string;
  origin: PaymentCommandOrigin;
  intent: "direct_instruction" | "detected_intent";
  authorization: "not_granted";
  previewText: string;
}>;

export type PaymentCommandResult =
  | Readonly<{ ok: true; payment: PreparedPaymentCommand }>
  | Readonly<{
      ok: false;
      error: "invalid_origin" | "invalid_command" | "zero_amount" | "amount_overflow";
    }>;

const ORIGINS: readonly PaymentCommandOrigin[] = [
  "owner_direct",
  "ocr",
  "quotation",
  "third_party",
  "notification",
  "unknown",
];
const ATOMS_PER_MIND = BigInt("1000000000");
const MAX_U64 = BigInt("18446744073709551615");

// ASCII spaces separate tokens; no multiline command, case folding or
// username guessing. The + belongs only to the +amount MIND alias.
const COMMAND =
  /^(?:(?:◈|\$MIND) +([0-9]+(?:[.,][0-9]{1,9})?)|\+([0-9]+(?:[.,][0-9]{1,9})?) +MIND) +@([a-z0-9][a-z0-9_-]{0,31})$/;

/**
 * Parse one whole command, preserving its caller-supplied provenance.
 * owner_direct describes origin, never authentication, consent or a mandate.
 * The caller must derive origin from its trusted channel, not from parsed text.
 * Recipient resolution, exact asset/network, fees, nonce, mandate and signing
 * belong to a later preparation/broker step, outside this module.
 */
export function preparePaymentCommand(
  text: string,
  origin: PaymentCommandOrigin,
): PaymentCommandResult {
  if (!ORIGINS.includes(origin)) {
    return Object.freeze({ ok: false, error: "invalid_origin" });
  }
  // JavaScript's $ anchor also matches before a final newline: require the
  // matched text to equal the complete input rather than accepting that suffix.
  const command = text.replace(/^ +| +$/g, "");
  const match = COMMAND.exec(command);
  if (!match || match[0] !== command) {
    return Object.freeze({ ok: false, error: "invalid_command" });
  }
  const rawAmount = match[1] || match[2];
  const [rawWhole, fraction = ""] = rawAmount.replace(",", ".").split(".");
  const whole = rawWhole.replace(/^0+(?=[0-9])/, "");
  // u64 / 10^9 has eleven integer digits. Bound before parsing arbitrary input.
  if (whole.length > 11) {
    return Object.freeze({ ok: false, error: "amount_overflow" });
  }
  const atomic = BigInt(whole) * ATOMS_PER_MIND + BigInt(fraction.padEnd(9, "0"));
  if (atomic === BigInt(0)) {
    return Object.freeze({ ok: false, error: "zero_amount" });
  }
  if (atomic > MAX_U64) {
    return Object.freeze({ ok: false, error: "amount_overflow" });
  }
  const significantFraction = fraction.replace(/0+$/, "");
  const amount = significantFraction ? `${whole}.${significantFraction}` : whole;
  const recipientUsername = match[3];
  const intent = origin === "owner_direct" ? "direct_instruction" : "detected_intent";
  const previewText =
    intent === "direct_instruction"
      ? `Paiement préparé : ${amount} ◈ à @${recipientUsername}.`
      : `Commande repérée : ${amount} ◈ à @${recipientUsername}.`;

  return Object.freeze({
    ok: true,
    payment: Object.freeze({
      status: "prepared",
      type: "payment",
      amount,
      amountAtomic: atomic.toString(),
      recipientUsername,
      canonicalCommand: `◈ ${amount} @${recipientUsername}`,
      origin,
      intent,
      authorization: "not_granted",
      previewText,
    }),
  });
}
