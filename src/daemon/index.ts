export { DaemonError, WakeDaemon, reportFor } from "./daemon.js";
export type { DaemonOptions, DaemonSummary } from "./daemon.js";
export {
  SIMULATED_RUNTIME,
  SimulatedActivitySignal,
  SimulatedEnvironment,
  simulatedLiveChecks,
} from "./environment.js";
export { parseProposal, registerProposal } from "./experiments.js";
export type { ExperimentProposal, ProposalContext, ProposalOutcome } from "./experiments.js";
export {
  ARTIFACTS_SEGMENT,
  CONTROL_DB_FILE,
  artifactsDirFor,
  controlDbPath,
  simulatedActivityFlagFor,
  workspaceDirFor,
} from "./paths.js";
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
