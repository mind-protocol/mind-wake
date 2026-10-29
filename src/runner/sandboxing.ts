/**
 * Lancement confiné d'une session (S10 → runner, ADR-003, ADR-005) : un adapter réel ne
 * lance son runtime que dans la sandbox AppContainer + Job Object de `src/sandbox`, avec
 * les seules racines de la policy, aucun environnement hérité et le réseau fermé sauf le
 * pipe du broker. L'adapter factice continue sans sandbox (Job Object seul), marqué SIMULÉ.
 *
 * Le runner ne dépend ici que des types de `src/sandbox` : le daemon fournit l'instance.
 */

import fs from "node:fs";
import path from "node:path";
import type { PolicyRevision, ProfileId, SessionId } from "../contracts/index.js";
import type { BrokerEndpoint, SandboxLaunchSpec } from "../sandbox/index.js";
import { jobNameFor, type ContainedCommand, type SessionProcess } from "./process-tree.js";

/** Variable transmise au conteneur : chemin du pipe broker, seule sortie réseau. */
export const BROKER_PIPE_ENV = "MIND_WAKE_BROKER_PIPE";

/** État de l'isolation au moment du lancement. */
export interface SandboxReadiness {
  /** Lanceur construit, profil présent et autotest de refus réussi pour ce binaire. */
  readonly ok: boolean;
  readonly detail: string;
}

/** Couche d'isolation fournie au runner par le daemon. */
export interface RunnerSandbox {
  /** Revérifié à chaque lancement ; tant que l'autotest n'a pas réussi, aucun lancement. */
  ready(): SandboxReadiness;
  launch(spec: SandboxLaunchSpec): SessionProcess;
  /** Espace d'exploration : les racines relatives de la policy y sont résolues. */
  readonly workspaceDir: string;
  /** Racines runtime en lecture et exécution (copie du CLI, de Node…). */
  readonly runtimeRoots: readonly string[];
  /** Base de contrôle, policy, dossier de données : jamais dans une racine accordée. */
  readonly protectedPaths: readonly string[];
  /** Canal du broker fournisseur, s'il est en service. */
  broker?(): BrokerEndpoint | null;
}

export class SandboxLaunchError extends Error {
  override readonly name = "SandboxLaunchError";
}

/** Racine relative de la policy (`.` = tout l'espace) → chemin absolu, créé au besoin. */
function rootUnder(workspaceDir: string, root: string): string {
  const resolved = root === "." ? workspaceDir : path.join(workspaceDir, ...root.split("/"));
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SandboxLaunchError(`racine hors de l'espace d'exploration : ${root}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export interface ConfinedLaunch {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  readonly revision: PolicyRevision;
  readonly command: ContainedCommand;
  /** Filet de durée imposé par le lanceur lui-même, au-delà de l'échéance du runner. */
  readonly maxWallMs: number;
}

/** Spécification de lancement confiné : racines, limites et canal issus de la policy. */
export function sandboxSpecFor(sandbox: RunnerSandbox, launch: ConfinedLaunch): SandboxLaunchSpec {
  const files = launch.revision.groups.filesAndTools;
  const writeRoots = files.writeRoots.map((r) => rootUnder(sandbox.workspaceDir, r));
  const readRoots = files.readRoots
    .map((r) => rootUnder(sandbox.workspaceDir, r))
    .filter((r) => !writeRoots.includes(r));
  const maxProcesses = Math.min(
    launch.command.maxProcesses ?? files.maxProcesses,
    files.maxProcesses,
  );
  let broker: BrokerEndpoint | null = null;
  if (launch.command.broker === true) {
    broker = sandbox.broker?.() ?? null;
    if (broker === null) throw new SandboxLaunchError("broker fournisseur demandé mais absent");
  }
  const env: Record<string, string> = { ...launch.command.env };
  if (broker !== null) env[BROKER_PIPE_ENV] = `\\\\.\\pipe\\${broker.pipeName}`;
  return {
    jobName: jobNameFor(launch.profileId, launch.sessionId),
    executable: launch.command.executable,
    args: launch.command.args,
    cwd: launch.command.cwd ?? writeRoots[0] ?? sandbox.workspaceDir,
    readWriteRoots: writeRoots,
    readOnlyRoots: [...sandbox.runtimeRoots, ...readRoots],
    protectedPaths: sandbox.protectedPaths,
    env,
    maxProcesses,
    maxWallMs: Math.min(Math.max(1, Math.ceil(launch.maxWallMs)), 2_147_483_647),
    ...(broker === null ? {} : { broker }),
  };
}
