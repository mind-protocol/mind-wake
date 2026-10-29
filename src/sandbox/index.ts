export { brokerPipeName, type BrokerEndpoint, type ProviderBroker } from "./broker.js";
export {
  CSC_PATH,
  ensureSandboxLauncher,
  sandboxSourceDigest,
  type SandboxLauncherStatus,
} from "./build.js";
export {
  ephemeralProfileName,
  Sandbox,
  SandboxedProcess,
  WAKE_APPCONTAINER_PROFILE,
  type AclStatus,
  type ProfileStatus,
  type SandboxExit,
  type SandboxLaunchSpec,
} from "./sandbox.js";
export {
  runIsolationSelfTest,
  type CheckOutcome,
  type IsolationSelfTestReport,
  type SelfTestCheck,
  type SelfTestCleanup,
  type SelfTestOptions,
  type SelfTestTermination,
} from "./self-test.js";
export {
  resolveRoots,
  SANDBOX_BASE_ENV_KEYS,
  sandboxEnvironment,
  SandboxSpecError,
  type RootSet,
} from "./spec.js";
