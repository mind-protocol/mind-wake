/**
 * Holders assignés aux salles comme des agents (NLR, 18 nov. 2026 14:19) : une entrée
 * `{ "id": slug, "kind": "holder" }` de `agents`. Appels Claude simulés, aucun appel fournisseur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { readOwnerMessages } from "./owner-messages.js";
import { forkDir, readForks, sendToFork, setForkEnabled } from "../daemon/forks.js";
import {
  isMultiAgentRoom,
  readForkAssignment,
  resolveRoomAgents,
  roomHolderSlugs,
  saveForkAssignment,
  validateAssignment,
} from "../daemon/fork-assignment.js";
import { roomParticipants } from "../daemon/room-participants.js";
import { SecondThreadStore } from "../daemon/second-thread.js";
import { holderThread, holderThreads, readPatternHolderState, tickPatternHolders } from "./pattern-holders.js";

let dataDir: string;
let space: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;

const HOLDER = `# Holder

\`\`\`json pattern-holder
{ "name": "Crypto", "emoji": "🪙" }
\`\`\`

**NLR** : un wallet n'est jamais partagé entre deux agents.
`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "holders-salles-"));
  const holders = path.join(dataDir, "workspace", "artifacts", "pattern-holders");
  fs.mkdirSync(holders, { recursive: true });
  fs.writeFileSync(path.join(holders, "crypto.md"), HOLDER);
  space = path.join(dataDir, "room");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "ROOM.md"), "Tu es la room.");
  fs.writeFileSync(path.join(space, "COACH.md"), "Tu es un coach.");
  clock = Date.parse("2026-11-18T14:30:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const coach = () => ({ id: "coach-a", name: "Coach A", instructions: path.join(space, "COACH.md"), writable: ["coach-a"] });
const assign = (id: number, agents: unknown[], extra: Record<string, unknown> = {}) =>
  saveForkAssignment(forkDir(dataDir, id), {
    instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space, agents, ...extra,
  });
const replying =
  (text: string, seen: string[] = []): typeof CallClaude =>
  (_claude, _args, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text });
  };
const tick = (call: typeof CallClaude) => tickPatternHolders({ dataDir, claude, call, now });
const roomEntries = (id: number) => {
  const store = new SecondThreadStore(forkDir(dataDir, id));
  try {
    return store.entries(50);
  } finally {
    store.close();
  }
};

it("accepts a holder in the agents list without turning the room into a multi-agent room", () => {
  const a = validateAssignment({
    instructions: path.join(space, "ROOM.md"), engine: "codex", workspace: space,
    agents: [{ id: "crypto", kind: "holder" }],
  });
  expect(a.agents).toBeUndefined();
  expect(a.roomHolders).toEqual(["crypto"]);
  expect(isMultiAgentRoom(a)).toBe(false);
  expect(roomHolderSlugs(a)).toEqual(["crypto"]);
  // Le champ historique reste lu, sans doublon.
  expect(roomHolderSlugs({ ...a, holder: "crypto" })).toEqual(["crypto"]);
});

it("keeps agent sessions and room holders apart, and writes them back in one agents list", () => {
  const saved = assign(3, [coach(), { id: "crypto", kind: "holder" }]);
  expect(saved.agents?.map((x) => x.id)).toEqual(["coach-a"]);
  expect(resolveRoomAgents(saved).map((x) => x.id)).toEqual(["coach-a"]);
  const raw = JSON.parse(fs.readFileSync(path.join(forkDir(dataDir, 3), "assignment.json"), "utf8")) as { agents: unknown[] };
  expect(raw.agents).toEqual([expect.objectContaining({ id: "coach-a", name: "Coach A" }), { id: "crypto", kind: "holder" }]);
  expect(readForkAssignment(forkDir(dataDir, 3))).toEqual(saved);
});

it("rejects malformed holder entries", () => {
  const base = { instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space };
  expect(() => validateAssignment({ ...base, agents: [{ id: "crypto", kind: "coach" }] })).toThrow(/kind/);
  expect(() => validateAssignment({ ...base, agents: [{ id: "crypto", kind: "holder", name: "X" }] })).toThrow(/inconnu/);
  expect(() => validateAssignment({ ...base, agents: [{ id: "Crypto!", kind: "holder" }] })).toThrow(/slug/);
  expect(() =>
    validateAssignment({ ...base, agents: [{ id: "crypto", kind: "holder" }, { id: "crypto", kind: "holder" }] }),
  ).toThrow(/double/);
  expect(() =>
    validateAssignment({ ...base, agents: [{ id: "coach-a", kind: "holder" }, coach()] }),
  ).toThrow(/double/);
  // Un agent de session demande toujours claude ; un holder seul non.
  expect(() => validateAssignment({ ...base, engine: "codex", agents: [coach()] })).toThrow(/claude/);
});

it("listens to the principal and to every enabled room that lists it", () => {
  assign(3, [{ id: "crypto", kind: "holder" }]);
  assign(5, [coach(), { id: "crypto", kind: "holder" }]);
  expect(holderThreads(dataDir, "crypto")).toEqual(["principal"]);
  setForkEnabled(dataDir, 3, true);
  setForkEnabled(dataDir, 5, true);
  expect(holderThread(dataDir, "crypto")).toBe("principal");
  expect(holderThreads(dataDir, "crypto")).toEqual(["principal", "fork:3", "fork:5"]);
  // Champ historique `holder` : la room remplace le principal, les autres rooms s'ajoutent.
  saveForkAssignment(forkDir(dataDir, 4), {
    instructions: path.join(space, "ROOM.md"), engine: "claude", workspace: space, holder: "crypto",
  });
  setForkEnabled(dataDir, 4, true);
  expect(holderThreads(dataDir, "crypto")).toEqual(["fork:4", "fork:3", "fork:5"]);
});

it("speaks in the room thread, stays silent on [rien]/SILENCE, and keeps its principal cursor", async () => {
  assign(3, [{ id: "crypto", kind: "holder" }]);
  setForkEnabled(dataDir, 3, true);
  sendToFork(dataDir, 3, "premier message");
  clock = Date.now() + 60_000; // sendToFork horodate avec l'horloge système.
  expect(await tick(replying("x"))).toEqual([]); // premier passage : part du présent de chaque fil
  const state = readPatternHolderState(dataDir);
  expect(state["crypto"]?.thread).toBe("principal");
  expect(state["crypto@fork:3"]?.thread).toBe("fork:3");

  sendToFork(dataDir, 3, "On partage le wallet entre les deux agents ?");
  clock = Date.now() + 60_000;
  const seen: string[] = [];
  const outcomes = await tick(replying("Non : un wallet par agent.", seen));
  expect(outcomes).toEqual([expect.objectContaining({ slug: "crypto", state: "spoke" })]);
  expect(seen[0]).toContain("Fil du fork 3");
  expect(roomEntries(3).some((e) => e.role === "agent" && e.text === "🪙 Crypto · Non : un wallet par agent.")).toBe(true);
  expect(readOwnerMessages(dataDir) ?? []).toEqual([]);

  for (const silence of ["[rien]", "SILENCE"]) {
    sendToFork(dataDir, 3, `Et maintenant ? (${silence})`);
    clock = Date.now() + 60_000;
    const quiet = await tick(replying(silence));
    expect(quiet).toEqual([expect.objectContaining({ slug: "crypto", state: "silent" })]);
  }
  expect(roomEntries(3).filter((e) => e.role === "agent")).toHaveLength(1);
});

it("forgets a room cursor when the holder leaves the room", async () => {
  assign(3, [{ id: "crypto", kind: "holder" }]);
  setForkEnabled(dataDir, 3, true);
  sendToFork(dataDir, 3, "premier message");
  clock = Date.now() + 60_000;
  await tick(replying("x"));
  expect(readPatternHolderState(dataDir)["crypto@fork:3"]).toBeDefined();
  assign(3, [coach()]);
  await tick(replying("x"));
  expect(readPatternHolderState(dataDir)["crypto@fork:3"]).toBeUndefined();
});

it("lists agents and holders as room participants for the app", () => {
  const saved = assign(3, [coach(), { id: "crypto", kind: "holder" }, { id: "absent", kind: "holder" }]);
  expect(roomParticipants(dataDir, saved)).toEqual([
    { id: "coach-a", name: "Coach A", kind: "agent" },
    { id: "crypto", name: "Crypto", kind: "holder", emoji: "🪙" },
    { id: "absent", name: "absent", kind: "holder", missing: true },
  ]);
  const view = readForks(dataDir, path.join(dataDir, "workspace")).forks.find((f) => f.id === 3);
  expect(view?.participants.map((p) => p.id)).toEqual(["coach-a", "crypto", "absent"]);
});
