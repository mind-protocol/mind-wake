/**
 * Câblage réel de la CLI sur la base SQLite de `src/store/` : persistance entre
 * invocations, consultations sans écriture, composants annoncés présents.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStoreReadOnly } from "../../store/index.js";
import { DEFAULT_PROFILE_ID, processContext, type CliContext } from "../context.js";
import { runCli } from "../run.js";
import { CONTROL_DB_FILE, STORE_BACKEND } from "./index.js";

let tmpRoot: string;
let dataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-cli-sqlite-"));
  dataDir = path.join(tmpRoot, "data");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function run(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const ctx: CliContext = {
    ...processContext(),
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    env: {},
    cwd: tmpRoot,
  };
  const code = await runCli(["--data-dir", dataDir, ...argv, "--json"], ctx);
  return { code, json: JSON.parse(out.join("")) as Record<string, unknown> };
}

describe("CLI câblée sur SQLite", () => {
  it("annonce SQLite comme stockage du build", () => {
    expect(STORE_BACKEND).toBe("sqlite");
  });

  it("ne crée ni dossier ni base pour une consultation", async () => {
    await run("status");
    await run("journal");
    await run("doctor");
    expect(fs.existsSync(dataDir)).toBe(false);
    fs.mkdirSync(dataDir);
    await run("status");
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it("persiste le profil d'init entre deux invocations", async () => {
    const first = await run("init");
    expect(first.json).toMatchObject({ ok: true, data: { created: true, persistence: "sqlite" } });
    expect(fs.existsSync(path.join(dataDir, CONTROL_DB_FILE))).toBe(true);
    const second = await run("init");
    expect(second.json).toMatchObject({ data: { created: false } });

    const store = openStoreReadOnly(path.join(dataDir, CONTROL_DB_FILE));
    try {
      expect(store.uow.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe("disabled");
      expect(store.uow.journal.list(DEFAULT_PROFILE_ID)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("lit la base en lecture seule sans la modifier", async () => {
    await run("init");
    const file = path.join(dataDir, CONTROL_DB_FILE);
    const before = fs.readFileSync(file);
    const status = await run("status");
    expect(status.json).toMatchObject({
      data: { persistence: "sqlite", profile: { state: "disabled" } },
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const store = openStoreReadOnly(file);
    try {
      expect(() => {
        store.uow.profiles.setNextWake(DEFAULT_PROFILE_ID, null);
      }).toThrow(/readonly/i);
    } finally {
      store.close();
    }
  });

  it("affiche persistance et ledger présents dans doctor", async () => {
    await run("init");
    const { json } = await run("doctor");
    const caps = (json["data"] as { capabilities: { id: string; availability: string }[] })
      .capabilities;
    const availability = Object.fromEntries(caps.map((c) => [c.id, c.availability]));
    expect(availability).toMatchObject({
      persistence: "present",
      ledger: "present",
      policy_engine: "not_implemented",
      runtime_adapter: "not_implemented",
    });
  });
});
