import { claimDuoReminder, finishDuoReminder } from "../../communication/duo-reminder.js";
import { randomUUID } from "node:crypto";
import {
  claimOwnerMessages,
  confirmOwnerClaim,
  releaseOwnerClaims,
} from "../../communication/owner-inbox.js";
import type { RpcClient } from "./rpc.js";
import { ownerContent } from "../../communication/owner-content.js";
import { claimProgressReminder, finishProgressReminder } from "../../communication/owner-progress-reminder.js";

/** Deliver to the existing turn. Never interrupts it, starts a second turn or kills a tool. */
export class CodexOwnerSteering {
  #stopped = false;
  #busy = false;
  #progressClaim: string | null = null;
  #duoClaim: string | null = null;
  #timer: NodeJS.Timeout;
  constructor(
    private readonly inbox: string,
    private readonly sessionId: string,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly rpc: Pick<RpcClient, "request">,
    private readonly isActive: () => boolean,
    private readonly onDeferred: () => void = () => undefined,
  ) {
    this.#timer = setInterval(() => {
      void this.flush();
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.#stopped || this.#busy || !this.isActive()) return;
    this.#busy = true;
    try {
      const claim = randomUUID();
      const messages = claimOwnerMessages(this.inbox, this.sessionId, claim);
      const duo = messages.length ? null : claimDuoReminder(this.inbox, claim);
      const reminder = duo ?? (messages.length ? null : claimProgressReminder(this.inbox, this.sessionId, claim));
      if (!messages.length && !reminder) return;
      if (duo) this.#duoClaim = claim;
      else if (reminder) this.#progressClaim = claim;
      const accepted = await this.rpc.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        clientUserMessageId: claim,
        input: reminder ? [{ type: "text", text: reminder }] : ownerContent(messages, "codex"),
      });
      if (this.#canConfirm() && accepted["turnId"] === this.turnId) {
        if (messages.length) confirmOwnerClaim(this.inbox, this.sessionId, claim);
        if (duo) {
          finishDuoReminder(this.inbox, claim, true);
          this.#duoClaim = null;
        } else if (reminder) {
          finishProgressReminder(this.inbox, this.sessionId, claim, true);
          this.#progressClaim = null;
        }
      } else {
        this.onDeferred();
        this.stop();
      }
    } catch {
      this.onDeferred();
      // Unsupported method, turn race, transport failure or ambiguous acknowledgement:
      // retain the message for the next wake; do not retry blindly within this turn.
      this.stop();
    } finally {
      this.#busy = false;
    }
  }

  #canConfirm(): boolean {
    return !this.#stopped && this.isActive();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    try {
      if (this.#duoClaim) {
        finishDuoReminder(this.inbox, this.#duoClaim, false);
        this.#duoClaim = null;
      }
      if (this.#progressClaim) {
        finishProgressReminder(this.inbox, this.sessionId, this.#progressClaim, false);
        this.#progressClaim = null;
      }
      releaseOwnerClaims(this.inbox, this.sessionId);
    } catch {
      // A locked/unavailable inbox must not crash the live model process. The next
      // session recovers reservations; never fabricate a delivery acknowledgement.
    }
  }
}
