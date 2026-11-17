/** Rappels martelés : planification (every, expiration, fichier corrompu) et injection. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addReminder,
  readReminders,
  removeReminder,
  remindersPath,
  takeWakeReminders,
  writeReminders,
} from "./wake-reminders.js";
import { composeWake, loadWakeTemplates } from "./wake-prompt.js";

let dir: string;
const T0 = new Date("2026-11-16T18:30:00.000Z");
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-reminders-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("planification", () => {
  it("première injection au réveil suivant, puis tous les `every` réveils", () => {
    takeWakeReminders(dir, 100, T0);
    addReminder(dir, { text: "ACCESS FIRST", every: 3, source: "test" }, T0);
    const hits = [101, 102, 103, 104, 105, 106, 107].filter(
      (n) => takeWakeReminders(dir, n, at(0.1)).due.length > 0,
    );
    expect(hits).toEqual([101, 104, 107]);
  });

  it("défauts : every=10, 24 h ; startWake fixé au premier réveil si aucun compteur connu", () => {
    const r = addReminder(dir, { text: "x", source: "s" }, T0);
    expect(r.every).toBe(10);
    expect(Date.parse(r.expiresAt) - T0.getTime()).toBe(24 * 3_600_000);
    expect(r.startWake).toBeNull();
    expect(takeWakeReminders(dir, 7, at(1)).due).toHaveLength(1);
    expect(readReminders(dir).reminders[0]?.startWake).toBe(7);
    expect(takeWakeReminders(dir, 8, at(1)).due).toHaveLength(0);
    expect(takeWakeReminders(dir, 17, at(1)).due).toHaveLength(1);
  });

  it("expiration : ignoré, signalé une seule fois, puis supprimé", () => {
    takeWakeReminders(dir, 1, T0);
    addReminder(dir, { text: "court", every: 1, hours: 1, source: "s" }, T0);
    expect(takeWakeReminders(dir, 2, at(0.5)).due).toHaveLength(1);
    const first = takeWakeReminders(dir, 3, at(2));
    expect(first.due).toHaveLength(0);
    expect(first.block).toContain('Le rappel "court" a expiré');
    expect(readReminders(dir).reminders).toHaveLength(0);
    expect(takeWakeReminders(dir, 4, at(3)).block).toBe("");
  });

  it("fichier absent ou corrompu : aucun rappel, aucune exception, fichier corrompu non écrasé", () => {
    expect(takeWakeReminders(dir, 1, T0)).toMatchObject({ block: "", due: [] });
    fs.writeFileSync(remindersPath(dir), "{ pas du json");
    expect(takeWakeReminders(dir, 2, T0)).toMatchObject({ block: "", due: [] });
    expect(fs.readFileSync(remindersPath(dir), "utf8")).toBe("{ pas du json");
    expect(readReminders(dir).reminders).toEqual([]);
  });

  it("entrées invalides ignorées ; remove", () => {
    writeReminders(dir, {
      lastWake: 5,
      reminders: [{ id: "bad", every: 0 } as never],
    });
    expect(readReminders(dir).reminders).toEqual([]);
    const r = addReminder(dir, { text: "y", every: 2, source: "s" }, T0);
    expect(r.startWake).toBe(6);
    expect(removeReminder(dir, r.id)).toBe(true);
    expect(removeReminder(dir, r.id)).toBe(false);
    expect(() => addReminder(dir, { text: "z", every: 0, source: "s" })).toThrow();
  });
});

describe("injection", () => {
  it("bloc étiqueté placé avant les événements", () => {
    takeWakeReminders(dir, 1, T0);
    addReminder(dir, { text: "ACCESS FIRST : donne l'accès d'abord.", every: 10, source: "s" }, T0);
    const { block } = takeWakeReminders(dir, 2, at(1));
    expect(block).toMatch(/^Rappels martelés/);
    expect(block).toContain("Rappel de NLR (actif jusqu'au ");
    expect(block).toContain("ACCESS FIRST : donne l'accès d'abord.");
    const base = composeWake({
      templates: loadWakeTemplates(),
      revision: { groups: { runtime: { nativeCapabilities: true }, budget: {} } } as never,
      isolation: "host_unsandboxed",
      onSubscription: false,
      workspaceDir: dir,
      wakeupsDir: dir,
      wakeupsSchema: dir,
      sessionEnd: null,
      theme: null,
      memory: null,
      events: ["evt-1"],
      nextAction: null,
      previousNudge: null,
      agentWakeup: null,
      reminders: block,
    });
    const r = base.text.indexOf("Rappels martelés");
    const e = base.text.indexOf("New events (data):");
    expect(r).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(r);
  });
});
