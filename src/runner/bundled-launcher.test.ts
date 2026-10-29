import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { bundledJobLauncher, JOB_EXECUTABLE, JOB_SOURCE_SHA256 } from "./bundled-launcher.js";
import { ContainedProcess, ensureJobLauncher } from "./process-tree.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-bundle-"));
  dirs.push(dir);
  const contents = "fixture, never executed";
  fs.writeFileSync(path.join(dir, JOB_EXECUTABLE), contents);
  fs.writeFileSync(
    path.join(dir, "job-launcher.json"),
    JSON.stringify({
      format: "mind-wake.job-launcher.v1",
      file: JOB_EXECUTABLE,
      sourceSha256: JOB_SOURCE_SHA256,
      sha256: createHash("sha256").update(contents).digest("hex"),
      ...overrides,
    }),
  );
  return dir;
}
it("selects the distributed launcher without compiling or modifying a profile", () => {
  const dir = fixture();
  const runtime = path.join(dir, "unused-profile");
  expect(ensureJobLauncher(runtime, "win32", dir)).toEqual({
    available: true,
    launcherPath: path.join(dir, JOB_EXECUTABLE),
  });
  expect(fs.existsSync(runtime)).toBe(false);
});
it.each([
  { sourceSha256: "outdated" },
  { file: "../arbitrary.exe" },
  { sha256: "0".repeat(64) },
  { format: "other" },
])("refuses a bad bundle without unsigned fallback: %j", (override) => {
  const dir = fixture(override);
  const runtime = path.join(dir, "unused-profile");
  expect(ensureJobLauncher(runtime, "win32", dir).available).toBe(false);
  expect(fs.existsSync(runtime)).toBe(false);
});
it("refuses a missing executable or manifest", () => {
  const dir = fixture();
  fs.unlinkSync(path.join(dir, JOB_EXECUTABLE));
  expect(bundledJobLauncher(dir)?.available).toBe(false);
  fs.unlinkSync(path.join(dir, "job-launcher.json"));
  expect(bundledJobLauncher(dir)?.available).toBe(false);
});
it("retains the unsupported-platform refusal", () => {
  expect(ensureJobLauncher("unused", "linux", fixture()).available).toBe(false);
});
it.skipIf(process.platform !== "win32")(
  "runs and stops a real tree using a precompiled bundle (local unsigned test)",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-native-real-"));
    dirs.push(dir);
    const built = ensureJobLauncher(dir, "win32", null);
    if (!built.available) throw new Error(built.reason);
    fs.writeFileSync(
      path.join(dir, "job-launcher.json"),
      JSON.stringify({
        format: "mind-wake.job-launcher.v1",
        file: JOB_EXECUTABLE,
        sourceSha256: JOB_SOURCE_SHA256,
        sha256: createHash("sha256").update(fs.readFileSync(built.launcherPath)).digest("hex"),
      }),
    );
    const selected = ensureJobLauncher(path.join(dir, "unused"), "win32", dir);
    if (!selected.available) throw new Error(selected.reason);
    const child = new ContainedProcess(
      selected.launcherPath,
      `Local\\mindwake-precompiled-${randomUUID()}`,
      {
        executable: process.execPath,
        args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      },
    );
    try {
      await child.started();
      expect(await child.readLine()).toBe("ready");
      expect((await child.terminateTree()).confirmed).toBe(true);
    } finally {
      if (!child.hasExited) await child.terminateTree();
    }
    expect(fs.existsSync(path.join(dir, "unused"))).toBe(false);
  },
  15000,
);
it.skipIf(process.platform !== "win32")(
  "does not attest an unsigned executable as a signed release",
  () => {
    // Uses the real Windows verifier, including when invoked from a PowerShell 7 parent.
    const dir = fixture();
    expect(() =>
      execFileSync(process.execPath, ["scripts/native-launcher-release.mjs", "--seal", dir], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        stdio: "pipe",
      }),
    ).toThrow();
    // Existing fixture is unchanged; the sealer never rewrites it after a refused signature.
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "job-launcher.json"), "utf8")).signature,
    ).toBeUndefined();
  },
);
