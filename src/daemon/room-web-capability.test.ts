import path from "node:path";
import { describe, expect, it } from "vitest";
import { roomWebSearchFromRegistry } from "./room-web-capability.js";

const workspace = path.resolve("fixture-owner-workspace");
const project = "recrutement-fixture";
const cwd = path.join(workspace, "artifacts", "projets", project);
const registry = (changes: Record<string, unknown> = {}) => ({ projects: {
  [project]: { status: "en cours", room: 4,
    capabilities: { webSearch: { mode: "live", agents: ["explorer"] } }, ...changes },
} });
const read = (counter: Record<string, unknown> | null, room = 4, dir = cwd, agent = "explorer") =>
  roomWebSearchFromRegistry(counter, workspace, room, dir, agent);

describe("room web search explicit owner capability", () => {
  it("allows only the declared room, workspace and agent", () => {
    expect(read(registry())).toBe("live");
    expect(read(registry(), 6)).toBe("disabled");
    expect(read(registry(), 4, path.join(workspace, "another-project"))).toBe("disabled");
    expect(read(registry(), 4, cwd, "other")).toBe("disabled");
  });
  it("defaults off for absent or malformed capability", () => {
    expect(read(null)).toBe("disabled");
    expect(read(registry({ capabilities: null }))).toBe("disabled");
    expect(read(registry({ capabilities: { webSearch: { mode: "all", agents: ["explorer"] } } }))).toBe("disabled");
    expect(read(registry({ capabilities: { webSearch: { mode: "live", agents: "explorer" } } }))).toBe("disabled");
  });
  it("honours project pause, block and explicit disabled", () => {
    expect(read(registry({ status: "pause : humain" }))).toBe("disabled");
    expect(read(registry({ status: "blocked : accès" }))).toBe("disabled");
    expect(read(registry({ capabilities: { webSearch: { mode: "disabled", agents: ["explorer"] } } }))).toBe("disabled");
    expect(read(registry({ capabilities: { webSearch: { mode: "cached", agents: ["explorer"] } } }))).toBe("cached");
  });
  it("rejects path traversal and invalid room numbers", () => {
    expect(read(registry(), 1)).toBe("disabled");
    expect(read(registry(), 4, "relative")).toBe("disabled");
    const counter = { projects: { "../recrutement-fixture": registry().projects[project] } };
    expect(read(counter)).toBe("disabled");
  });
});
