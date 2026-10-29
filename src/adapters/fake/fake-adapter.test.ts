import { describe, expect, it } from "vitest";
import type { SessionId } from "../../contracts/index.js";
import type { AdapterHost } from "../../runner/host.js";
import { FAKE_ADAPTER_ID, FakeAdapter } from "./fake-adapter.js";
import { FAKE_SCENARIO_NAMES, fakeScenario } from "./scenarios.js";

const host: AdapterHost = {
  spawnContained: () => {
    throw new Error("aucun processus dans ce test");
  },
  authorize: () => ({ allowed: false, reason: "test", interruptSession: false }),
};

describe("adapter factice", () => {
  it("se déclare simulé et n'invente aucune capacité fournisseur", async () => {
    const adapter = new FakeAdapter({ host, scenario: fakeScenario("success") });
    const probe = await adapter.probe();
    expect(probe).toMatchObject({ adapterId: FAKE_ADAPTER_ID, available: true, simulated: true });
    expect(probe.executionMechanism).toContain("SIMULÉ");
    const capabilities = await adapter.capabilities();
    expect(capabilities.providerQuotaReading).toBe("none");
    expect(capabilities.cancellation).toBe("forced_only");
    expect(capabilities.residualUsageBound).toEqual({ unit: "tokens", amount: 0 });
  });

  it("n'affirme aucun usage pour une session qu'il n'a pas menée", async () => {
    const adapter = new FakeAdapter({ host, scenario: fakeScenario("success") });
    expect(await adapter.reconcile("inconnue" as SessionId)).toMatchObject({ status: "uncertain" });
  });

  it("des scénarios déterministes pour chaque cas prévu", () => {
    expect(FAKE_SCENARIO_NAMES).toEqual([
      "success",
      "slow",
      "rate_limited",
      "auth_error",
      "stubborn",
      "crash",
    ]);
    for (const name of FAKE_SCENARIO_NAMES) {
      expect(fakeScenario(name)).toEqual(fakeScenario(name));
    }
    expect(fakeScenario("stubborn").stubborn).toBe(true);
    expect(fakeScenario("crash").steps.some((s) => s.do === "end")).toBe(false);
    expect(fakeScenario("slow", { iterations: 3, pidFile: "p" })).toMatchObject({ pidFile: "p" });
  });
});
