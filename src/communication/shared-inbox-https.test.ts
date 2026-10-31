import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(
  (): {
    status: number;
    payload: { id: number; ok: boolean; result: { ref: string; kind: string } };
    options: unknown;
    body: string;
  } => ({
    status: 200,
    payload: { id: 1, ok: true, result: { ref: "agent-dckgeedfrm", kind: "agent" } },
    options: undefined,
    body: "",
  }),
);
vi.mock("node:https", () => ({
  request: vi.fn((_url: unknown, options: unknown, respond: (response: unknown) => void) => {
    state.options = options;
    const req = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
      destroy: (error: Error) => void;
    };
    req.destroy = (error) => {
      req.emit("error", error);
    };
    req.end = (body) => {
      state.body = body;
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          destroy: (error: Error) => void;
        };
        response.statusCode = state.status;
        response.destroy = (error) => {
          response.emit("error", error);
        };
        respond(response);
        response.emit("data", Buffer.from(JSON.stringify(state.payload)));
        response.emit("end");
      });
    };
    return req;
  }),
}));
import { request } from "node:https";
import { SharedInboxHttps, type SharedInboxCall } from "./shared-inbox-https.js";
import { wire, type HookAckEnvelope } from "./peer-task-protocol.js";
const endpoint = "https://hub.example/v1/messages",
  key = "existing-agent-key-not-new";
beforeEach(() => {
  vi.clearAllMocks();
  state.status = 200;
  state.payload = { id: 1, ok: true, result: { ref: "agent-dckgeedfrm", kind: "agent" } };
  state.options = undefined;
  state.body = "";
});
it("uses authenticated TLS POST and propagates cancellation without credentials in the body", async () => {
  const signal = new AbortController().signal;
  expect(await new SharedInboxHttps(endpoint, key).call({ op: "whoami" }, signal)).toMatchObject({
    kind: "agent",
  });
  expect(state.options).toMatchObject({
    method: "POST",
    rejectUnauthorized: true,
    signal,
    headers: { authorization: `Bearer ${key}` },
  });
  expect(JSON.parse(state.body)).toEqual({ op: "whoami", id: 1 });
  expect(state.body).not.toContain(key);
});
it("does not follow redirects or accept mismatched response ids", async () => {
  state.status = 302;
  await expect(new SharedInboxHttps(endpoint, key).call({ op: "whoami" })).rejects.toThrow(
    "response",
  );
  expect(request).toHaveBeenCalledTimes(1);
  state.status = 200;
  state.payload.id = 22;
  await expect(new SharedInboxHttps(endpoint, key).call({ op: "whoami" })).rejects.toThrow(
    "response",
  );
});
it("rejects non-HTTPS endpoints, embedded credentials and query parameters", () => {
  for (const url of [
    "http://hub.example/v1/messages",
    "https://user:password@hub.example/v1/messages",
    "https://hub.example/v1/messages?key=x",
    "https://hub.example/other",
  ])
    expect(() => new SharedInboxHttps(url, key)).toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("never opens a request after cancellation or for a write operation", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    new SharedInboxHttps(endpoint, key).call({ op: "whoami" }, cancelled.signal),
  ).rejects.toThrow("cancelled");
  await expect(
    new SharedInboxHttps(endpoint, key).call({ op: "send_message" } as unknown as SharedInboxCall),
  ).rejects.toThrow("Read-only");
  expect(request).not.toHaveBeenCalled();
});

it("allows only bounded correlated hook receipts with explicit write opt-in using the same authenticated TLS client", async () => {
  const ack: HookAckEnvelope = {
    schema: "mind.peer-task/hook-ack",
    version: 1,
    request_id: "task_" + "a".repeat(32),
    prompt_hash: "b".repeat(64),
    recipient_ref: "agent-aaaaaaaaaa",
    receiver_ref: "agent-dckgeedfrm",
    request_message_id: "msg_original1",
    status: "received_pending_decision",
    received_at: "2026-10-31T00:00:00Z",
  };
  const call: SharedInboxCall = {
    op: "reply",
    threadId: "thr_original1",
    inReplyTo: ack.request_message_id,
    text: wire(ack),
    idempotencyKey: "peer-hook-ack:" + ack.request_id,
  };
  await expect(new SharedInboxHttps(endpoint, key).call(call)).rejects.toThrow("Read-only");
  const enabled = new SharedInboxHttps(endpoint, key, true);
  await expect(enabled.call({ ...call, text: '{"instructions":"execute"}' })).rejects.toThrow(
    "Read-only",
  );
  await expect(enabled.call({ ...call, inReplyTo: "msg_different1" })).rejects.toThrow("Read-only");
  expect(request).not.toHaveBeenCalled();
  await enabled.call(call);
  expect(JSON.parse(state.body)).toMatchObject(call);
  expect(state.options).toMatchObject({ headers: { authorization: `Bearer ${key}` } });
});
