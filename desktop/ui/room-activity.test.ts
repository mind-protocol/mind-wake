import { expect, it } from "vitest";
import { RECENT_MS, roomActivity, roomAwaitsOwner, type RoomActivityFork } from "./room-activity.js";

const now = Date.parse("2026-11-18T14:30:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const DAY = 24 * 3600 * 1000;
const idle: RoomActivityFork = { enabled: false, lastTurn: { endedAt: ago(2 * DAY) }, entries: [] };
const state = { selected: false, working: false, unread: 0, now };

it("cache une salle immobile, Off, sans question ouverte", () => {
  const fork = { ...idle, entries: [
    { at: ago(3 * DAY), role: "human" as const, text: "Peux-tu préparer le dossier ?" },
    { at: ago(2 * DAY), role: "agent" as const, text: "Dossier prêt." },
  ] };
  expect(roomActivity(fork, state)).toBeNull();
});

it("garde visible une salle immobile qui attend une réponse de NLR (même Off, même ancienne)", () => {
  const fork = { ...idle, entries: [
    { at: ago(9 * DAY), role: "human" as const, text: "Lance la maquette." },
    { at: ago(8 * DAY), role: "agent" as const, text: "Deux options : A ou B ? Je garde la main en attendant." },
  ] };
  expect(roomAwaitsOwner(fork, 0)).toBe(true);
  expect(roomActivity(fork, state)).toBe("attend ta réponse");
  // NLR a répondu après la question : plus d'attente.
  const answered = { ...fork, entries: [...fork.entries, { at: ago(7 * DAY), role: "human" as const, text: "B." }] };
  expect(roomActivity(answered, state)).toBeNull();
  // Une question d'une autre salle (senderFork) ou une notice ne vaut pas réponse de NLR.
  const relayed = { ...fork, entries: [...fork.entries, { at: ago(7 * DAY), role: "human" as const, text: "ok", senderFork: 3 }] };
  expect(roomActivity(relayed, state)).toBe("attend ta réponse");
});

it("un message non lu garde la salle visible", () => {
  const fork = { ...idle, entries: [{ at: ago(5 * DAY), role: "agent" as const, text: "Fini." }] };
  expect(roomActivity(fork, { ...state, unread: 1 })).toBe("attend ta réponse");
});

it("ouverte, au travail ou récemment active : visible", () => {
  expect(roomActivity(idle, { ...state, selected: true })).toBe("ouverte");
  expect(roomActivity({ ...idle, enabled: true, lastTurn: { endedAt: null } }, state)).toBe("travaille");
  expect(roomActivity(idle, { ...state, working: true })).toBe("travaille");
  const recent = { enabled: true, lastTurn: { endedAt: ago(60_000) }, entries: [{ at: ago(60_000), role: "event" as const, text: "tour" }] };
  expect(roomActivity(recent, state)).toBe("récente");
  expect(roomActivity({ ...recent, entries: [{ ...recent.entries[0]!, at: ago(RECENT_MS + 1) }] }, state)).toBeNull();
  // Récente mais Off : considérée archivée.
  expect(roomActivity({ ...recent, enabled: false }, state)).toBeNull();
  // Activité publique récente seule.
  expect(roomActivity({ ...recent, entries: [], activity: [{ at: ago(1000) }] }, state)).toBe("récente");
});
