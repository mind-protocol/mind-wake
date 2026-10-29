export { DaemonError, WakeDaemon, reportFor } from "./daemon.js";
export type { DaemonIsolation, DaemonOptions, DaemonSummary } from "./daemon.js";
export {
  RuntimeEnvironment,
  SIMULATED_RUNTIME,
  SimulatedActivitySignal,
  SimulatedEnvironment,
  runtimeLiveChecks,
  simulatedLiveChecks,
} from "./environment.js";
export { parseProposal, registerProposal } from "./experiments.js";
export type { ExperimentProposal, ProposalContext, ProposalOutcome } from "./experiments.js";
export {
  latestSelfTest,
  recordSelfTest,
  selfTestRecordFor,
  selfTestValidFor,
} from "./isolation.js";
export type { IsolationSelfTestRecord } from "./isolation.js";
export {
  ARTIFACTS_SEGMENT,
  CONTROL_DB_FILE,
  artifactsDirFor,
  controlDbPath,
  simulatedActivityFlagFor,
  workspaceDirFor,
} from "./paths.js";
export { AdapterRegistry, FAKE_REGISTRATION, RUNTIME_IDS, defaultRegistry } from "./registry.js";
export type { AdapterFactoryContext, AdapterRegistration, RuntimeId } from "./registry.js";
export { buildReport, formatReport } from "./report.js";
export type { ExperimentReport, SessionSummary } from "./report.js";
export {
  closeAbandonedRuns,
  isProcessAlive,
  latestDaemonRun,
  recordDaemonEnd,
  recordDaemonStart,
} from "./runs.js";
export type { DaemonMode, DaemonRun } from "./runs.js";
export {
  DEFAULT_PROMPTS_DIR,
  NUDGES,
  WAKE_FIELDS,
  agentNote,
  chooseNudge,
  composeWake,
  describePermissions,
  fillTemplate,
  loadWakeTemplates,
  nudgeFromNextAction,
  previousNudge,
  quotaPlanText,
  recordWakePrompt,
  rotateNudge,
} from "./wake-prompt.js";
export type { Nudge, WakeComposition, WakeInputs, WakeTemplates } from "./wake-prompt.js";
export {
  AgentWakeups,
  MAX_FILES,
  MAX_WAKEUP_BYTES,
  WAKEUP_SCHEMA_FILE,
  WAKEUPS_SEGMENT,
} from "./wakeups.js";
export type { AgentWakeup, QuotaSource, WakeupRequest } from "./wakeups.js";
