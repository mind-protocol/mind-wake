/**
 * Réveil par @handle vers la room (mandat « une room, plusieurs agents », point 4) : un coach
 * agent d'une room y est réveillé, adressé à lui seul ; un coach sans room reste un holder.
 * Appels Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "../src/communication/fast-reply.js";
import { OwnerMessages } from "../src/communication/owner-messages.js";
import { tickPatternHolders } from "../src/communication/pattern-holders.js";
import { ROOM_HANDLE_WAKES_STATE } from "../src/communication/room-handle-wake.js";
import { forkDir, setForkEnabled } from "../src/daemon/forks.js";
import { saveForkAssignment } from "../src/daemon/fork-assignment.js";
import { routeRoomMessage } from "../src/daemon/room-agents.js";
import { SecondThreadStore } from "../src/daemon/second-thread.js";

let dataDir: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const workspace = () => path.join(dataDir, "workspace");
const holdersDir = () => path.join(workspace(), "artifacts", "pattern-holders");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-handle-wake-"));
  for (const slug of ["coach-colony", "coach-telegram"]) {
    const dir = path.join(holdersDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_holder.md"),
      `# ${slug}\n\n\`\`\`json pattern-holder\n{ "name": "${slug}", "emoji": "🧭" }\n\`\`\`\n`,
    );
  }
  fs.writeFileSync(
    path.join(holdersDir(), "COACHS-REGISTRE.json"),
    JSON.stringify({
      coachs: { "coach-telegram": { nom: "Coach Telegram", prive: true } },
      personnes: [
        { id: "spark-the-cat", coach: "coach-colony", handles: [{ handle: "spark-the-cat" }], fiche: "artifacts/pattern-holders/coach-colony/spark-the-cat.md" },
        { id: "marie", coach: "coach-telegram", handles: [{ handle: "marie_t" }] },
      ],
    }),
  );
  const room = path.join(workspace(), "room-fixeurs");
  fs.mkdirSync(room, { recursive: true });
  fs.writeFileSync(path.join(room, "ROOM2.md"), "Room 2.");
  // Coach Colony est agent de la Room 2 ; Coach Telegram n'est agent d'aucune room.
  saveForkAssignment(forkDir(dataDir, 2), {
    instructions: path.join(room, "ROOM2.md"),
    engine: "claude",
    workspace: workspace(),
    agents: [
      {
        id: "coach-colony",
        name: "Coach Colony",
        instructions: path.join(holdersDir(), "coach-colony"),
        writable: ["artifacts/pattern-holders/coach-colony"],
        owner: { colony: "colony-fixeur.json" },
        tools: "publish",
      },
    ],
  });
  setForkEnabled(dataDir, 2, true);
  clock = Date.parse("2026-11-16T10:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function human(id: string, text: string, at: string) {
  fs.appendFileSync(path.join(dataDir, "human-messages.jsonl"), `${JSON.stringify({ id, at, text })}\n`);
}
const replying =
  (text: string, seen: { holder: string; prompt: string }[] = []): typeof CallClaude =>
  (_claude, _args, prompt, cwd) => {
    if (prompt.includes('"candidats"')) return Promise.resolve({ text: "[]" });
    seen.push({ holder: path.basename(cwd), prompt });
    return Promise.resolve({ text });
  };
function roomEntries() {
  const store = new SecondThreadStore(forkDir(dataDir, 2));
  try {
    return store.pendingHuman();
  } finally {
    store.close();
  }
}

it("réveille le coach dans sa room, adressé à lui seul, avec le texte de réveil existant", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  await tickPatternHolders({ dataDir, claude, call: replying("x", seen), now });
  human("m1", "On en parle avec @spark-the-cat demain ?", iso(-30_000));
  const outcomes = await tickPatternHolders({ dataDir, claude, call: replying("x", seen), now });
  // Plus de réveil en holder pour ce coach.
  expect(outcomes.filter((o) => o.slug === "coach-colony")).toEqual([]);
  expect(seen.filter((s) => s.prompt.includes("est mentionné ici"))).toEqual([]);
  const pending = roomEntries();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.notice?.label).toBe("@handle → Coach Colony");
  expect(pending[0]!.text).toContain("@spark-the-cat est mentionné ici. Tu es son coach dans le mesh.");
  expect(pending[0]!.text).toContain("Sa fiche : artifacts/pattern-holders/coach-colony/spark-the-cat.md");
  expect(pending[0]!.text).toContain("On en parle avec @spark-the-cat demain ?");
  // Dans la room, la notice ne va qu'à Coach Colony.
  const agents = [{ id: "coach-colony", name: "Coach Colony" }, { id: "coach-telegram", name: "Coach Telegram" }].map((a) => ({
    ...a, instructions: "", writable: [], owner: { colony: null, profile: "publish" as const }, tools: "none" as const, private: false,
  }));
  expect(routeRoomMessage(pending[0]!, agents, null).recipients).toEqual(["coach-colony"]);
  // Un second passage ne remet rien deux fois.
  await tickPatternHolders({ dataDir, claude, call: replying("x", seen), now });
  expect(roomEntries()).toHaveLength(1);
});

it("un coach qui n'est agent d'aucune room reste réveillé en holder", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  await tickPatternHolders({ dataDir, claude, call: replying("SILENCE", seen), now });
  human("m1", "Qu'en pense @marie_t ?", iso(-30_000));
  const outcomes = await tickPatternHolders({ dataDir, claude, call: replying("SILENCE", seen), now });
  expect(outcomes).toEqual([expect.objectContaining({ slug: "coach-telegram", reason: "handle" })]);
  expect(roomEntries()).toEqual([]);
});

it("premier passage au présent, et rien pour un message d'agent ou de holder (garde de boucle)", async () => {
  human("m0", "Ancien : @spark-the-cat", iso(-60_000));
  await tickPatternHolders({ dataDir, claude, call: replying("x"), now });
  expect(roomEntries()).toEqual([]);
  expect(fs.existsSync(path.join(dataDir, ROOM_HANDLE_WAKES_STATE))).toBe(true);
  const messages = new OwnerMessages(dataDir, "claude-wake");
  try {
    messages.publish("Coach Colony : je relis @spark-the-cat.", "room-agent:test:1", iso(-30_000));
  } finally {
    messages.close();
  }
  await tickPatternHolders({ dataDir, claude, call: replying("x"), now });
  expect(roomEntries()).toEqual([]);
});

it("un essai (dryRun) ne remet rien à la room", async () => {
  await tickPatternHolders({ dataDir, claude, call: replying("x"), now });
  human("m1", "Et @spark-the-cat ?", iso(-30_000));
  await tickPatternHolders({ dataDir, claude, call: replying("x"), now, dryRun: true });
  expect(roomEntries()).toEqual([]);
});
