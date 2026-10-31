import { randomUUID } from "node:crypto";
import {
  claimOwnerMessages,
  confirmOwnerClaim,
  releaseOwnerClaims,
} from "../../communication/owner-inbox.js";
import type { RpcClient } from "./rpc.js";
import { ownerContent } from "../../communication/owner-content.js";

/** Deliver to the existing turn. Never interrupts it, starts a second turn or kills a tool. */
export class CodexOwnerSteering {
  #stopped = false;
  #busy = false;
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
      if (!messages.length) return;
      const accepted = await this.rpc.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        clientUserMessageId: claim,
        input: ownerContent(messages, "codex"),
      });
      if (this.#canConfirm() && accepted["turnId"] === this.turnId) {
        confirmOwnerClaim(this.inbox, this.sessionId, claim);
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
      releaseOwnerClaims(this.inbox, this.sessionId);
    } catch {
      // A locked/unavailable inbox must not crash the live model process. The next
      // session recovers reservations; never fabricate a delivery acknowledgement.
    }
  }
}
