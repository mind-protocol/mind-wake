import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withWakePersonality } from "./wake-system-prompt.js";
import { readAgentRole } from "./agent-role.js";
import { agentIdentity } from "./agent-identity.js";
import { loadPatternHolders, patternHolderSystemPrompt } from "../communication/pattern-holders.js";
import { coachSystemPrompt } from "../daemon/coach.js";
import { readForkAssignment, resolveRoomAgents } from "../daemon/fork-assignment.js";
import { holderThreads } from "../communication/pattern-holders.js";
import { setForkEnabled } from "../daemon/forks.js";
let data: string;
let workspace: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "wake-corpus-runtime-"));
  workspace = path.join(data, "workspace");
  const bundle = path.resolve("prompts/default-agents");
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8")) as { files: { file: string; target: string }[] };
  for (const entry of manifest.files) {
    const target = path.join(workspace, entry.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(bundle, entry.file), target);
  }
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));
it("routes a fresh installation to the principal and coach rooms through the runtime", () => {
  const freshWorkspace = path.join(data, "fresh-workspace");
  execFileSync(process.execPath, ["--input-type=module", "-e",
    "import { installDefaultAgents } from './scripts/default-agents.mjs'; installDefaultAgents(process.cwd(), process.argv[1], process.argv[2]);",
    freshWorkspace, data]);
  const assignment = readForkAssignment(path.join(data, "forks", "2"));
  expect(assignment).not.toBeNull();
  expect(resolveRoomAgents(assignment!, data).map(a => a.id)).toEqual(["coach-general"]);
  expect(holderThreads(data, "pattern-holder")).toEqual(["principal"]);
  expect(holderThreads(data, "coach-des-coachs")).toEqual([]);
  setForkEnabled(data, 2, true);
  expect(holderThreads(data, "coach-des-coachs")).toEqual(["fork:2"]);
});
it("loads all shipped roles and distinguishes the new identity from the unchanged corpus", () => {
  expect(agentIdentity(workspace).name).toBe("Élan");
  for (const engine of ["codex", "claude"]) {
    const role = readAgentRole(workspace, "marco-" + engine, "missing");
    expect(role).not.toBe("missing");
    const prompt = withWakePersonality(workspace, role);
    expect(prompt).toContain("Je suis Marco");
    expect(prompt).toContain("l'agent principal s'appelle Élan");
  }
  const loaded = loadPatternHolders(data);
  expect(loaded.invalid).toEqual([]);
  expect(loaded.holders.map(h => h.slug)).toEqual(["coach-des-coachs", "pattern-holder"]);
  for (const holder of loaded.holders) {
    expect(holder.seed).toContain("Pourquoi");
    expect(patternHolderSystemPrompt(holder)).toContain("l'agent principal s'appelle Élan");
  }
  expect(coachSystemPrompt(workspace)).toContain("l'agent principal s'appelle Élan");
  fs.writeFileSync(path.join(workspace, "artifacts/agent-identity.json"), JSON.stringify({ name: "Aube", inheritedCorpus: true }));
  expect(withWakePersonality(workspace, "base")).toContain("l'agent principal s'appelle Aube");
});
