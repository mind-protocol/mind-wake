import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WakeManager } from "./wake-manager.js";
import { assertProjectActivation, projectStatus } from "./project-capacity.js";
import { updatePromptImprovementProject } from "./prompt-improvement-project.js";
import { withPromptSizeWarning } from "../communication/prompt-size-warning.js";

let dir: string, manager: WakeManager;
const file = () => path.join(dir, "artifacts/projets-compteur.json");
function write(projects: Record<string, unknown>, limit: unknown = 3) {
  fs.writeFileSync(file(), JSON.stringify({ projects, ...(limit === undefined ? {} : {activeProjectLimit: limit}) }));
}
const active = {status: "en cours"}, paused = {status: "pause : jalon"};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-capacity-"));
  fs.mkdirSync(path.join(dir, "artifacts"));
  write({a: active, b: active, c: paused, d: paused});
  manager = new WakeManager(dir); manager.configure(true);
});
afterEach(() => { manager.close(); fs.rmSync(dir, {recursive: true, force: true}); });

it("allows the third, rejects the fourth without changing registry or rotation, and allows pause", () => {
  expect(manager.setStatus("c", "active", "ready")?.status).toBe("active");
  const before = fs.readFileSync(file(), "utf8"), revision = manager.status()!.revision;
  expect(() => manager.setStatus("d", "active", "ready")).toThrow("Active project limit (3)");
  expect(fs.readFileSync(file(), "utf8")).toBe(before);
  expect(manager.status()!.revision).toBe(revision);
  expect(manager.setStatus("a", "paused", "jalon")?.status).toBe("paused");
  expect(manager.setStatus("d", "active", "ready")?.status).toBe("active");
});
it("reads current registry under shared lock rather than a stale manager snapshot", () => {
  write({a: active, b: active, c: active, d: paused});
  expect(manager.status()!.projects.find(p => p.id === "c")!.status).toBe("paused");
  expect(() => manager.setStatus("d", "active", "ready")).toThrow("Active project limit");
});
it("permits idempotent activation and lowering load even if local policy is exceeded", () => {
  write({a: active, b: active, c: active, d: active});
  expect(manager.setStatus("a", "active", "same")?.status).toBe("active");
  expect(manager.setStatus("b", "blocked", "attend")?.status).toBe("blocked");
});
it("rejects activation while another registry writer holds the lock", () => {
  fs.writeFileSync(file() + ".lock", "");
  expect(() => manager.setStatus("c", "active", "ready")).toThrow("registry is busy");
  fs.unlinkSync(file() + ".lock");
  expect(manager.project("c").status).toBe("paused");
});
it("does not impose an owner-specific default, and fails closed on invalid policy for activation only", () => {
  write({a: active, b: active, c: active, d: paused}, undefined);
  // Explicitly remove it: default argument intentionally supplies 3 in other fixtures.
  const counter = JSON.parse(fs.readFileSync(file(), "utf8")); delete counter.activeProjectLimit;
  fs.writeFileSync(file(), JSON.stringify(counter));
  expect(manager.setStatus("d", "active", "unlimited")?.status).toBe("active");
  write({a: active, b: paused}, "3");
  expect(() => manager.setStatus("b", "active", "ready")).toThrow("Invalid activeProjectLimit");
  expect(manager.setStatus("a", "paused", "jalon")?.status).toBe("paused");
});
it("uses the same status classification as the manager, excluding invalid project IDs", () => {
  const statuses = ["en cours", "active", "pause : attend", "arrêt", "arrete", "stopped", "attend", "bloqué", "blocked", "terminé", "termine", "fini", "archivé"];
  expect(statuses.map(projectStatus)).toEqual(["active", "active", "paused", "paused", "paused", "paused", "blocked", "blocked", "blocked", "archived", "archived", "archived", "archived"]);
  expect(() => assertProjectActivation({activeProjectLimit: 1, projects: {"bad/id": active}}, "a")).not.toThrow();
});
it("does not create a hidden fourth project when an oversize prompt warning requests maintenance", () => {
  write({a: active, b: active, c: active});
  const before = fs.readFileSync(file(), "utf8");
  expect(() => updatePromptImprovementProject(dir, true)).toThrow("Active project limit");
  expect(fs.readFileSync(file(), "utf8")).toBe(before);
});
it("preserves owner replies and their size warning when automatic maintenance cannot activate", () => {
  write({a: active, b: active, c: active});
  fs.writeFileSync(path.join(dir, "artifacts/PERSONALITY.md"), "x".repeat(5001));
  const text = withPromptSizeWarning(dir, "Réponse à NLR");
  expect(text).toContain("Instructions volumineuses");
  expect(text).toContain("plafond local");
  expect(text).toContain("Réponse à NLR");
  expect(withPromptSizeWarning(dir, text)).toBe(text);
  expect(Object.keys(JSON.parse(fs.readFileSync(file(), "utf8")).projects)).toHaveLength(3);
});
