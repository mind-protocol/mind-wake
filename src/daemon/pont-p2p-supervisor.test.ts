import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PontP2PSupervisor, pontEnabled, PONT_SETTINGS_FILE } from "./pont-p2p-supervisor.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: string | null };
  child.exitCode = null;
  child.signalCode = null;
  (child as unknown as { pid: number }).pid = 4242;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  };
  return child;
}

const dirs: string[] = [];
function dataDir(settings?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pont-sup-"));
  dirs.push(dir);
  if (settings !== undefined) fs.writeFileSync(path.join(dir, PONT_SETTINGS_FILE), JSON.stringify(settings));
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function supervisor(dir: string, allowed = () => true) {
  const spawned: (readonly string[])[] = [];
  const sup = new PontP2PSupervisor({
    dataDir: dir,
    wakeupsDir: () => path.join(dir, "workspace", "wakeups"),
    repoDir: "/repo",
    allowed,
    spawnService: (args) => {
      spawned.push(args);
      return fakeChild();
    },
  });
  return { sup, spawned };
}

describe("PontP2PSupervisor", () => {
  it("interrupteur absent (défaut) : aucun processus, donc aucun réseau", () => {
    const dir = dataDir();
    expect(pontEnabled(dir)).toBe(false);
    const { sup, spawned } = supervisor(dir);
    expect(sup.tick()).toBe("off");
    expect(sup.tick()).toBe("off");
    expect(spawned).toHaveLength(0);
    sup.close();
  });

  it("interrupteur désactivé ou sans nom : aucun processus", () => {
    for (const s of [{ enabled: false, name: "⬡nlr" }, { enabled: true }, { enabled: "true", name: "⬡nlr" }]) {
      const { sup, spawned } = supervisor(dataDir(s));
      expect(sup.tick()).toBe("off");
      expect(spawned).toHaveLength(0);
      sup.close();
    }
  });

  it("activé : lance le service avec le profil et le vrai dossier wakeups/, une seule fois", () => {
    const dir = dataDir({ enabled: true, name: "⬡nlr" });
    const { sup, spawned } = supervisor(dir);
    expect(sup.tick()).toBe("started");
    expect(sup.tick()).toBe("running");
    expect(spawned).toHaveLength(1);
    const args = spawned[0]!;
    expect(args[0]).toBe(path.join("/repo", "services", "pont-p2p", "main.mjs"));
    expect(args).toContain(dir);
    expect(args).toContain(path.join(dir, "workspace", "wakeups"));
    sup.close();
    expect(sup.running).toBe(false);
  });

  it("Force-off ou arrêt du daemon : n'est pas lancé, et le service en cours est arrêté", () => {
    const dir = dataDir({ enabled: true, name: "⬡nlr" });
    let allowed = false;
    const { sup, spawned } = supervisor(dir, () => allowed);
    expect(sup.tick()).toBe("off");
    expect(spawned).toHaveLength(0);
    allowed = true;
    expect(sup.tick()).toBe("started");
    allowed = false;
    expect(sup.tick()).toBe("stopped");
    expect(sup.running).toBe(false);
    sup.close();
  });

  it("interrupteur coupé pendant que le service tourne : arrêt", () => {
    const dir = dataDir({ enabled: true, name: "⬡nlr" });
    const { sup } = supervisor(dir);
    expect(sup.tick()).toBe("started");
    fs.writeFileSync(path.join(dir, PONT_SETTINGS_FILE), JSON.stringify({ enabled: false, name: "⬡nlr" }));
    expect(sup.tick()).toBe("stopped");
    expect(sup.tick()).toBe("off");
    sup.close();
  });
});
