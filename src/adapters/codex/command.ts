/**
 * Construction de la commande `codex app-server` et des paramètres de fil, à partir de
 * la configuration Wake seule : `CODEX_HOME` dédié (jamais celui de l'utilisateur, dont
 * le `config.toml` et les credentials ne sont pas lus), environnement explicite sans
 * secret, surcharges `-c` limitées à des clés documentées.
 */

import os from "node:os";
import path from "node:path";
import type { CodexCommand, ProviderChannel } from "./launch.js";

/** Même règle que la sandbox (`spec.ts`) : aucun nom de secret dans l'environnement. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export class CodexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigError";
  }
}

/** Exécutable Codex : binaire natif, ou interpréteur + script (`node codex.js`). */
export interface CodexExecutable {
  readonly path: string;
  readonly prefixArgs?: readonly string[];
}

/**
 * Surcharges de configuration fixées par Wake (Configuration Reference de Codex) :
 * environnement des commandes du modèle sans héritage, retries bas (chaque retry
 * consomme du quota).
 */
export const WAKE_CONFIG_OVERRIDES: Readonly<Record<string, string>> = {
  "shell_environment_policy.inherit": '"none"',
  request_max_retries: "1",
  stream_max_retries: "1",
};

export interface BuildCommandInput {
  readonly executable: CodexExecutable;
  readonly codexHome: string;
  readonly workspaceDir: string;
  readonly channel: ProviderChannel | null;
  readonly extraConfig?: Readonly<Record<string, string>>;
  readonly userHome?: string;
  /**
   * Accepte le `CODEX_HOME` de l'utilisateur et sa connexion déjà configurée : lancement
   * manuel par l'humain seulement (test de fumée), jamais en autonome.
   */
  readonly allowUserCodexHome?: boolean;
}

/** Refuse le dossier Codex de l'utilisateur (credentials et configuration personnels). */
export function assertDedicatedCodexHome(codexHome: string, userHome = os.homedir()): void {
  if (!path.isAbsolute(codexHome)) {
    throw new CodexConfigError(`CODEX_HOME doit être absolu : ${codexHome}`);
  }
  const personal = path.resolve(userHome, ".codex");
  const rel = path.relative(personal, path.resolve(codexHome));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new CodexConfigError("CODEX_HOME ne peut pas être le dossier Codex de l'utilisateur");
  }
}

function checkEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key) || /[\0\r\n]/.test(value)) {
      throw new CodexConfigError(`variable invalide : ${key}`);
    }
    if (SECRET_NAME.test(key)) {
      throw new CodexConfigError(`variable au nom de secret refusée : ${key}`);
    }
  }
}

function configArgs(overrides: Readonly<Record<string, string>>): string[] {
  return Object.entries(overrides).flatMap(([key, value]) => {
    if (!CONFIG_KEY.test(key) || /[\0\r\n]/.test(value)) {
      throw new CodexConfigError(`surcharge de configuration invalide : ${key}`);
    }
    return ["-c", `${key}=${value}`];
  });
}

export function buildAppServerCommand(input: BuildCommandInput): CodexCommand {
  if (input.allowUserCodexHome === true) {
    if (!path.isAbsolute(input.codexHome)) {
      throw new CodexConfigError(`CODEX_HOME doit être absolu : ${input.codexHome}`);
    }
  } else {
    assertDedicatedCodexHome(input.codexHome, input.userHome);
  }
  if (!path.isAbsolute(input.workspaceDir)) {
    throw new CodexConfigError(`dossier de travail non absolu : ${input.workspaceDir}`);
  }
  const env: Record<string, string> = {
    ...(input.channel?.env ?? {}),
    CODEX_HOME: input.codexHome,
  };
  checkEnv(env);
  // Ordre : réglages Wake, puis ceux du relais (fournisseur), puis ceux de l'appelant ;
  // les réglages Wake de sûreté sont réappliqués en dernier et ne peuvent être écrasés.
  const overrides = {
    ...WAKE_CONFIG_OVERRIDES,
    ...(input.channel?.configOverrides ?? {}),
    ...(input.extraConfig ?? {}),
    ...WAKE_CONFIG_OVERRIDES,
  };
  return {
    executable: input.executable.path,
    args: [
      ...(input.executable.prefixArgs ?? []),
      ...configArgs(overrides),
      "app-server",
      "--listen",
      "stdio://",
    ],
    env,
    cwd: input.workspaceDir,
    ...(input.channel?.broker === undefined ? {} : { broker: input.channel.broker }),
  };
}

/** Permissions demandées à Codex pour un fil (`thread/start`, `thread/resume`). */
export interface ThreadPermissions {
  readonly approvalPolicy: "never";
  readonly sandbox: "danger-full-access" | "workspace-write" | "read-only";
}

/** Sandbox Codex conservée hors AppContainer. */
export type HostSandbox = "workspace-write" | "read-only";

/**
 * Sans approbation, toujours : personne n'est là pour répondre. Sous AppContainer avec
 * autotest réussi, Codex n'ajoute pas sa propre sandbox (`danger-full-access`, équivalent
 * de `--dangerously-bypass-approvals-and-sandbox`) ; sinon il garde sa sandbox Windows
 * (`workspace-write` par défaut, ou `read-only`), réseau des commandes coupé.
 */
export function threadPermissions(
  bypass: boolean,
  hostSandbox: HostSandbox = "workspace-write",
): ThreadPermissions {
  return { approvalPolicy: "never", sandbox: bypass ? "danger-full-access" : hostSandbox };
}
