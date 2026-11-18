/** Rappels martelés : planification (every, expiration, fichier corrompu) et injection. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackOneShotReminder,
  addReminder,
  claimSessionReminders,
  finishSessionReminders,
  readReminders,
  removeReminder,
  remindersPath,
  setOneShotReminder,
  takeWakeReminders,
  writeReminders,
} from "./wake-reminders.js";
import { composeWake, loadWakeTemplates } from "./wake-prompt.js";
import { ownerInboxHook } from "../communication/owner-inbox-hook.js";

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

describe("rappels ponctuels (set_reminder)", () => {
  const take = (n: number, h: number) => takeWakeReminders(dir, n, at(h));

  it("en réveils : livré une seule fois, au réveil N + in_wakes", () => {
    take(10, 0);
    const r = setOneShotReminder(dir, { text: "relire le lecteur", why: "vérifier la bascule A/B", inWakes: 3 }, T0);
    expect(r.dueWake).toBe(13);
    expect(r.dueAt).toBeNull();
    expect(take(11, 0.1).oneShotsDue).toHaveLength(0);
    expect(take(12, 0.2).oneShotsDue).toHaveLength(0);
    const hit = take(13, 0.3);
    expect(hit.oneShotsDue.map((x) => x.id)).toEqual([r.id]);
    expect(hit.block).toContain("Rappels ponctuels arrivés à échéance");
    expect(hit.block).toContain("relire le lecteur");
    expect(hit.block).toContain("Pourquoi : vérifier la bascule A/B");
    expect(hit.block).toContain("Posé le 2026-11-16 18:30 UTC pour le réveil n° 13");
    expect(hit.block).toContain("ack_reminder(id)");
  });

  it("en réveils sans compteur connu : échéance fixée au premier réveil vu", () => {
    const r = setOneShotReminder(dir, { text: "x", why: "y", inWakes: 1 }, T0);
    expect(r.dueWake).toBeNull();
    expect(take(42, 0.1).oneShotsDue).toHaveLength(1);
  });

  it("en minutes : pas avant l'échéance, puis au premier réveil après", () => {
    take(1, 0);
    const r = setOneShotReminder(dir, { text: "regarder la room", why: "réponse attendue", inMinutes: 30 }, T0);
    expect(r.dueAt).toBe("2026-11-16T19:00:00.000Z");
    expect(take(2, 0.25).oneShotsDue).toHaveLength(0);
    const hit = take(3, 1);
    expect(hit.oneShotsDue).toHaveLength(1);
    expect(hit.block).toContain("pour 2026-11-16 19:00 UTC (échu depuis 30 min, livré en retard)");
  });

  it("échu pendant un Off (pause ou à l'écoute, aucun réveil pendant 14 h) : conservé, puis livré au premier réveil", () => {
    take(1, 0);
    const r = setOneShotReminder(dir, { text: "rappeler PC-2", why: "réponse promise", inMinutes: 10 }, T0);
    // Off : aucun réveil, donc aucun takeWakeReminders ; le fichier garde le rappel tel quel.
    expect(readReminders(dir).oneShots?.[0]).toMatchObject({ id: r.id, deliveredAt: null, ackedAt: null });
    const first = take(2, 14);
    expect(first.oneShotsDue.map((x) => x.id)).toEqual([r.id]);
    expect(first.block).toContain("rappeler PC-2");
    expect(first.block).toContain("livré en retard");
    // Non acquitté : il revient « en souffrance » au réveil suivant.
    expect(take(3, 15).oneShotsOverdue.map((x) => x.id)).toEqual([r.id]);
  });

  it("livraison unique puis signalement « en souffrance » jusqu'à l'acquittement", () => {
    take(1, 0);
    const r = setOneShotReminder(dir, { text: "a", why: "b", inWakes: 1 }, T0);
    expect(take(2, 0.1).oneShotsDue).toHaveLength(1);
    const again = take(3, 0.2);
    expect(again.oneShotsDue).toHaveLength(0);
    expect(again.oneShotsOverdue.map((x) => x.id)).toEqual([r.id]);
    expect(again.block).toContain("Rappels en souffrance (livrés mais non acquittés)");
    expect(again.block).toContain("livré au réveil n° 2");
    expect(take(4, 0.3).oneShotsOverdue[0]?.overdueSignals).toBe(2);
    expect(ackOneShotReminder(dir, r.id, at(0.4))).toEqual({ acked: true, wasDelivered: true });
    const after = take(5, 0.5);
    expect(after.oneShotsDue).toHaveLength(0);
    expect(after.oneShotsOverdue).toHaveLength(0);
    expect(after.block).toBe("");
    expect(readReminders(dir).oneShots?.[0]?.ackedAt).not.toBeNull();
    // Acquittés conservés 7 jours puis purgés.
    take(6, 24 * 8);
    expect(readReminders(dir).oneShots).toHaveLength(0);
    expect(ackOneShotReminder(dir, "inconnu")).toEqual({ acked: false, wasDelivered: false });
  });

  it("persistance : relu depuis le fichier, coexistence avec les rappels martelés", () => {
    take(7, 0);
    const m = addReminder(dir, { text: "martelé", every: 1, source: "s" }, T0);
    const r = setOneShotReminder(dir, { text: "ponctuel", why: "w", inMinutes: 5 }, T0);
    const raw = JSON.parse(fs.readFileSync(remindersPath(dir), "utf8")) as Record<string, unknown>;
    expect((raw["oneShots"] as unknown[]).length).toBe(1);
    expect(readReminders(dir).oneShots?.[0]).toMatchObject({ id: r.id, why: "w", inMinutes: 5, deliveredAt: null });
    const hit = take(8, 1);
    expect(hit.due.map((x) => x.id)).toEqual([m.id]);
    expect(hit.oneShotsDue.map((x) => x.id)).toEqual([r.id]);
    expect(hit.block.indexOf("Rappels martelés")).toBeLessThan(hit.block.indexOf("Rappels ponctuels"));
    expect(removeReminder(dir, m.id)).toBe(true);
    expect(readReminders(dir).oneShots).toHaveLength(1);
    expect(removeReminder(dir, r.id)).toBe(true);
    expect(readReminders(dir).oneShots).toHaveLength(0);
  });

  it("refus : ni délai, les deux, délai < 1, why vide ou multiligne ; fichier illisible non écrasé", () => {
    expect(() => setOneShotReminder(dir, { text: "x", why: "y" })).toThrow(/exactement un délai/);
    expect(() => setOneShotReminder(dir, { text: "x", why: "y", inWakes: 1, inMinutes: 1 })).toThrow(
      /exactement un délai/,
    );
    expect(() => setOneShotReminder(dir, { text: "x", why: "y", inWakes: 0 })).toThrow(/in_wakes/);
    expect(() => setOneShotReminder(dir, { text: "x", why: "y", inMinutes: 1.5 })).toThrow(/in_minutes/);
    expect(() => setOneShotReminder(dir, { text: "x", why: " ", inWakes: 1 })).toThrow(/why/);
    expect(() => setOneShotReminder(dir, { text: "x", why: "a\nb", inWakes: 1 })).toThrow(/why/);
    fs.writeFileSync(remindersPath(dir), "{ cassé");
    expect(() => setOneShotReminder(dir, { text: "x", why: "y", inWakes: 1 })).toThrow(/illisible/);
    expect(fs.readFileSync(remindersPath(dir), "utf8")).toBe("{ cassé");
  });

  it("en cours de session : poussé une fois, puis en souffrance au réveil suivant si non acquitté", () => {
    take(1, 0);
    const r = setOneShotReminder(dir, { text: "relancer l'agent", why: "écart de volume", inMinutes: 10 }, T0);
    expect(claimSessionReminders(dir, "c0", at(0.1))).toBeNull();
    const text = claimSessionReminders(dir, "c1", at(0.2));
    expect(text).toContain("rappel ponctuel (posé par toi-même, pas un message de ton humain)");
    expect(text).toContain("relancer l'agent");
    // Réservé : un autre consommateur ne le reprend pas.
    expect(claimSessionReminders(dir, "c2", at(0.2))).toBeNull();
    finishSessionReminders(dir, "c1", true, at(0.2));
    expect(readReminders(dir).oneShots?.[0]).toMatchObject({ deliveredVia: "session", claim: null });
    expect(claimSessionReminders(dir, "c3", at(0.3))).toBeNull();
    const next = take(2, 0.5);
    expect(next.oneShotsDue).toHaveLength(0);
    expect(next.oneShotsOverdue.map((x) => x.id)).toEqual([r.id]);
    expect(next.block).toContain("livré en cours de session");
  });

  it("en cours de session : réservation non confirmée → libérée puis livrée au réveil", () => {
    take(1, 0);
    setOneShotReminder(dir, { text: "x", why: "y", inMinutes: 1 }, T0);
    expect(claimSessionReminders(dir, "c1", at(0.1))).not.toBeNull();
    finishSessionReminders(dir, "c1", false, at(0.1));
    expect(readReminders(dir).oneShots?.[0]?.deliveredAt).toBeNull();
    expect(take(2, 0.2).oneShotsDue).toHaveLength(1);
  });

  it("hook d'inbox Claude : pousse le rappel échu dans additionalContext, une seule fois", () => {
    take(1, 0);
    const now = new Date();
    setOneShotReminder(dir, { text: "rappel hook", why: "test", inMinutes: 1 }, new Date(now.getTime() - 120_000));
    const ev = { session_id: "s", hook_event_name: "PostToolUse" };
    const out = ownerInboxHook(dir, "s", ev) as { hookSpecificOutput?: { additionalContext?: string } } | null;
    expect(out?.hookSpecificOutput?.additionalContext).toContain("rappel hook");
    expect(readReminders(dir).oneShots?.[0]?.deliveredVia).toBe("session");
    expect(ownerInboxHook(dir, "s", ev)).toBeNull();
  });
});
