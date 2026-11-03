import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
export function nativeCodexPolicy({
  model = "gpt-6.1-sol",
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw Error("Modèle invalide.");
  new Intl.DateTimeFormat("en", { timeZone });
  const policy = JSON.parse(
    fs.readFileSync(path.join(repo, "src/adapters/claude/policy-claude.example.json"), "utf8"),
  );
  delete policy.identity;
  policy.runtime = {
    adapterId: "codex",
    provider: "openai",
    model: model,
    authMode: "chatgpt",
    hostUnsandboxedAcknowledged: true,
    nativeCapabilities: true,
  };
  Object.assign(policy.schedule, {
    timeZone: timeZone,
    weeklyWindows: Array.from({ length: 7 }, (_, day) => ({ day, start: "00:00", end: "24:00" })),
    minIntervalBetweenSessionsMs: 0,
    maxSessionDurationMs: 0,
  });
  Object.assign(policy.humanPriority, { activitySignal: "none", idleThresholdMs: 0 });
  Object.assign(policy.budget, {
    tokensPerSession: 0,
    tokensPerPeriod: 0,
    sessionsPerPeriod: 0,
    userReserveTokens: 0,
    checkpointTokens: 0,
    paidApi: { authorized: false },
  });
  policy.budget.period.timeZone = timeZone;
  Object.assign(policy.budget.subscriptionQuota, {
    enabled: true,
    accountRiskAcknowledged: true,
    providerLimitsOnly: true,
    startBelowBasisPoints: 10000,
    stopAtBasisPoints: 10000,
    userReserveBasisPoints: 0,
    overshootBoundBasisPoints: null,
    targetUsageBasisPoints: 10000,
  });
  policy.filesAndTools.allowedExecutables = ["codex"];
  policy.network.providerTransportDestinations = ["chatgpt.com", "api.openai.com"].map((host) => ({
    host,
    ports: [443],
    purpose: "Codex avec connexion ChatGPT",
  }));

  return policy;
}
