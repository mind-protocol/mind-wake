import { describe, expect, it } from "vitest";
import type { SessionId } from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import type { IsolationSelfTestReport } from "../../sandbox/self-test.js";
import type { SandboxLaunchSpec } from "../../sandbox/sandbox.js";
import {
  hostLaunchPort,
  sandboxLaunchPort,
  type GeminiLaunchSpec,
  type GeminiProcess,
} from "./launch.js";

const SPEC: GeminiLaunchSpec = {
  sessionId: "s-1" as SessionId,
  executable: "C:/wake/runtime/node.exe",
  args: ["C:/wake/runtime/gemini/index.js", "--prompt=x"],
  workspace: "C:/wake/espace",
  home: "C:/wake/gemini-home",
  env: { GEMINI_CLI_HOME: "C:/wake/gemini-home" },
  broker: { pipeName: "mindwake-broker-x", port: 40_000 },
  maxWallMs: 60_000,
};

const PROCESS = {} as GeminiProcess;

function report(passed: boolean): IsolationSelfTestReport {
  return {
    passed,
    platform: "win32",
    profile: null,
    checks: [],
    termination: null,
    cleanup: null,
    notDemonstrated: [],
    durationMs: 1,
    ...(passed ? {} : { error: "refus manquant" }),
  };
}

describe("sandboxLaunchPort", () => {
  function port(operational: boolean, selfTest: IsolationSelfTestReport | null) {
    const launched: SandboxLaunchSpec[] = [];
    const launchPort = sandboxLaunchPort({
      sandbox: {
        health: () => ({ operational, detail: operational ? "profil présent" : "profil absent" }),
        launch: (spec) => {
          launched.push(spec);
          return PROCESS;
        },
      },
      jobName: (sessionId) => `mindwake-job-${sessionId}`,
      runtimeRoots: ["C:/wake/runtime"],
      protectedPaths: ["C:/wake/data"],
      selfTest: () => selfTest,
      memoryLimitMb: 2_048,
    });
    return { launchPort, launched };
  }

  it("n'est vérifiée qu'avec une sandbox opérationnelle et un autotest réussi", async () => {
    expect((await port(true, report(true)).launchPort.isolationVerified()).verified).toBe(true);
    expect(await port(true, null).launchPort.isolationVerified()).toMatchObject({
      verified: false,
      detail: expect.stringMatching(/jamais/) as unknown,
    });
    expect(await port(true, report(false)).launchPort.isolationVerified()).toMatchObject({
      verified: false,
      detail: expect.stringMatching(/échec/) as unknown,
    });
    expect((await port(false, report(true)).launchPort.isolationVerified()).verified).toBe(false);
  });

  it("accorde l'espace et le home en écriture, le runtime en lecture, et le broker", () => {
    const { launchPort, launched } = port(true, report(true));
    expect(launchPort.launch(SPEC)).toBe(PROCESS);
    expect(launched[0]).toEqual({
      jobName: "mindwake-job-s-1",
      executable: SPEC.executable,
      args: SPEC.args,
      cwd: SPEC.workspace,
      readWriteRoots: [SPEC.workspace, SPEC.home],
      readOnlyRoots: ["C:/wake/runtime"],
      protectedPaths: ["C:/wake/data"],
      env: SPEC.env,
      maxWallMs: 60_000,
      memoryLimitMb: 2_048,
      broker: SPEC.broker,
    });
  });
});

describe("hostLaunchPort", () => {
  it("n'est jamais une isolation et passe par l'arborescence contenue du runner", async () => {
    const calls: unknown[] = [];
    const host = {
      spawnContained: (sessionId: SessionId, command: unknown) => {
        calls.push({ sessionId, command });
        return PROCESS;
      },
      authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
    } as unknown as AdapterHost;
    const launchPort = hostLaunchPort(host);
    expect(launchPort.kind).toBe("host");
    expect((await launchPort.isolationVerified()).verified).toBe(false);
    launchPort.launch(SPEC);
    expect(calls).toEqual([
      {
        sessionId: "s-1",
        command: {
          executable: SPEC.executable,
          args: SPEC.args,
          env: SPEC.env,
          cwd: SPEC.workspace,
        },
      },
    ]);
  });
});
