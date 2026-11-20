/** Explicit maintainer action: node scripts/snapshot-default-agents.mjs <source-workspace>. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { WAKE_HOME_SYSTEM_PROMPT } from "../dist/adapters/wake-system-prompt.js";
import { CLAUDE_WAKE_SYSTEM_PROMPT } from "../dist/adapters/claude/registration.js";
import { defaultCoachPrompt } from "../dist/daemon/coach.js";
import { holderRole } from "../dist/communication/pattern-holders.js";

const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw Error("Absolute source workspace required");
const repo = path.resolve(import.meta.dirname, "..");
const bundle = path.join(repo, "prompts/default-agents");
if (fs.existsSync(path.join(bundle, "manifest.json"))) throw Error("Snapshot already exists; review a new version separately");
const files = [];
function save(file, bytes, origin, target) {
  const destination = path.join(bundle, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  files.push({ file, origin, target, sha256: createHash("sha256").update(bytes).digest("hex") });
}
function copy(relative, file = relative, target = relative) {
  save(file, fs.readFileSync(path.join(source, relative)), "workspace/" + relative, target);
}
for (const slug of ["pattern-holder", "coach-des-coachs", "critique", "mindset", "cockpit", "reveilleur", "_commun"]) {
  const relative = "artifacts/pattern-holders/" + slug;
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("Unexpected linked prompt source");
      const rel = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name === "source-lecons-soda.txt")) copy(rel);
    }
  }
  walk(relative);
}
copy("artifacts/PERSONALITY.md");
// Preserve the original operating document, including historical paths, as a reference.
copy("AGENTS.md", "marco/AGENTS.md", "artifacts/default-agents/marco/AGENTS.md");
save("coach/system.md", fs.readFileSync(path.join(repo, "prompts/coach/system.md")), "repository/prompts/coach/system.md", "artifacts/default-agents/coach/system.md");
for (const [id, fallback, origin] of [
  ["wake-home", WAKE_HOME_SYSTEM_PROMPT, "src/adapters/wake-system-prompt.ts#WAKE_HOME_SYSTEM_PROMPT"],
  ["marco-codex", WAKE_HOME_SYSTEM_PROMPT, "src/adapters/wake-system-prompt.ts#WAKE_HOME_SYSTEM_PROMPT"],
  ["marco-claude", CLAUDE_WAKE_SYSTEM_PROMPT, "src/adapters/claude/registration.ts#CLAUDE_WAKE_SYSTEM_PROMPT"],
  ["coach", defaultCoachPrompt(), "src/daemon/coach.ts#defaultCoachPrompt"],
]) {
  const rel = "artifacts/prompts/system/" + id + ".md";
  if (fs.existsSync(path.join(source, rel))) copy(rel);
  else save(rel, Buffer.from(fallback), "repository/" + origin, rel);
}
for (const router of [false, true]) {
  const name = router ? "_role-reveilleur.md" : "_role-commun.md";
  const rel = "artifacts/pattern-holders/" + name;
  if (fs.existsSync(path.join(source, rel))) copy(rel);
  else save(rel, Buffer.from(holderRole(path.join(source, "artifacts/pattern-holders"), router)), "repository/src/communication/pattern-holders.ts#holderRole", rel);
}
save("identity.json", Buffer.from(JSON.stringify({ name: "Élan", inheritedCorpus: true }, null, 2) + "\n"), "distribution identity (separate from original prompts)", "artifacts/agent-identity.json");
fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ version: 2, capturedAt: new Date().toISOString(), files }, null, 2) + "\n");
console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, f) => sum + fs.statSync(path.join(bundle, f.file)).size, 0) }));
