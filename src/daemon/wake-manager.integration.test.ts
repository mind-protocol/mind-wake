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

it.each([false, true, "passages"] as const)("switches the actual daemon prompt after ten sessions (allocation: %s)", async reordered => {
  const imported = reordered === "passages";
  const firstProject = reordered === true ? "b" : "a", secondProject = imported ? "a" : reordered ? "a" : "b";
  const dir = demoDir("wake-rotation-integration-");
  let daemon: WakeDaemon | undefined;
  let running: ReturnType<WakeDaemon["run"]> | undefined;
  try {
    seedSimulatedProfile(dir.path, { minIntervalMs: 0 });
    saveExecutionMode(dir.path, "always-on");
    const workspace = workspaceDirFor(dir.path);
    fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "artifacts/contexte-courant.txt"), "ANCIEN-GLENAN 10 sur 40");
    fs.writeFileSync(
      path.join(workspace, "artifacts/projets-compteur.json"),
      JSON.stringify({
        current: "a",
        projects: { a: { status: "en cours" }, b: { status: "en cours" } },
      }),
    );
    const manager = new WakeManager(workspace);
    manager.configure(true);
    for (const id of ["a", "b"]) manager.plan(id, Array.from({ length: 10 }, (_, i) => ({ wake: i + 1, objective: "Work", expected: "Evidence" })));
    if (imported) manager.importPassages(["return1","return2"].map(id=>({
      id, projectId:"a", question:`question ${id}`, expected:`result ${id}`, sources:[`${id}.md`],
      steps:Array.from({length:10},(_,i)=>({wake:i+1,objective:`${id} intention ${i+1}`,expected:"Evidence"})),
    })),manager.status()!.revision,"apply");
    else if (reordered) manager.reorderBlocks(manager.next(500).wakes.filter(wake => wake.inBlock === 1).map(wake => wake.projectId!).reverse(), manager.status()!.revision);
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
              if (imported && seen.length === 10) {
                const update = new WakeManager(workspace);
                try {
                  update.saveContext("a", {
                    summary: "RESULTAT ACCEPTE RETURN1", nextActions: ["Vérifier RETURN2"],
                    openQuestions: [], sources: ["preuve-return1.md"],
                  }, null);
                  update.planPassage("return2", Array.from({ length: 10 }, (_, i) => ({
                    wake: i + 1, objective: `return2 REVISEE intention ${i + 1}`, expected: "Evidence révisée",
                  })), update.status()!.revision);
                } finally { update.close(); }
              }
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
      expect(saved.project(firstProject).used).toBe(imported ? 11 : 10);
      expect(saved.project(secondProject).used).toBe(imported ? 11 : 1);
      expect(saved.next(1).wakes[0]).toMatchObject({ projectId: secondProject, inBlock: 2 });
      expect(fs.existsSync(path.join(workspace, contextPath(firstProject)))).toBe(true);
      expect(saved.project(firstProject).handoff?.["needsReview"]).toBe(true);
    } finally {
      saved.close();
    }
    expect(seen[0]?.text).toContain('"phase":"prepare"');
    expect(seen[9]?.text).toContain('"inBlock":10');
    expect(seen[10]?.text).toContain(`"projectId":"${secondProject}"`);
    expect(seen[10]?.text).toContain('"phase":"prepare"');
    expect(seen[0]?.system).toContain("name: planifier-wakes");
    expect(seen[0]?.text).not.toContain("name: planifier-wakes");
    expect(seen[1]?.system).not.toContain("name: planifier-wakes");
    expect(seen[9]?.system).not.toContain("name: planifier-wakes");
    expect(seen[10]?.system).toContain("name: planifier-wakes");
    if (imported) {
      expect(seen[0]?.text).toContain('"passageId":"return1"');
      expect(seen[9]?.text).toContain('"passageId":"return1"');
      expect(seen[10]?.text).toContain('"passageId":"return2"');
      expect(seen[10]?.text).toContain('"objective":"return2 REVISEE intention 1"');
      expect(seen[10]?.text).not.toContain("return1 intention");
      expect(seen[10]?.text).not.toContain('"objective":"return2 intention 1"');
      expect(seen[10]?.text).toContain('"summary":"RESULTAT ACCEPTE RETURN1"');
      expect(seen[10]?.text).toContain("Current project context from the active wake reservation");
      expect(seen.every(wake => !wake.text.includes("ANCIEN-GLENAN"))).toBe(true);
      expect(fs.readFileSync(path.join(workspace, "artifacts/contexte-courant.txt"), "utf8")).toBe("ANCIEN-GLENAN 10 sur 40");
      if (process.env["W500_PROOF_OUTPUT"]) fs.writeFileSync(process.env["W500_PROOF_OUTPUT"], JSON.stringify({
        simulated: true, sessions: result.sessions.length, first: seen[0], tenth: seen[9], secondPassage: seen[10],
        historicalFileUnchanged: true,
      }, null, 2));
    }
  } finally {
    daemon?.requestStop("test complete");
    await running;
    dir.remove();
  }
}, 60_000);
