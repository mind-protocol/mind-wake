/**
 * Reçu de séance SIMULÉ (SPEC §14.4, TRANSACTIONS §15). Il ne contient aucun contenu
 * de conversation : ni texte, ni référence de message, ni sujet. Il distingue dû, en
 * cours et réglé fictivement, sans jamais présenter une écriture interne comme un
 * paiement reçu.
 */

import { formatAmount } from "./amounts.js";
import type { ContractStatus } from "./service.js";
import { SIMULATION_LABEL } from "./types.js";

export type ReceiptStatus =
  | "not_closed"
  | "none_due_simulated"
  | "due_simulated"
  | "settling_simulated"
  | "settled_simulated"
  | "frozen_simulated"
  | "cancelled_simulated"
  | "expired_simulated"
  | "disputed_simulated";

export interface Receipt {
  readonly label: typeof SIMULATION_LABEL;
  readonly simulated: true;
  readonly notice: string;
  readonly contractRef: string;
  readonly contractDigest: string;
  readonly service: "guidance_exchange_count";
  readonly participants: { readonly agentRef: string; readonly guideRef: string };
  readonly period: { readonly openedAt: string; readonly closedAt: string | null };
  readonly contextVersion: string;
  readonly countingRuleVersion: string;
  readonly criteria: {
    readonly earnedExchanges: number | null;
    readonly maxExchanges: number;
    readonly closeReason: string | null;
  };
  readonly unit: "unités fictives";
  readonly unitPrice: string;
  readonly amountDue: string | null;
  readonly status: ReceiptStatus;
  readonly simulatedSettlementRef: string | null;
}

const NOTICE =
  "Unités fictives : aucun fonds réel, wallet ou transfert. La réservation était un verrou interne, pas un escrow.";

function receiptStatus(status: ContractStatus): ReceiptStatus {
  switch (status.state) {
    case "offered":
    case "accepted":
    case "reserved":
    case "active":
    case "submitted":
      return "not_closed";
    case "cancelled":
      return "cancelled_simulated";
    case "expired":
      return "expired_simulated";
    case "disputed":
      return "disputed_simulated";
    case "approved":
      return status.principalDue === 0n ? "none_due_simulated" : "due_simulated";
    case "settlement_pending":
      if (status.settlement?.state === "frozen") return "frozen_simulated";
      return status.settlement === null || status.settlement.state === "prepared"
        ? "due_simulated"
        : "settling_simulated";
    case "settled":
      return status.principalDue === 0n ? "none_due_simulated" : "settled_simulated";
  }
}

export function buildReceipt(status: ContractStatus, closedAt: string | null): Receipt {
  const { contract } = status;
  return {
    label: SIMULATION_LABEL,
    simulated: true,
    notice: NOTICE,
    contractRef: contract.contractId,
    contractDigest: status.digest,
    service: "guidance_exchange_count",
    participants: { agentRef: contract.agentId, guideRef: contract.guidePrincipalId },
    period: { openedAt: contract.createdAt, closedAt },
    contextVersion: contract.contextVersion,
    countingRuleVersion: contract.countingRuleVersion,
    criteria: {
      earnedExchanges: status.earnedExchanges,
      maxExchanges: contract.maxExchanges,
      closeReason: status.closeReason,
    },
    unit: "unités fictives",
    unitPrice: formatAmount(contract.unitPrice),
    amountDue: status.principalDue === null ? null : formatAmount(status.principalDue),
    status: receiptStatus(status),
    simulatedSettlementRef: status.settlement?.externalRef ?? null,
  };
}
