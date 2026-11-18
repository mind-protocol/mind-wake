import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { registerUnifiedCall } from "../services/mcp/unified-call.js";
import { openCallRequests } from "../services/mcp/call-requests.mjs";
import { openCallControls } from "../services/mcp/call-control-store.mjs";
// @ts-expect-error App server module is JavaScript.
import { createAgentCalls } from "../lumina-prime/app/server/agent-calls.mjs";
// @ts-expect-error App server module is JavaScript.
import { createCallService } from "../lumina-prime/app/server/chat-call.mjs";

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (input: Record<string, unknown>) => Promise<Result>;
describe("unified call MCP", () => {
  it("runs the actual MCP handler through the queue and starts a local agent call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unified-call-"));
    const controls = openCallControls(dir);
    const call = createCallService({
      sendMain: async () => ({}),
      mainReplies: () => [],
      speak: async () => ({ bytes: Buffer.from("RIFF") }),
      mainLabel: "Marco",
      mainAgentId: "marco",
      handleTable: () => new Map([["room3", { room: 3, agent: null, label: "Room 3" }]]),
      mirrorIntervalMs: 0,
    });
    const service = createAgentCalls({
      dataDir: dir,
      call,
      controls,
      peers: {},
      phones: {},
      canCall: () => true,
    });
    let handler: Handler | undefined;
    registerUnifiedCall(
      {
        registerTool: (name: string, _schema: unknown, h: Handler) => {
          expect(name).toBe("call");
          handler = h;
        },
      } as never,
      { dir, caller: "mind", label: "Marco", assertAllowed: () => {} },
    );
    const timer = setInterval(() => {
      void service.tick();
    }, 25);
    try {
      const response = await handler!({ target: "room3", human: false });
      expect(response.isError).toBeUndefined();
      const result = JSON.parse(response.content[0]!.text);
      expect(result).toMatchObject({
        schema: "mind.call.v1",
        status: "active",
        epoch: 1,
        target: "room3",
      });
      expect(controls.listForCaller("mind")[0]?.id).toBe(result.call_id);
      const status = JSON.parse((await handler!({ request_id: result.request })).content[0]!.text);
      expect(status.call_id).toBe(result.call_id);
      controls.requestHangup({ id: result.call_id, epoch: 1, caller: "mind" });
      await service.tick();
      expect(call.active()).toHaveLength(0);
    } finally {
      clearInterval(timer);
      await service.close();
      call.stop();
      controls.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not enqueue when the host has stopped calling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unified-paused-"));
    let handler: Handler | undefined;
    registerUnifiedCall(
      {
        registerTool: (_n: string, _s: unknown, h: Handler) => {
          handler = h;
        },
      } as never,
      {
        dir,
        caller: "mind",
        label: "Marco",
        assertAllowed: () => {
          throw Error("paused");
        },
      },
    );
    try {
      expect((await handler!({ target: "⬡other", human: true })).isError).toBe(true);
      const book = openCallRequests(dir);
      try {
        expect(book.pending()).toHaveLength(0);
      } finally {
        book.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("expires offline requests and hides their status from other callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "unified-expire-"));
    let now = 1000;
    const book = openCallRequests(dir, { now: () => now });
    try {
      const input = { caller: "mind", label: "Marco", target: "⬡other" };
      const r = book.enqueue(input);
      expect(book.enqueue(input).request).toBe(r.request);
      expect(book.get(r.request, "room3")).toBeNull();
      expect(book.claim()?.request).toBe(r.request);
      const other = openCallRequests(dir, { now: () => now });
      try {
        expect(other.claim()).toBeNull();
        expect(other.enqueue(input).request).toBe(r.request);
      } finally {
        other.close();
      }
      now += 60_001;
      expect(book.pending()).toHaveLength(0);
      expect(book.get(r.request, "mind")).toMatchObject({ status: "expired" });
    } finally {
      book.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
