import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readOwnerMessages } from "./owner-messages.js";
import { saveFastReplyEnabled, type ClaudeAnswer, type WarmClaude } from "./fast-reply.js";
import { FastReplyService, waitingHumanMessages } from "./fast-reply-server.js";

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-reply-server-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function human(id: string, text: string, at = new Date().toISOString()) {
  fs.appendFileSync(
    path.join(dataDir, "human-messages.jsonl"),
    `${JSON.stringify({ id, at, text })}\n`,
  );
}

/** Faux Claude préchauffé : compte les lancements et les prompts reçus. */
function fakeClaudes(answer: string) {
  const launched: { prompt: string | null; disposed: boolean }[] = [];
  const start = (_claude: unknown, args: readonly string[]): WarmClaude => {
    const entry = { prompt: null as string | null, disposed: false };
    launched.push(entry);
    return {
      startedAt: Date.now(),
      args: [...args],
      alive: () => entry.prompt === null && !entry.disposed,
      answer: (prompt: string): Promise<ClaudeAnswer> => {
        entry.prompt = prompt;
        return Promise.resolve({ text: answer });
      },
      dispose: () => {
        entry.disposed = true;
      },
    };
  };
  return { launched, start };
}

const claude = { executable: "unused", model: "sonnet" };
const quiet = () => Promise.resolve({ ok: true as const });

it("keeps one Claude warm, answers a new human message with it, then warms the next", async () => {
  saveFastReplyEnabled(dataDir, true);
  const fake = fakeClaudes("Je regarde ça.");
  const service = new FastReplyService({ dataDir, claude, start: fake.start, speak: quiet });
  await service.tick();
  expect(fake.launched).toHaveLength(1);
  expect(fake.launched[0]?.prompt).toBeNull();

  human("ui-1", "tu bosses sur quoi ?");
  expect(waitingHumanMessages(dataDir)).toEqual(["ui-1"]);
  await service.tick();
  // Le Claude déjà lancé a reçu le prompt ; un autre attend le message suivant.
  expect(fake.launched[0]?.prompt).toContain("tu bosses sur quoi ?");
  expect(fake.launched).toHaveLength(2);
  expect(fake.launched[1]?.prompt).toBeNull();
  expect(readOwnerMessages(dataDir)?.map((m) => m.text)).toEqual(["⚡ Je regarde ça."]);
  expect(waitingHumanMessages(dataDir)).toEqual([]);

  // Rien de nouveau : pas d'appel, pas de relance.
  await service.tick();
  expect(fake.launched).toHaveLength(2);
  await service.close();
  expect(fake.launched[1]?.disposed).toBe(true);
});

it("launches nothing while disabled or stopped, and ignores old or probe messages", async () => {
  const fake = fakeClaudes("x");
  let allowed = true;
  const service = new FastReplyService({
    dataDir,
    claude,
    start: fake.start,
    speak: quiet,
    allowed: () => allowed,
  });
  human("ui-1", "salut");
  await service.tick();
  expect(fake.launched).toHaveLength(0);

  saveFastReplyEnabled(dataDir, true);
  allowed = false;
  await service.tick();
  expect(fake.launched).toHaveLength(0);

  allowed = true;
  human("ui-old", "ancien", new Date(Date.now() - 5 * 60_000).toISOString());
  human("latency-LAT-1", "sonde");
  expect(waitingHumanMessages(dataDir)).toEqual(["ui-1"]);
  await service.close();
});

it("beats while running so human messages wait for the ⚡, and stops beating when closed", async () => {
  saveFastReplyEnabled(dataDir, true);
  const service = new FastReplyService({
    dataDir,
    claude,
    start: fakeClaudes("x").start,
    speak: quiet,
  });
  const beat = path.join(dataDir, "fast-reply-server.json");
  await service.tick();
  const state = JSON.parse(fs.readFileSync(beat, "utf8")) as { heartbeatAt: string };
  expect(Date.now() - Date.parse(state.heartbeatAt)).toBeLessThan(8_000);
  await service.close();
  expect(fs.existsSync(beat)).toBe(false);
});
