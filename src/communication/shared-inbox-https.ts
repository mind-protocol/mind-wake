/** Session inbox client, with an optional narrowly validated technical receipt write. */
import { validHookAck } from "./peer-task-protocol.js";
import { request } from "node:https";
import * as z from "zod";
const receiptCall = z.strictObject({
  op: z.literal("reply"),
  threadId: z.string().regex(/^thr_[A-Za-z0-9_-]{8,64}$/),
  inReplyTo: z.string(),
  text: z.string().max(4000),
  idempotencyKey: z.string().max(128),
});
export type SharedInboxCall =
  | { op: "whoami" }
  | { op: "read_inbox"; after: number; limit: number }
  | { op: "reply"; threadId: string; inReplyTo: string; text: string; idempotencyKey: string };
export class SharedInboxHttps {
  readonly #url: URL;
  #next = 0;
  constructor(
    endpoint: string,
    private readonly key: string,
    private readonly hookAcks = false,
  ) {
    this.#url = new URL(endpoint);
    if (
      this.#url.protocol !== "https:" ||
      this.#url.pathname !== "/v1/messages" ||
      this.#url.username ||
      this.#url.password ||
      this.#url.search ||
      this.#url.hash ||
      key.length < 16 ||
      key.length > 256 ||
      /[\r\n]/.test(key)
    )
      throw Error("Invalid shared inbox endpoint/key");
  }
  async call<T>(call: SharedInboxCall, signal?: AbortSignal): Promise<T> {
    if (call.op !== "whoami" && call.op !== "read_inbox") {
      const parsed = receiptCall.safeParse(call);
      const ack = parsed.success ? validHookAck(parsed.data.text) : null;
      if (
        !this.hookAcks ||
        !ack ||
        call.inReplyTo !== ack.request_message_id ||
        !/^thr_[A-Za-z0-9_-]{8,64}$/.test(call.threadId) ||
        call.idempotencyKey !== "peer-hook-ack:" + ack.request_id
      )
        throw Error(
          "Read-only shared inbox operation required; only opted-in hook receipts allowed",
        );
    }
    if (signal?.aborted) throw Error("Shared inbox request cancelled");
    const id = ++this.#next,
      body = JSON.stringify({ ...call, id });
    return new Promise<T>((resolve, reject) => {
      const req = request(
        this.#url,
        {
          method: "POST",
          rejectUnauthorized: true,
          ...(signal ? { signal } : {}),
          headers: {
            authorization: `Bearer ${this.key}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_048_576) response.destroy(Error("Shared inbox response too large"));
            else chunks.push(chunk);
          });
          response.on("error", () => {
            clearTimeout(timer);
            reject(Error("Shared inbox response interrupted"));
          });
          response.on("end", () => {
            clearTimeout(timer);
            try {
              if (response.statusCode !== 200) throw Error("status");
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                id: unknown;
                ok: unknown;
                result: T;
              };
              if (result.id !== id || result.ok !== true) throw Error("response");
              resolve(result.result);
            } catch {
              reject(Error("Invalid shared inbox response"));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(Error("Shared inbox timeout")), 8000);
      req.on("error", () => {
        clearTimeout(timer);
        reject(Error("Shared inbox transport unavailable"));
      });
      req.end(body);
    });
  }
}
