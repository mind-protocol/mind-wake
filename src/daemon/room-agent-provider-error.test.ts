import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runRoomAgentsTurn } from "./room-agents.js";
import { SecondThreadStore } from "./second-thread.js";
import type { ForkAssignment } from "./fork-assignment.js";

it("retains a provider limit as an event, never a normal voice reply", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-provider-diagnostic-"));
  const workspace = path.join(dataDir, "workspace");
  const dir = path.join(dataDir, "forks", "6");
  fs.mkdirSync(path.join(workspace, "own"), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const instructions = path.join(workspace, "own", "SYSTEM.md");
  fs.writeFileSync(instructions, "# Fixture role\nRespond briefly.\n");
  const assignment: ForkAssignment = {
    engine: "claude", instructions, workspace, writable: ["own"], holder: null,
    inbox: "explicit", owner: null, assignedAt: new Date().toISOString(),
    agents: [{ id: "fixture-role", name: "Fixture role", instructions, writable: ["own"],
      owner: { colony: null, profile: "publish" }, tools: "none", private: false }],
  };
  const store = new SecondThreadStore(dir);
  try {
    store.add("human", "Bonjour", null, null);
    await runRoomAgentsTurn({ dataDir, dir, id: 6, assignment, store,
      human: store.pendingHuman(), n: store.beginTurn(null), control: () => "run",
      claudeTurn: async () => ({ sessionId: "fixture", outcome: "rate_limited", text: "You've hit your weekly limit",
        accepted: true, tokens: 0, detail: "limite du fournisseur", retryAtMs: Date.now() + 60_000 }),
    });
    expect(store.entries(20).filter(e => e.role === "agent")).toEqual([]);
    expect(store.entries(20).some(e => e.role === "event" && e.text.includes("limite du fournisseur"))).toBe(true);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
