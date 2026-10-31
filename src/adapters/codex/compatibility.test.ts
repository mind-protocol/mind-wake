import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkCodexCompatibility, inspectCodexSchemas } from "./compatibility.js";
import { parseCodexVersion } from "./protocol.js";

const schemaText = fs.readFileSync(
  new URL("../../../test/fixtures/codex/schema.json", import.meta.url),
  "utf8",
);
const inspect = (text: string) => inspectCodexSchemas([JSON.parse(text) as unknown]);
it("shares a simultaneous schema export between roles, then rechecks on a later call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-shared-schema-"));
  try {
    const count = path.join(dir, "exports.txt"),
      script = path.join(dir, "export.cjs");
    const schema = fileURLToPath(
      new URL("../../../test/fixtures/codex/schema.json", import.meta.url),
    );
    fs.writeFileSync(
      script,
      `const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(${JSON.stringify(count)},'export\\n');const out=process.argv[process.argv.indexOf('--out')+1];fs.copyFileSync(${JSON.stringify(schema)},path.join(out,'schema.json'));`,
    );
    const executable = { path: process.execPath, prefixArgs: [script] };
    expect(
      await Promise.all(Array.from({ length: 3 }, () => checkCodexCompatibility(executable))),
    ).toEqual([{ steering: true }, { steering: true }, { steering: true }]);
    expect(fs.readFileSync(count, "utf8")).toBe("export\n");
    await checkCodexCompatibility(executable);
    expect(fs.readFileSync(count, "utf8")).toBe("export\nexport\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("checks a CLI schema export with a real fixture process, without an account", async () => {
  const executable = {
    path: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL("../../../test/fixtures/codex/fake-codex.ts", import.meta.url)),
    ],
  };
  expect(await checkCodexCompatibility(executable)).toEqual({ steering: true });
  await expect(
    checkCodexCompatibility({
      ...executable,
      prefixArgs: [...executable.prefixArgs, "--fixture-no-interrupt"],
    }),
  ).rejects.toThrow("turn/interrupt");
});
it("requires methods, parameter types, security values and usage contracts", () => {
  expect(inspect(schemaText)).toEqual({ steering: true });
  expect(() => inspect(schemaText.replace('"turn/interrupt"', '"removed"'))).toThrow(
    "turn/interrupt",
  );
  expect(() =>
    inspect(schemaText.replace(/("inputTokens":\s*\{\s*"type":\s*)"integer"/, '$1"string"')),
  ).toThrow("inputTokens");
  expect(() => inspect(schemaText.replace('"workspace-write"', '"removed"'))).toThrow("sandbox");
  expect(() => inspect(schemaText.replace('"never"', '"removed"'))).toThrow("approvalPolicy");
  expect(() =>
    inspect(
      schemaText.replace(
        /"required":\s*\[\s*"threadId",\s*"input"\s*\]/,
        '"required":["threadId","input","unknown"]',
      ),
    ),
  ).toThrow("nouveau paramètre");
});
it("treats turn/steer as optional and never treats a version string as a capability", () => {
  expect(inspect(schemaText.replace('"turn/steer"', '"removed"'))).toEqual({ steering: false });
  expect(inspect(schemaText.replace('"expectedTurnId":', '"removed":'))).toEqual({
    steering: false,
  });
  expect(() => inspectCodexSchemas([{ version: "0.200.1" }])).toThrow("initialize");
  expect(parseCodexVersion("codex-cli 0.200.1\n")).toBe("0.200.1");
  for (const value of [
    "unknown",
    "codex-cli x",
    "prefix codex-cli 0.165.0",
    "codex-cli 0.165.0 extra",
  ])
    expect(parseCodexVersion(value)).toBeNull();
});
