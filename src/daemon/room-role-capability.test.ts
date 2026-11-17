import assert from "node:assert/strict";
import {it as test} from "vitest";
import path from "node:path";
import { roomRoleCapabilitiesFromRegistry } from "./room-role-capability.js";

const workspace = path.resolve("role-fixture");
const project = path.join(workspace, "artifacts", "projets", "test-project");
const registry = { projects: { "test-project": { status: "en cours", room: 4, capabilities: { roleTools: {
  agents: ["manager"], nativeDelegation: true, backgroundJobs: true, mindTools: true,
} } } } };
test("capability belongs to exact project room and role", () => {
  assert.equal(roomRoleCapabilitiesFromRegistry(registry, workspace, 4, project, "manager")?.nativeDelegation, true);
  assert.equal(roomRoleCapabilitiesFromRegistry(registry, workspace, 5, project, "manager"), null);
  assert.equal(roomRoleCapabilitiesFromRegistry(registry, workspace, 4, project, "other"), null);
  assert.equal(roomRoleCapabilitiesFromRegistry(registry, workspace, 4, workspace, "manager"), null);
});
test("paused projects, absent grants and truthy strings do not enable tools", () => {
  const paused = structuredClone(registry); paused.projects["test-project"].status = "en pause";
  assert.equal(roomRoleCapabilitiesFromRegistry(paused, workspace, 4, project, "manager"), null);
  assert.equal(roomRoleCapabilitiesFromRegistry(null, workspace, 4, project, "manager"), null);
  const malformed = JSON.parse(JSON.stringify(registry));
  malformed.projects["test-project"].capabilities.roleTools.nativeDelegation = "true";
  assert.equal(roomRoleCapabilitiesFromRegistry(malformed, workspace, 4, project, "manager")?.nativeDelegation, false);
});
