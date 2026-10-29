/**
 * Banc de la démo SIMULÉE (AGENTS §7) et des recettes F2 en processus réels : un
 * dossier de données temporaire, un profil activé sur une policy qui désigne l'adapter
 * factice, et la vraie CLI (`src/cli/main.ts`) lancée dans des processus Node séparés —
 * `daemon run --simulated`, `pause`, `resume`, `stop`, `status`. Aucun appel modèle,
 * aucun réseau, aucune modification système persistante.
 *
 * Le profil est activé directement dans la base : `enable` refuse à juste titre tant que
 * l'isolation et l'adapter réel manquent. Cette activation de banc est marquée comme
 * telle dans la preuve de consentement.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AdapterId,
  ConsentId,
  PolicyGroups,
  PolicyRevisionId,
  ProfileId,
  SubscriptionQuotaGuard,
  UtcTimestamp,
} from "../../src/contracts/index.js";
import { POLICY_SCHEMA_VERSION } from "../../src/contracts/index.js";
import { controlDbPath, simulatedActivityFlagFor } from "../../src/daemon/index.js";
import { openStore, openStoreReadOnly, type Store } from "../../src/store/index.js";
import { SHARED_RUNTIME_DIR, policyGroups } from "../fixtures/runner/setup.js";

export const PROFILE = "default" as ProfileId;
export const REVISION = "rev-demo-1" as PolicyRevisionId;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = join(ROOT, "src", "cli", "main.ts");
const HOOKS = pathToFileURL(join(ROOT, "test", "fixtures", "store-ledger", "ts-hooks.ts")).href;

/** Arguments Node pour exécuter les sources TypeScript (cf. notes S6/S7). */
export const NODE_ARGS = [
  "--disable-warning=ExperimentalWarning",
  "--experimental-transform-types",
  "--import",
  HOOKS,
];

export interface DemoPolicyOptions {
  readonly minIntervalMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly tokensPerSession?: number;
  /** Adapter désigné par la policy ; `fake` par défaut. */
  readonly runtimeAdapterId?: string;
  /** Garde de quota d'abonnement (voie ADR-004/ADR-005) ; absente par défaut. */
  readonly subscriptionQuota?: SubscriptionQuotaGuard;
  /** Consentement au mode non isolé (ADR-006). */
  readonly hostUnsandboxed?: boolean;
  /** Champs du runtime remplacés (fournisseur, modèle, mode d'authentification). */
  readonly runtime?: Partial<Omit<PolicyGroups["runtime"], "adapterId">>;
}

/** Policy de la démo : adapter factice, aucune dépense, écriture sous `artifacts/`. */
export function demoPolicy(options: DemoPolicyOptions = {}): PolicyGroups {
  const base = policyGroups({
    maxSessionDurationMs: options.maxSessionDurationMs ?? 120_000,
    budget: {
      tokensPerSession: options.tokensPerSession ?? 4_000,
      tokensPerPeriod: 40_000,
      sessionsPerPeriod: 20,
      userReserveTokens: 2_000,
      checkpointTokens: 100,
      ...(options.subscriptionQuota === undefined
        ? {}
        : { subscriptionQuota: options.subscriptionQuota }),
    },
    filesAndTools: { readRoots: ["artifacts"], writeRoots: ["artifacts"] },
  });
  return {
    ...base,
    runtime: {
      ...base.runtime,
      ...options.runtime,
      adapterId: (options.runtimeAdapterId ?? base.runtime.adapterId) as AdapterId,
      ...(options.hostUnsandboxed === true ? { hostUnsandboxedAcknowledged: true } : {}),
    },
    schedule: { ...base.schedule, minIntervalBetweenSessionsMs: options.minIntervalMs ?? 1_500 },
  };
}

export function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

/** Profil `ready`, révision consentie et désignée active, comme après `enable`. */
export function seedSimulatedProfile(dataDir: string, options: DemoPolicyOptions = {}): void {
  const store = openStore(controlDbPath(dataDir));
  try {
    const at = utcNow();
    store.uow.transaction((tx) => {
      tx.profiles.create({
        id: PROFILE,
        agentId: "default" as PolicyGroups["identity"]["agentId"],
        state: "disabled",
        activePolicyRevisionId: null,
        nextWakeAt: null,
        emergencyStopLocked: false,
        stateReason: "profil de démonstration SIMULÉE",
        updatedAt: at,
      });
      tx.policies.appendRevision({
        schemaVersion: POLICY_SCHEMA_VERSION,
        id: REVISION,
        profileId: PROFILE,
        previousRevisionId: null,
        createdAt: at,
        groups: demoPolicy(options),
      });
      tx.policies.recordConsent({
        id: "consent-demo-1" as ConsentId,
        revisionId: REVISION,
        grantedAt: at,
        channel: "local_cli",
        proof: "banc de démonstration SIMULÉE (enable refuse sans isolation ni adapter réel)",
      });
      tx.profiles.transition(PROFILE, {
        from: "disabled",
        to: "ready",
        reason: "activation de banc (démonstration SIMULÉE)",
        at,
      });
      tx.profiles.setActivePolicyRevision(PROFILE, REVISION);
    });
  } finally {
    store.close();
  }
}

export interface DemoDir {
  readonly path: string;
  remove(): void;
}

export function demoDir(prefix = "mind-wake-demo-"): DemoDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Du lancement du processus à sa fin, mesuré par l'appelant. */
  readonly elapsedMs: number;
}

function env(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, MIND_WAKE_RUNTIME_DIR: SHARED_RUNTIME_DIR, ...extra };
}

/** Commande CLI dans un processus séparé, jusqu'à sa fin. */
export function cli(
  dataDir: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<CliRun> {
  const begin = performance.now();
  const child = spawn(process.execPath, [...NODE_ARGS, MAIN, ...args, "--data-dir", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: env(extraEnv),
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, elapsedMs: performance.now() - begin });
    });
  });
}

export interface RunningDaemon {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
  output(): string;
  /** Arrêt brutal du processus daemon (aucune fin enregistrée). */
  kill(): Promise<void>;
}

const live: ChildProcess[] = [];

/** `daemon run --simulated` dans un processus séparé. */
export function startDaemon(
  dataDir: string,
  args: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): RunningDaemon {
  const child = spawn(
    process.execPath,
    [...NODE_ARGS, MAIN, "daemon", "run", ...args, "--data-dir", dataDir],
    { stdio: ["ignore", "pipe", "pipe"], env: env(extraEnv), windowsHide: true },
  );
  live.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  return {
    child,
    exited,
    output: () => stdout,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Termine les daemons encore vivants (fin de test). */
export async function killAllDaemons(): Promise<void> {
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
}

/** Lecture seule de la base de contrôle, le temps de `fn`. */
export function readDb<T>(dataDir: string, fn: (store: Store) => T): T {
  const store = openStoreReadOnly(controlDbPath(dataDir));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * Attend que `predicate` soit vrai en relisant la base toutes les `pollMs` ; renvoie le
 * délai écoulé depuis `since` (horloge monotone du banc).
 */
export async function waitFor(
  dataDir: string,
  predicate: (store: Store) => boolean,
  label: string,
  timeoutMs = 30_000,
  since = performance.now(),
  pollMs = 5,
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = readDb(dataDir, predicate);
    } catch {
      // Base momentanément occupée ou en cours de création : relire.
    }
    if (ok) return performance.now() - since;
    if (performance.now() > deadline) throw new Error(`attente expirée : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function profileState(store: Store): string | undefined {
  return store.uow.profiles.get(PROFILE)?.state;
}

export function countEvents(store: Store, type: string): number {
  return store.uow.journal.list(PROFILE).filter((e) => e.type === type).length;
}

export function setUserActive(dataDir: string, active: boolean): void {
  const flag = simulatedActivityFlagFor(dataDir);
  if (active) writeFileSync(flag, "activité utilisateur simulée\n");
  else rmSync(flag, { force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
