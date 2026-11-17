import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineCliArgs } from "./engine-supervisor.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-args-"));
  fs.mkdirSync(path.join(dir, "src/cli"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/cli/main.ts"), "");
  return dir;
}
const rest = ["forks", "run", "--data-dir", "D"];

test("engineFromSource: true → node sur src/cli/main.ts avec le chargeur TypeScript", () => {
  const repoDir = repo();
  const args = engineCliArgs({ repoDir, engineFromSource: true }, rest);
  assert.ok(args.includes("--experimental-transform-types"));
  assert.ok(args.includes("--import"));
  assert.equal(args.at(-5), path.join(repoDir, "src/cli/main.ts"));
  assert.deepEqual(args.slice(-4), rest);
});

test("engineFromSource: false ou absent → dist/cli/main.js", () => {
  const repoDir = repo();
  for (const m of [{ repoDir, engineFromSource: false }, { repoDir }]) {
    assert.deepEqual(engineCliArgs(m, rest), [path.join(repoDir, "dist/cli/main.js"), ...rest]);
  }
});

test("engineFromSource: true sans src/cli/main.ts → repli sur dist", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-args-"));
  assert.equal(engineCliArgs({ repoDir, engineFromSource: true }, rest)[0], path.join(repoDir, "dist/cli/main.js"));
});
