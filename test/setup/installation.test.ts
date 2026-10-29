import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-installation-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const moduleUrl = new URL("../../scripts/installation.mjs", import.meta.url).href;
const repo = fileURLToPath(new URL("../../", import.meta.url));
function prepare() {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const {prepareInstallation}=await import(process.argv[1]);prepareInstallation(process.argv[2],process.argv[3]);",
      moduleUrl,
      repo,
      dir,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
}
const read = (name: string) => fs.readFileSync(path.join(dir, "installation", name), "utf8");
it("prépare un exécutable portable depuis un dossier déplacé avec espaces", () => {
  const moved = path.join(dir, "another computer", "mind-wake");
  const data = path.join(dir, "fresh-profile");
  const executable = path.join(moved, "bin", "mind-wake-desktop.exe");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "test executable sentinel");
  execFileSync(process.execPath, ["--input-type=module", "-e",
    "const {prepareInstallation}=await import(process.argv[1]);prepareInstallation(process.argv[2],process.argv[3]);",
    moduleUrl, moved, data], { stdio: "pipe" });
  const manifest = JSON.parse(fs.readFileSync(path.join(data, "installation", "manifest.json"), "utf8"));
  expect(manifest.repoDir).toBe(moved);
  expect(manifest.desktopExe).toBe(executable);
  expect(manifest.dataDir).toBe(data);
});
it("rejoue la préparation sans changer les identités ni toucher au profil", () => {
  fs.writeFileSync(path.join(dir, "control.sqlite"), "existing profile sentinel");
  prepare();
  const keys = read("keys.json"),
    hub = read("hub.json");
  prepare();
  expect(read("keys.json")).toBe(keys);
  expect(read("hub.json")).toBe(hub);
  expect(fs.readFileSync(path.join(dir, "control.sqlite"), "utf8")).toBe(
    "existing profile sentinel",
  );
});
it("refuse une configuration du hub modifiée au lieu de la remplacer", () => {
  prepare();
  const changed = { parties: [] };
  fs.writeFileSync(path.join(dir, "installation/hub.json"), JSON.stringify(changed));
  expect(() => prepare()).toThrow();
  expect(JSON.parse(read("hub.json"))).toEqual(changed);
});
it("sépare les secrets des lanceurs et conserve des identités distinctes sans conseil", () => {
  prepare();
  const keys = JSON.parse(read("keys.json"));
  expect(keys.agent).not.toBe(keys.owner);
  for (const file of ["manifest.json", "mcp.mjs", "claude-mcp.json", "hub.json"]) {
    expect(read(file)).not.toContain(keys.agent);
    expect(read(file)).not.toContain(keys.owner);
  }
  const parties = JSON.parse(read("hub.json")).parties;
  expect(parties).toHaveLength(2);
  for (const party of parties)
    expect(party.permissions).toEqual({ message: true, requestHelp: false, guide: false });
  expect(read("mcp.mjs")).toContain(pathToFileURL(path.join(repo, "scripts/start-local.mjs")).href);
});
