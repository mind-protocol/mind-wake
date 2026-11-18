import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { it, expect } from "vitest";
// @ts-expect-error HyperDHT testnet provides no TypeScript declaration.
import createTestnet from "hyperdht/testnet.js";
import { seedSimulatedProfile } from "./demo/harness.js";
import { pontAction } from "../services/pont-p2p/settings.mjs";
import { messageStatus, resolveFromDisk } from "../services/pont-p2p/state.mjs";
import { registerOwnerTools } from "../services/mcp/owner-tools.js";
import { SecondThreadStore } from "../src/daemon/second-thread.js";
import type { McpServer } from "@modelcontextprotocol/server";

type Net = { bootstrap: { host: string; port: number }[]; destroy: () => Promise<void> };
type Response = { isError?: boolean; content: { text: string }[] };
async function until(check: () => boolean) {
  const end = Date.now() + 20000;
  while (!check()) {
    if (Date.now() > end) throw Error("network test timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
it("delivers a unified MCP message to the selected remote agent through two real colony services", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "message-network-"));
  const net = await (createTestnet as (n: number) => Promise<Net>)(3);
  const children: ChildProcess[] = [];
  try {
    const a = path.join(dir, "alpha"),
      b = path.join(dir, "beta");
    for (const d of [a, b]) {
      fs.mkdirSync(d);
      seedSimulatedProfile(d);
    }
    const room = path.join(b, "forks", "3");
    fs.mkdirSync(room, { recursive: true });
    fs.writeFileSync(
      path.join(room, "assignment.json"),
      JSON.stringify({
        instructions: path.join(b, "depart.md"),
        agents: [{ id: "critic", name: "Critic", instructions: path.join(b, "critic.md") }],
      }),
    );
    for (const [d, name] of [
      [a, "⬡alpha"],
      [b, "⬡beta"],
    ] as const) {
      await pontAction(d, "enable", { name });
      const child = fork(
        path.resolve("services/pont-p2p/main.mjs"),
        ["--data-dir", d, "--wakeups-dir", path.join(d, "wakeups")],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...process.env,
            MW_P2P_BOOTSTRAP: JSON.stringify(net.bootstrap),
            MW_P2P_RETRY_MS: "500",
            MW_P2P_TICK_MS: "100",
          },
        },
      );
      children.push(child);
      let ready = false;
      child.on("message", (m) => {
        if ((m as { event?: string }).event === "ready") ready = true;
      });
      await until(() => ready);
    }
    await until(() => resolveFromDisk(a, "⬡beta/critic").ok);
    let handler: ((a: Record<string, unknown>) => Promise<Response>) | undefined;
    registerOwnerTools(
      {
        registerTool: (name: string, _s: unknown, h: typeof handler) => {
          if (name === "message") handler = h;
        },
      } as unknown as McpServer,
      { MIND_WAKE_DATA_DIR: a, MIND_WAKE_OWNER_MESSAGES: "1" },
    );
    const input = {
      to: "⬡beta/critic",
      text: "Écoute la seconde prise.",
      idempotency_key: "network-message-001",
    };
    const result = await handler!(input);
    expect(result.isError).toBe(false);
    const id = (JSON.parse(result.content[0]!.text) as { results: { id: string }[] }).results[0]!
      .id;
    await until(() => messageStatus(a, id)["status"] === "livré");
    await handler!(input);
    const store = new SecondThreadStore(room);
    try {
      const messages = store.pendingHuman();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toContain(input.text);
      expect(messages[0]?.notice?.label).toBe("⬡alpha → Critic");
    } finally {
      store.close();
    }
    expect(fs.existsSync(path.join(b, "mobile-call-control.sqlite"))).toBe(false);
  } finally {
    await Promise.all(
      children.map(async (c) => {
        if (c.exitCode !== null) return;
        const done = new Promise<void>((resolve) => c.once("exit", () => resolve()));
        c.send({ cmd: "stop" });
        await done;
      }),
    );
    await net.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
