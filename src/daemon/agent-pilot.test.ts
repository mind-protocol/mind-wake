import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_PILOT_FILE, readAgentPilot } from "./agent-pilot.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pilot-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(value: unknown): void {
  fs.writeFileSync(path.join(dir, AGENT_PILOT_FILE), JSON.stringify(value));
}

describe("readAgentPilot", () => {
  it("lit le seuil et la demande de compaction choisis par l'agent", () => {
    write({ version: 1, compactAboveTokens: 1_500_000, compactRequest: "r-20h30" });
    expect(readAgentPilot(dir)).toEqual({
      compactAboveTokens: 1_500_000,
      compactRequest: "r-20h30",
    });
    write({ version: 1, compactAboveTokens: 0 });
    expect(readAgentPilot(dir)).toEqual({ compactAboveTokens: 0 });
  });

  it("absent, illisible ou hors schéma : ignoré en entier", () => {
    expect(readAgentPilot(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, AGENT_PILOT_FILE), "pas du json");
    expect(readAgentPilot(dir)).toBeNull();
    for (const bad of [
      { version: 2, compactAboveTokens: 1 },
      { version: 1, compactAboveTokens: -1 },
      { version: 1, compactAboveTokens: 1.5 },
      { version: 1, compactRequest: "" },
      { version: 1, compactRequest: 42 },
      [1],
    ]) {
      write(bad);
      expect(readAgentPilot(dir)).toBeNull();
    }
  });
});
