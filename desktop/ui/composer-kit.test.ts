import { afterEach, expect, it, vi } from "vitest";
import { DraftStore, enterSends, noteTyping, Outbox, typingIdle } from "./composer-kit.js";

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};
const key = (over: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: () => {}, ...over,
});
afterEach(() => { vi.useRealTimers(); noteTyping(0); });

it("Entrée envoie ; Maj+Entrée, la composition IME et les autres touches n'envoient pas", () => {
  expect(enterSends(key())).toBe(true);
  expect(enterSends(key({ shiftKey: true }))).toBe(false);
  expect(enterSends(key({ isComposing: true }))).toBe(false);
  expect(enterSends(key({ keyCode: 229 }))).toBe(false);
  expect(enterSends(key({ key: "a" }))).toBe(false);
});

it("garde un brouillon par conversation et l'efface quand il est vide", () => {
  const storage = memory(), drafts = new DraftStore(storage, "d.");
  drafts.set(2, "Room deux");
  drafts.set(3, "Room trois");
  expect(new DraftStore(storage, "d.").get(2)).toBe("Room deux");
  drafts.set(2, "");
  expect(storage.values.has("d.2")).toBe(false);
  expect(drafts.get(3)).toBe("Room trois");
  expect(new DraftStore(undefined, "d.").get(2)).toBe("");
});

it("la file d'envoi survit au rechargement jusqu'à confirmation", () => {
  const storage = memory();
  new Outbox(storage, "o").add({ key: "ui-1", text: "bonjour", at: "2026-11-15T13:47:00Z" });
  const reloaded = new Outbox(storage, "o");
  expect(reloaded.list().map((o) => o.text)).toEqual(["bonjour"]);
  reloaded.remove("ui-1");
  expect(reloaded.list()).toEqual([]);
  storage.setItem("o", "{cassé");
  expect(reloaded.list()).toEqual([]);
});

it("les lectures lourdes attendent une pause de frappe, sans jamais attendre plus que le plafond", async () => {
  vi.useFakeTimers();
  let now = 10_000;
  const clock = () => now;
  noteTyping(now);
  let done = false;
  void typingIdle(1000, 5000, clock).then(() => { done = true; });
  now += 500; await vi.advanceTimersByTimeAsync(500);
  expect(done).toBe(false);
  now += 600; await vi.advanceTimersByTimeAsync(600);
  expect(done).toBe(true);
  // Frappe continue : libéré au plafond.
  noteTyping(now);
  let capped = false;
  const start = now;
  void typingIdle(1000, 5000, clock).then(() => { capped = true; });
  while (!capped && now - start < 6000) { now += 200; noteTyping(now); await vi.advanceTimersByTimeAsync(200); }
  expect(capped).toBe(true);
  expect(now - start).toBeLessThanOrEqual(5400);
});
