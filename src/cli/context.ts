/**
 * Dépendances injectées de la CLI : E/S, environnement, horloge et stockage. Les tests
 * fournissent les leurs ; `main.ts` construit celles du processus.
 */

import os from "node:os";
import readline from "node:readline/promises";
import type { AgentId, ProfileId } from "../contracts/index.js";
import { runIsolationSelfTest, type IsolationSelfTestReport } from "../sandbox/index.js";
import { windowsIdleSource } from "../scheduler/priority.js";
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
  /**
   * Saisie interactive dans le terminal de l'humain (canal de confiance de `enable` et
   * `uninstall`). Absente hors terminal interactif : les commandes exigent alors une
   * option explicite.
   */
  readonly prompt?: (question: string) => Promise<string | null>;
  /**
   * Interruption au clavier (Ctrl+C) pour `daemon run` ; renvoie de quoi se désabonner.
   * Absente dans les tests : le daemon s'arrête alors par ses propres conditions.
   */
  readonly onInterrupt?: (handler: () => void) => () => void;
  /** Fin immédiate du processus (second Ctrl+C de `daemon run`). */
  readonly exit?: (code: number) => void;
  /**
   * Autotest de refus de l'isolation (`doctor`) : profil AppContainer et ACE temporaires,
   * retirés et vérifiés. Absent : l'isolation reste « non implémentée ».
   */
  readonly isolationSelfTest?: () => Promise<IsolationSelfTestReport>;
  /**
   * Une lecture de l'inactivité réelle du poste (`GetLastInputInfo`), pour `doctor`.
   * Absente : le signal réel n'est pas vérifié.
   */
  readonly idleProbe?: () => Promise<number>;
}

async function promptTerminal(question: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    return null;
  } finally {
    rl.close();
  }
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
    isolationSelfTest: () => runIsolationSelfTest(),
    ...(process.platform === "win32" ? { idleProbe: () => windowsIdleSource().idleMs() } : {}),
    ...(process.stdin.isTTY && process.stdout.isTTY ? { prompt: promptTerminal } : {}),
    onInterrupt: (handler) => {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
    exit: (code) => process.exit(code),
  };
}
