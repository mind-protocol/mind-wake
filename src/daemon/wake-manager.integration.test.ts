/** Eleven real child processes, deterministic adapter; no model or network. */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { demoDir, seedSimulatedProfile, PROFILE } from "../../test/demo/harness.js";
import { SHARED_RUNTIME_DIR } from "../../test/fixtures/runner/setup.js";
import { WakeManager, contextPath } from "./wake-manager.js";
import { WakeDaemon } from "./daemon.js";
import { workspaceDirFor } from "./paths.js";
import { saveExecutionMode } from "./execution-mode.js";
import { AdapterRegistry, FAKE_REGISTRATION } from "./registry.js";

it("switches the actual daemon prompt after ten started principal sessions", async () => {
  const dir = demoDir("wake-rotation-integration-");
  let daemon: WakeDaemon | undefined;
  let running: ReturnType<WakeDaemon["run"]> | undefined;
  try {
    seedSimulatedProfile(dir.path, { minIntervalMs: 0 });
    saveExecutionMode(dir.path, "always-on");
    const workspace = workspaceDirFor(dir.path);
    fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "artifacts/projets-compteur.json"),
      JSON.stringify({
        current: "a",
        projects: { a: { status: "en cours" }, b: { status: "en cours" } },
      }),
    );
    const manager = new WakeManager(workspace);
    manager.configure(true);
    manager.close();
    const seen: { text: string; system: string }[] = [];
    daemon = await WakeDaemon.open({
      dataDir: dir.path,
      profileId: PROFILE,
      simulated: true,
      runtimeDir: SHARED_RUNTIME_DIR,
      exitAfterSessions: 11,
      scenario: {
        name: "rotation",
        steps: [
          { do: "usage", tokens: 1 },
          { do: "end", reason: "done" },
        ],
      },
      registry: new AdapterRegistry([
        {
          ...FAKE_REGISTRATION,
          create(context) {
            const adapter = FAKE_REGISTRATION.create(context);
            const start = adapter.start.bind(adapter);
            adapter.start = (request) => {
              seen.push({ text: request.context, system: request.systemContext ?? "" });
              return start(request);
            };
            return adapter;
          },
        },
      ]),
    });
    running = daemon.run();
    const result = await running;
    expect(result.sessions).toHaveLength(11);
    expect(result.sessions.every((s) => s.outcome === "completed")).toBe(true);
    const saved = new WakeManager(workspace);
    try {
      expect(saved.status()?.used).toBe(11);
      expect(saved.project("a").used).toBe(10);
      expect(saved.project("b").used).toBe(1);
      expect(saved.next(1).wakes[0]).toMatchObject({ projectId: "b", inBlock: 2 });
      expect(fs.existsSync(path.join(workspace, contextPath("a")))).toBe(true);
      expect(saved.project("a").handoff?.["needsReview"]).toBe(true);
    } finally {
      saved.close();
    }
    expect(seen[0]?.text).toContain('"phase":"prepare"');
    expect(seen[9]?.text).toContain('"inBlock":10');
    expect(seen[10]?.text).toContain('"projectId":"b"');
    expect(seen[10]?.text).toContain('"phase":"prepare"');
    expect(seen[0]?.system).toContain("prépare les neuf suivants");
    expect(seen[0]?.text).not.toContain("prépare les neuf suivants");
  } finally {
    daemon?.requestStop("test complete");
    await running;
    dir.remove();
  }
}, 60_000);
