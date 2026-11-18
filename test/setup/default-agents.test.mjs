import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDefaultAgents } from "../../scripts/default-agents.mjs";
const repo = path.resolve(import.meta.dirname, "../..");
test("fresh setup assigns coaches to room 2, preserves edits and does not activate workers", t => {
  const data = temporary(t), workspace = path.join(data, "workspace");
  installDefaultAgents(repo, workspace, data);
  const file = path.join(data, "forks/2/assignment.json");
  const assignment = JSON.parse(fs.readFileSync(file));
  assert.equal(assignment.holder, "coach-des-coachs");
  assert.deepEqual(assignment.agents.map(a => a.id), ["coach-general"]);
  assert.ok(fs.existsSync(assignment.agents[0].instructions));
  assert.equal(assignment.workspace, workspace);
  assert.deepEqual(fs.readdirSync(path.join(data, "forks/2")), ["assignment.json"]);
  assert.ok(!fs.existsSync(path.join(data, "forks/1")));
  fs.unlinkSync(file);
  installDefaultAgents(repo, workspace, data);
  assert.ok(!fs.existsSync(file));
});

test("setup preserves existing room assignments and existing personalities", t => {
  const data = temporary(t), workspace = path.join(data, "workspace");
  const room = path.join(data, "forks/2");
  fs.mkdirSync(room, { recursive: true });
  const file = path.join(room, "assignment.json");
  fs.writeFileSync(file, "custom assignment");
  installDefaultAgents(repo, workspace, data);
  assert.equal(fs.readFileSync(file, "utf8"), "custom assignment");
  const other = path.join(data, "existing"), personal = path.join(other, "workspace/artifacts");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "PERSONALITY.md"), "Existing agent");
  installDefaultAgents(repo, path.join(other, "workspace"), other);
  assert.ok(!fs.existsSync(path.join(other, "forks")));
});
const bundle = path.join(repo, "prompts/default-agents");
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-default-agents-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("installs all four roles with byte-identical prompts and separate identity", t => {
  const workspace = temporary(t);
  const result = installDefaultAgents(repo, workspace);
  assert.equal(result.created.length, manifest.files.length);
  for (const entry of manifest.files) {
    const installed = fs.readFileSync(path.join(workspace, entry.target));
    assert.equal(createHash("sha256").update(installed).digest("hex"), entry.sha256);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "artifacts/agent-identity.json"))).name, "Élan");
  assert.ok(fs.existsSync(path.join(workspace, "artifacts/prompts/system/coach.md")));
  assert.ok(fs.existsSync(path.join(workspace, "artifacts/pattern-holders/coach-des-coachs/_holder.md")));
  assert.ok(!fs.existsSync(path.join(workspace, "AUTORISATIONS.json")));
  assert.ok(!fs.existsSync(path.join(workspace, "AGENTS.md")));
});
test("preserves existing prompts and identity, and does not resurrect deleted files", t => {
  const workspace = temporary(t);
  const personal = path.join(workspace, "artifacts/PERSONALITY.md");
  fs.mkdirSync(path.dirname(personal));
  fs.writeFileSync(personal, "My own agent");
  installDefaultAgents(repo, workspace);
  assert.equal(fs.readFileSync(personal, "utf8"), "My own agent");
  assert.ok(!fs.existsSync(path.join(workspace, "artifacts/agent-identity.json")));
  fs.unlinkSync(personal);
  assert.equal(installDefaultAgents(repo, workspace).installed, false);
  assert.ok(!fs.existsSync(personal));
});
test("refuses a redirected destination without writing outside the workspace", t => {
  const root = temporary(t), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "artifacts"), "junction");
  assert.throws(() => installDefaultAgents(repo, workspace), /local directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
