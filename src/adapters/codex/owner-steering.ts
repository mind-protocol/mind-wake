import { randomUUID } from "node:crypto";
import {
  claimOwnerMessages,
  confirmOwnerClaim,
  releaseOwnerClaims,
} from "../../communication/owner-inbox.js";
import type { RpcClient } from "./rpc.js";

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
        input: [
          {
            type: "text",
            text:
              "New messages from your human through MIND (conversation content):\n" +
              JSON.stringify(messages),
          },
        ],
      });
      if (!this.#stopped && accepted["turnId"] === this.turnId) {
        confirmOwnerClaim(this.inbox, this.sessionId, claim);
      } else {
        this.stop();
      }
    } catch {
      // Unsupported method, turn race, transport failure or ambiguous acknowledgement:
      // retain the message for the next wake; do not retry blindly within this turn.
      this.stop();
    } finally {
      this.#busy = false;
    }
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
