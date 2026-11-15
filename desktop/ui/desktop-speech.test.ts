import { expect, it, vi } from "vitest";
import { desktopSpeech } from "./desktop-speech.js";
const at = "2026-11-04T20:40:00Z";
it("reads fresh principal prose only; first load, pagination, edits and peer/human/tool messages are silent", async () => {
  const speak = vi.fn(async () => {});
  const reader = desktopSpeech({
    speak,
    error: vi.fn(),
    now: () => Date.parse(at),
  });
  const agent = { id: "old", at, text: "Archive", from: "agent" };
  reader.observe([agent]);
  reader.observe([
    agent,
    { ...agent, id: "older", at: "2026-11-01T00:00:00Z" },
    ...["human", "session", "received", "activity", "sent"].map((from) => ({
      ...agent,
      id: from,
      from,
    })),
    { ...agent, id: "peer", source: "Reddit" },
    // La réponse rapide demande sa voix elle-même : pas de seconde génération ici.
    { ...agent, id: "fast", text: "⚡ Je regarde ça." },
    { ...agent, id: "new", text: "**Ça marche.**" },
  ]);
  await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
  expect(speak).toHaveBeenCalledWith("**Ça marche.**", "reply:new");
  reader.observe([{ ...agent, id: "new", text: "édition" }]);
  expect(speak).toHaveBeenCalledTimes(1);
});
it("bounds a burst and serializes generation, with no automatic retry on error", async () => {
  let finish!: () => void;
  const speak = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const reader = desktopSpeech({
    speak,
    error: vi.fn(),
    now: () => Date.parse(at),
  });
  reader.observe([]);
  reader.observe(
    Array.from({ length: 8 }, (_, id) => ({
      id: String(id),
      from: "agent",
      at,
      text: "Réponse",
    })),
  );
  expect(speak).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
  finish();
  await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(3));
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(speak).toHaveBeenCalledTimes(3);
});
it("never speaks an unseen paginated message even if it was dated after app startup", async () => {
  let time = Date.parse(at);
  const speak = vi.fn(async () => {});
  const reader = desktopSpeech({ speak, error: vi.fn(), now: () => time });
  reader.observe([]);
  time += 10_000;
  const older = {
    id: "pagination-after-start",
    from: "agent",
    text: "Ancien message",
    at: new Date(time - 5_000).toISOString(),
  };
  reader.observe([older], "history");
  reader.observe([older], "live");
  expect(speak).not.toHaveBeenCalled();
  reader.observe([{ ...older, id: "edited", edited: true }]);
  expect(speak).not.toHaveBeenCalled();
  time += 70_000;
  reader.observe([{ ...older, id: "backfill" }]);
  expect(speak).not.toHaveBeenCalled();
  reader.observe([
    { ...older, id: "actual-new", at: new Date(time).toISOString() },
  ]);
  await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());
});
