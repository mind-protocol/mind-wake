import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OwnerMessages, readOwnerMessages } from "./owner-messages.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-msg-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it("publishes once, edits in place, rejects stale edits and deletes without resurrection", () => {
  expect(readOwnerMessages(dir)).toBeNull();
  const store = new OwnerMessages(dir, "agent-a");
  try {
    const sent = store.publish("Bonjour", "intro-001");
    expect(store.publish("Bonjour", "intro-001").id).toBe(sent.id);
    const edited = store.change(sent.id, 1, "Une découverte");
    expect(edited).toMatchObject({ id: sent.id, text: "Une découverte", version: 2 });
    expect(store.list()).toHaveLength(1);
    expect(() => store.change(sent.id, 1, "Ancien brouillon")).toThrow(/changed/);
    expect(() => store.publish("Autre", "intro-001")).toThrow(/already used/);
    store.change(sent.id, 2, null);
    expect(store.change(sent.id, 2, null).deleted).toBe(true);
    expect(readOwnerMessages(dir)).toEqual([]);
    expect(() => store.change(sent.id, 3, "Ressusciter")).toThrow(/deleted/);
  } finally {
    store.close();
  }
});
it("cannot modify another agent's message, and leaves the human log alone", () => {
  const human = path.join(dir, "human-messages.jsonl");
  fs.writeFileSync(human, '{"text":"Réponse humaine"}\n');
  const a = new OwnerMessages(dir, "a"),
    b = new OwnerMessages(dir, "b");
  try {
    const m = a.publish("Salut", "request-a");
    expect(() => b.change(m.id, 1, "Imposture")).toThrow(/owned/);
    expect(() => b.change(m.id, 1, null)).toThrow(/owned/);
    a.change(m.id, 1, null);
    expect(fs.readFileSync(human, "utf8")).toContain("Réponse humaine");
  } finally {
    a.close();
    b.close();
  }
});
it("adopts the old note without switching display until a successful edit", () => {
  const store = new OwnerMessages(dir, "a");
  try {
    store.adoptLegacy("Ancien questionnaire", 1000, "2026-10-29T10:00:00.000Z");
    expect(readOwnerMessages(dir)).toBeNull();
    expect(() => store.change("legacy-note", 999, "Correction")).toThrow(/changed/);
    expect(readOwnerMessages(dir)).toBeNull();
    store.change("legacy-note", 1000, "Une nouvelle découverte");
    expect(readOwnerMessages(dir)?.[0]?.text).toBe("Une nouvelle découverte");
    store.change("legacy-note", 1001, null);
    expect(readOwnerMessages(dir)).toEqual([]);
  } finally {
    store.close();
  }
});
