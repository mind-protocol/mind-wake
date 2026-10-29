/**
 * Dépendances injectées de la CLI : E/S, environnement, horloge et stockage. Les tests
 * fournissent les leurs ; `main.ts` construit celles du processus.
 */

import os from "node:os";
import type { AgentId, ProfileId } from "../contracts/index.js";
import {
  openStore,
  probeSqliteDriver,
  STORE_BACKEND,
  type Persistence,
  type SqliteProbe,
  type Store,
  type StoreAccess,
} from "./store/index.js";

/** v0.1 : un seul utilisateur local, un seul agent (AGENTS §2). Identifiants stables. */
export const DEFAULT_PROFILE_ID = "default" as ProfileId;
export const DEFAULT_AGENT_ID = "default" as AgentId;

export interface CliContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly now: () => Date;
  readonly openStore: (dataDir: string, access: StoreAccess) => Store;
  /** Stockage que `openStore` ouvrirait, connu sans l'ouvrir. */
  readonly storeBackend: Persistence;
  readonly probeSqlite: () => Promise<SqliteProbe>;
}

export function processContext(): CliContext {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
    now: () => new Date(),
    openStore,
    storeBackend: STORE_BACKEND,
    probeSqlite: probeSqliteDriver,
  };
}
