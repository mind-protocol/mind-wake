import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { seedSimulatedProfile } from "./demo/harness.js";
import { registerOwnerTools } from "../services/mcp/owner-tools.js";
import { deliverLocalMessage, localMessageTargets } from "../src/communication/local-message.js";
import { SecondThreadStore } from "../src/daemon/second-thread.js";
import { readOwnerInboxHistory } from "../src/communication/owner-inbox.js";
import { readOwnerMessages } from "../src/communication/owner-messages.js";
import type { McpServer } from "@modelcontextprotocol/server";

type Response = { isError?: boolean; content: { text: string }[] };
it("messages independently reach human, room and selected agent; retries do not duplicate or create a call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-message-"));
  try {
    seedSimulatedProfile(dir);
    const room = path.join(dir, "forks", "3");
    fs.mkdirSync(room, { recursive: true });
    fs.writeFileSync(
      path.join(room, "assignment.json"),
      JSON.stringify({
        instructions: path.join(dir, "depart.md"),
        agents: [
          { id: "critic", name: "Critic", instructions: path.join(dir, "critic.md") },
          { id: "writer", name: "Writer", instructions: path.join(dir, "writer.md") },
        ],
      }),
    );
    let handler: ((a: Record<string, unknown>) => Promise<Response>) | undefined;
    registerOwnerTools(
      {
        registerTool: (name: string, _s: unknown, h: typeof handler) => {
          if (name === "message") handler = h;
        },
      } as unknown as McpServer,
      {
        MIND_WAKE_DATA_DIR: dir,
        MIND_WAKE_OWNER_MESSAGES: "1",
        MIND_WAKE_MESSAGE_SIGNATURE: "Sender",
      },
    );
    const input = {
      to: ["@nlr", "room3", "critic", "principal", "room3"],
      text: "Une observation",
      idempotency_key: "observation-001",
    };
    const first = await handler!(input);
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content[0]!.text).results).toHaveLength(4);
    await handler!(input);
    const store = new SecondThreadStore(room);
    try {
      const entries = store.pendingHuman();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.notice?.label)).toEqual(["Sender", "Sender → Critic"]);
    } finally {
      store.close();
    }
    expect(readOwnerMessages(dir)).toHaveLength(1);
    expect(readOwnerInboxHistory(dir)).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "mobile-call-control.sqlite"))).toBe(false);
    expect(localMessageTargets(dir)).toHaveProperty("critic");
    deliverLocalMessage(dir, {
      to: "writer",
      text: "Message externe",
      author: "⬡atelier",
      key: "m123456789abcdef0",
    });
    const incoming = new SecondThreadStore(room);
    try {
      expect(incoming.pendingHuman().at(-1)?.notice?.label).toBe("⬡atelier → Writer");
    } finally {
      incoming.close();
    }
    fs.mkdirSync(path.join(dir, "pont-p2p"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pont-p2p.json"),
      JSON.stringify({ enabled: true, name: "⬡sender" }),
    );
    fs.writeFileSync(
      path.join(dir, "pont-p2p", "carnet.json"),
      JSON.stringify({
        "⬡other": {
          publicKey: Buffer.alloc(32, 1).toString("base64url"),
          fiche: { agents: [{ id: "critic" }] },
        },
      }),
    );
    const remote = { ...input, to: "⬡other/critic", idempotency_key: "remote-001" };
    const queued = await handler!(remote);
    expect(queued.isError).toBe(false);
    expect(JSON.parse(queued.content[0]!.text).results[0].status).toBe("pending");
    await handler!(remote);
    const requests = fs.readdirSync(path.join(dir, "pont-p2p", "requests"));
    expect(requests).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "pont-p2p", "requests", requests[0]!), "utf8")),
    ).toMatchObject({ kind: "message", to: "⬡other/critic" });
    const partial = await handler!({
      ...input,
      to: ["principal", "inconnu"],
      idempotency_key: "partial-001",
    });
    expect(partial.isError).toBe(true);
    expect(
      JSON.parse(partial.content[0]!.text).results.map((r: { status: string }) => r.status),
    ).toEqual(["recorded", "failed"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
