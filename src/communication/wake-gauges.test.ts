import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { frenchAge, principalCorpusChars, recordHolderPass, wakeGaugeLine } from "./wake-gauges.js";
import { principalSeedHistory, PRINCIPAL_CONVERSATIONS_DIR, PRINCIPAL_CORPUS_MAX_CHARS } from "./markdown-conversation.js";
import { principalNativeHistory, withPrincipalReconstruction } from "./fil-continuity.js";

let dir: string;
let workspace: string;
let corpus: string;
const NOW = Date.parse("2026-11-20T19:00:00.000Z");
const noGit = () => null;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-gauges-"));
  workspace = path.join(dir, "workspace");
  corpus = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  fs.mkdirSync(corpus, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const syncState = (state: Record<string, unknown>) =>
  fs.writeFileSync(path.join(dir, "workspace-sync-state.json"), JSON.stringify({
    status: "ok", lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null, fingerprint: "x", repairNotified: false, ...state,
  }));

it("writes the three gauges on one French line, matching NLR's example", () => {
  fs.writeFileSync(path.join(corpus, "00-index.md"), "a".repeat(8_600));
  fs.writeFileSync(path.join(corpus, "90-fil.md"), "b".repeat(40_000));
  fs.writeFileSync(path.join(corpus, "_principal.md"), "c".repeat(50_000)); // identity file: not counted
  syncState({
    status: "blocked", lastSuccessAt: "2026-11-04T03:20:21.418Z",
    error: "Git push failed (rejected); inspect the repository locally.",
    gitDetail: "! [remote rejected] main -> main (pre-receive hook declined)", pendingCommits: 3,
  });
  recordHolderPass(dir, "critique", "2026-11-20T18:57:00.000Z");
  const line = wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: () => 189 });
  expect(line).toBe(
    "Jauges : corpus 48 600 / 240 000 (20 %) · dernier push réussi il y a 16 j, 189 commits en attente, " +
    "erreur (bloqué) : ! [remote rejected] main -> main (pre-receive hook declined) · dernier passage des holders il y a 3 min.",
  );
  expect(line).not.toContain("\n");
});

it("says inconnu without state, falls back to the stored count, and warns from 80 %", () => {
  fs.writeFileSync(path.join(corpus, "90-fil.md"), "x".repeat(192_000));
  expect(wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit })).toBe(
    "Jauges : corpus 192 000 / 240 000 (80 %, attention) · dernier push réussi : inconnu · dernier passage des holders : inconnu.",
  );
  syncState({ status: "error", lastSuccessAt: "2026-11-20T17:00:00.000Z", error: "Git push failed (temporary network failure; retry in one minute).", pendingCommits: 1 });
  expect(wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit })).toContain(
    "dernier push réussi il y a 2 h, 1 commit en attente, erreur : Git push failed (temporary network failure; retry in one minute).",
  );
  syncState({ status: "ok", lastSuccessAt: "2026-11-20T18:59:30.000Z", pendingCommits: 0 });
  expect(wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit })).toContain("· dernier push réussi il y a 0 min ·");
  syncState({ status: "disabled" });
  expect(wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit })).toContain("· push automatique désactivé ·");
});

it("never fails the wake on an unreadable gauge", () => {
  fs.writeFileSync(path.join(dir, "workspace-sync-state.json"), "{not json");
  fs.mkdirSync(path.join(dir, "pattern-holders"));
  fs.writeFileSync(path.join(dir, "pattern-holders", "last-pass.json"), "garbage");
  const line = wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit });
  expect(line).toBe("Jauges : corpus 0 / 240 000 (0 %) · push : illisible · holders : illisible.");
  fs.rmSync(workspace, { recursive: true });
  expect(principalCorpusChars(workspace)).toBe(0);
});

it("opens the principal's wake context with the gauge line", () => {
  fs.writeFileSync(path.join(corpus, "90-fil.md"), "**NLR —** bonjour\n");
  const prompt = withPrincipalReconstruction(dir, workspace, "ROLE");
  expect(prompt.split("\n")[0]).toMatch(/^Jauges : corpus 18 \/ 240 000 \(0 %\) · .* · dernier passage des holders : inconnu\.$/);
  expect(prompt.indexOf("ROLE")).toBeGreaterThan(0);
});

it("records the last holder pass atomically, newest wins", () => {
  recordHolderPass(dir, "critique", "2026-11-20T18:00:00.000Z");
  recordHolderPass(dir, "cockpit", "2026-11-20T18:50:00.000Z");
  expect(JSON.parse(fs.readFileSync(path.join(dir, "pattern-holders", "last-pass.json"), "utf8"))).toEqual({ completedAt: "2026-11-20T18:50:00.000Z", holder: "cockpit" });
  expect(fs.readdirSync(path.join(dir, "pattern-holders"))).toEqual(["last-pass.json"]);
  expect(frenchAge("2026-11-19T19:00:00.000Z", NOW)).toBe("il y a 24 h");
  expect(frenchAge("not a date", NOW)).toBeNull();
});

it("above the limit, the wake loads the index and the end of the fil and names what is missing", () => {
  const turn = (i: number) => `\n---\n\n**NLR —** message ${String(i)} ${"m".repeat(980)}\n`;
  fs.writeFileSync(path.join(corpus, "00-index.md"), "# Index\n\n**Marco —** objectifs\n");
  fs.writeFileSync(path.join(corpus, "50-milieu.md"), "**Marco —** milieu\n");
  fs.writeFileSync(path.join(corpus, "90-fil.md"), Array.from({ length: 260 }, (_, i) => turn(i)).join(""));
  expect(() => principalSeedHistory(workspace)).toThrow(/exceed 240000/);
  const history = principalSeedHistory(workspace, "partial");
  const notice = history[0];
  expect(notice?.text).toMatch(/^Chargement partiel : le corpus fait \d{3} \d{3} caractères, au-delà de la limite de 240 000\./);
  expect(notice?.text).toContain("Chargé : 00-index.md (entier) ; 90-fil.md (fin,");
  expect(notice?.text).toContain("Non chargé : 50-milieu.md ; début de 90-fil.md.");
  expect(history.some(m => m.text === "objectifs" && m.role === "assistant")).toBe(true);
  expect(history.some(m => m.text.startsWith("milieu"))).toBe(false);
  expect(history.at(-1)?.text).toContain("message 259");
  expect(history.some(m => m.text.includes("message 0 "))).toBe(false);
  // The excerpt starts on a turn boundary: no truncated first message.
  const firstFil = history.find(m => m.id.includes("90-fil.md#fin") && m.author === "NLR");
  expect(firstFil?.text).toMatch(/^message \d+ m{980}$/);
  const loaded = history.reduce((sum, m) => sum + m.text.length, 0) - (notice?.text.length ?? 0);
  expect(loaded).toBeLessThanOrEqual(PRINCIPAL_CORPUS_MAX_CHARS);
  // The principal's wake uses this partial load instead of failing.
  expect(principalNativeHistory(dir, workspace, "principal")[0]?.text).toMatch(/^Chargement partiel/);
  expect(wakeGaugeLine(dir, workspace, { now: NOW, pendingCommits: noGit })).toMatch(/\(1\d\d %, dépassé : chargement partiel\)/);
});
