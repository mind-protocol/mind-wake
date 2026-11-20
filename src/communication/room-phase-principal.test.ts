/**
 * Salle 1 = le fil principal (NLR, 20 nov. 2026) : un holder du principal (sans `room`) pose sa
 * phrase de phase dans la salle 1, et sa note de réveil la lui rappelle. Tour Claude simulé.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "./fast-reply.js";
import { parsePatternHolder, tickPatternHolders } from "./pattern-holders.js";
import { PRINCIPAL_PHASE_ROOM, readRoomPhases, roomPhaseWakeLine } from "./room-phase.js";

const MIN = 60_000;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-phase-principal-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it("un holder du fil principal pose sa phrase dans la salle 1 ; elle va au réveil du principal", async () => {
  const holderDir = path.join(dataDir, "workspace", "artifacts", "pattern-holders", "narration");
  fs.mkdirSync(holderDir, { recursive: true });
  fs.writeFileSync(
    path.join(holderDir, "_holder.md"),
    `\`\`\`json pattern-holder\n${JSON.stringify({ name: "Narration", emoji: "📖", wake: "mention", cadence: { everyMinutes: 30 } })}\n\`\`\`\n\n(semence)\n`,
  );
  let clock = Date.now() + MIN;
  const seen: string[] = [];
  let answer = "L'arc de la semaine : les candidatures.\n```phase\n1 semaine (la semaine) : Arc des candidatures\n```";
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text: answer });
  };
  const tick = () => tickPatternHolders({ dataDir, claude: { executable: "unused", model: "sonnet" }, call, now: () => clock });
  await tick(); // référence de cadence
  clock += 30 * MIN;
  expect(await tick()).toHaveLength(1);
  expect(seen[0]).toContain("Aucune phrase de phase active dans la salle 1 (fil principal)");
  expect(readRoomPhases(dataDir)[String(PRINCIPAL_PHASE_ROOM)]?.["narration"]).toMatchObject({
    text: "Arc des candidatures",
    author: "Narration",
    scale: "la semaine",
  });
  // Ce que le daemon ajoute au réveil du principal (daemon.ts, #composeWake).
  expect(roomPhaseWakeLine(dataDir, PRINCIPAL_PHASE_ROOM, 1, clock)).toMatch(
    /^Phase de la salle 1 \(fil principal\) \(posée par Narration, la semaine\) : Arc des candidatures — budget restant 7 jours\.$/u,
  );

  answer = "SILENCE";
  clock += 30 * MIN;
  await tick();
  expect(seen[1]).toContain("Ta phrase de phase active dans la salle 1 (fil principal), posée par Narration, la semaine");
});

it("phaseKeeper : sans phrase active dans la salle 1, la note de réveil du gardien lui rappelle d'en poser une", async () => {
  const header = { name: "Narration", emoji: "📖", wake: "mention", cadence: { everyMinutes: 30 }, phaseKeeper: true };
  expect(parsePatternHolder("narration.md", `\`\`\`json pattern-holder\n${JSON.stringify(header)}\n\`\`\`\n`)).toMatchObject({
    holder: { phaseKeeper: true },
  });
  expect(parsePatternHolder("chef.md", "```json pattern-holder\n{\"name\":\"Chef\"}\n```\n")).not.toHaveProperty("holder.phaseKeeper");

  const holderDir = path.join(dataDir, "workspace", "artifacts", "pattern-holders", "narration");
  fs.mkdirSync(holderDir, { recursive: true });
  fs.writeFileSync(path.join(holderDir, "_holder.md"), `\`\`\`json pattern-holder\n${JSON.stringify(header)}\n\`\`\`\n\n(semence)\n`);
  let clock = Date.now() + MIN;
  const seen: string[] = [];
  let answer = "SILENCE";
  const call: typeof CallClaude = (_c, _a, prompt) => {
    seen.push(prompt);
    return Promise.resolve({ text: answer });
  };
  const tick = () => tickPatternHolders({ dataDir, claude: { executable: "unused", model: "sonnet" }, call, now: () => clock });
  await tick(); // référence de cadence
  clock += 30 * MIN;
  await tick();
  expect(seen[0]).toContain("Rappel : tu tiens les phases de la salle 1 (fil principal)");
  expect(seen[0]).toContain("« 1 j (la journée) : … »");

  answer = "```phase\n45 min (l'après-midi) : Relances\n```";
  clock += 30 * MIN;
  await tick(); // toujours sans phrase au moment du réveil : rappel, puis il en pose une
  expect(seen[1]).toContain("Rappel : tu tiens les phases");
  answer = "SILENCE";
  clock += 30 * MIN;
  await tick(); // sa phrase est active : pas de rappel
  expect(seen[2]).not.toContain("Rappel : tu tiens les phases");
  expect(seen[2]).toContain("Ta phrase de phase active dans la salle 1 (fil principal), posée par Narration, l'après-midi");
  clock += 30 * MIN;
  await tick(); // échue (45 min) : le rappel revient
  expect(seen[3]).toContain("Rappel : tu tiens les phases");
});
