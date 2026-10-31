import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { demoDir, seedSimulatedProfile, PROFILE } from "../../test/demo/harness.js";
import type { AdapterId } from "../contracts/index.js";
import { AdapterRegistry, FAKE_REGISTRATION, type AdapterRegistration } from "./registry.js";
import { WakeDaemon } from "./daemon.js";
import { configureWorkspaceSync } from "./workspace-git-sync.js";
import { workspaceDirFor } from "./paths.js";
it("activates the selected workspace before realMode creates even its probe adapter", async () => {
  const dir = demoDir("wake-selected-probe-");
  try {
    const id = "workspace-probe" as AdapterId;
    seedSimulatedProfile(dir.path, { runtimeAdapterId: id, hostUnsandboxed: true });
    const selected = path.join(dir.path, "selected");
    fs.mkdirSync(selected);
    await configureWorkspaceSync(dir.path, {
      workspaceDir: selected,
      githubUrl: "",
      enabled: false,
    });
    let observed = "";
    const registration: AdapterRegistration = {
      id,
      simulated: false,
      runtime: () => ({ adapterId: id, provider: "none", model: "none", authMode: "none" }),
      billing: () => ({ kind: "no_charge" }),
      create: (context) => {
        observed = context.workspaceDir;
        const adapter = FAKE_REGISTRATION.create(context);
        adapter.probe = () =>
          Promise.resolve({
            adapterId: id,
            version: "fixture",
            executionMechanism: "probe only",
            available: false,
            simulated: false,
          });
        return adapter;
      },
    };
    await expect(
      WakeDaemon.open({
        dataDir: dir.path,
        profileId: PROFILE,
        simulated: false,
        registry: new AdapterRegistry([registration]),
      }),
    ).rejects.toMatchObject({ code: "adapter_unavailable" });
    expect(observed).toBe(selected);
    expect(workspaceDirFor(dir.path)).toBe(selected);
  } finally {
    dir.remove();
  }
});
