import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeHumanWake,
  HUMAN_WAKE_TTL_MS,
  humanWakeFileFor,
  pendingHumanWake,
  requestHumanWake,
} from "./human-wake.js";

let dir: string;
const NOW = Date.parse("2026-10-29T12:00:00Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "human-wake-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("réveil demandé par l'humain", () => {
  it("demande → échéance candidate, consommée une fois servie", () => {
    expect(pendingHumanWake(dir, NOW)).toBeNull();
    requestHumanWake(dir, NOW);
    expect(pendingHumanWake(dir, NOW + 1000)).toBe(NOW);
    consumeHumanWake(dir);
    expect(pendingHumanWake(dir, NOW + 2000)).toBeNull();
  });

  it("expire après une heure et retire le fichier", () => {
    requestHumanWake(dir, NOW);
    expect(pendingHumanWake(dir, NOW + HUMAN_WAKE_TTL_MS + 1)).toBeNull();
    expect(fs.existsSync(humanWakeFileFor(dir))).toBe(false);
  });

  it("contenu illisible ou de version inconnue : ignoré et retiré", () => {
    fs.writeFileSync(humanWakeFileFor(dir), "pas du json");
    expect(pendingHumanWake(dir, NOW)).toBeNull();
    fs.writeFileSync(
      humanWakeFileFor(dir),
      JSON.stringify({ version: 2, requestedAt: new Date(NOW).toISOString() }),
    );
    expect(pendingHumanWake(dir, NOW)).toBeNull();
    expect(fs.existsSync(humanWakeFileFor(dir))).toBe(false);
  });
});
