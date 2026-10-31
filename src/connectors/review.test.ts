import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { ConnectorRecords } from "./local.js";
import type { SecretVault } from "./core.js";

it("disconnect invalidates even an absent-slot setup captured before confirmation", async () => {
  const dir = path.resolve(".local/review/" + randomUUID());
  const data = new Map<string, string>();
  const vault: SecretVault = {
    put: (value) => {
      const ref = randomUUID();
      data.set(ref, value);
      return Promise.resolve(ref);
    },
    get: (ref) => Promise.resolve(data.get(ref) ?? ""),
    delete: (ref) => {
      data.delete(ref);
      return Promise.resolve();
    },
  };
  const records = new ConnectorRecords(dir, vault);
  const record = {
    config: {},
    grant: { provider: "gmail", account: "synthetic", generation: "one", enabled: true },
    tokenRef: null,
  };
  try {
    const before = records.currentRef("gmail");
    await records.remove("gmail");
    await expect(records.write("gmail", record, before)).rejects.toMatchObject({ code: "stopped" });
    expect(data.size).toBe(0);
    await records.write("gmail", record, records.currentRef("gmail"));
    const other = new ConnectorRecords(dir, vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = vault.get.bind(vault);
    vault.get = async (ref) => {
      const value = await get(ref);
      await waiting;
      return value;
    };
    const pending = other.read("gmail");
    await records.remove("gmail");
    release();
    expect(await pending).toBeNull();
    const revision = records.currentRef("gmail");
    const lock = path.join(dir, "connectors/gmail.ref.lock");
    fs.writeFileSync(lock, "synthetic competing process");
    const blocked = records.write("gmail", record, revision);
    const rejected = expect(blocked).rejects.toMatchObject({ code: "stopped" });
    await delay(20);
    fs.unlinkSync(lock);
    await records.remove("gmail");
    await rejected;
    expect(await records.read("gmail")).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
