/**
 * Enregistrement de Codex dans le registre d'adapters du daemon (`defaultRegistry()`).
 *
 * Runtime déclaré : fournisseur `openai`, connexion ChatGPT (`authMode: "chatgpt"`),
 * modèle fixé par la configuration Wake, facturation `subscription_quota` (forfait borné
 * par la jauge officielle, ADR-004/005). Sur l'hôte, le mode sans approbation n'est
 * accordé qu'avec `runtime.hostUnsandboxedAcknowledged` (ADR-006), constaté par le runner.
 */

import { withFilResume } from "../../communication/fil-continuity.js";
import { WAKE_HOME_SYSTEM_PROMPT, withWakePersonality } from "../wake-system-prompt.js";
import { discoverCodex, executableFromPath } from "./executable.js";
import path from "node:path";
import { saveStepsResult } from "../../daemon/wake-steps.js";
import type { ProfileId, StartRequest } from "../../contracts/index.js";
import type { AdapterRegistration } from "../../daemon/registry.js";
import { ProcessTreeSupervisor } from "../../runner/process-tree.js";
import { runtimeDirFor } from "../../runner/paths.js";
import { CODEX_ADAPTER_ID, CodexAdapter } from "./codex-adapter.js";
import type { CodexExecutable } from "./command.js";
import { FileThreadStore } from "./continuity.js";
import { hostLauncher, supervisorLauncher } from "./launch.js";

/** Modèle par défaut : accepté avec une connexion ChatGPT (fumée réelle du 29/10/2026). */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";

export interface CodexRegistrationConfig {
  /** Binaire Codex ; absent : résolu au premier besoin par `discoverCodex()`. */
  readonly executable?: CodexExecutable;
  /** Modèle fixé par la configuration Wake, comparé à `policy.runtime.model`. */
  readonly model: string;
  readonly effort?: string;
  /** `CODEX_HOME` dédié à Wake, où l'humain fait `codex login` ; défaut `<données>/codex-home`. */
  readonly codexHome?: string;
  /** Fils persistés, hors de l'espace d'exploration ; défaut `<données>/codex-threads`. */
  readonly threadsDir?: string;
  readonly systemPrompt?: string | ((request: StartRequest) => string);
  /** Racines à accorder en lecture/exécution dans la sandbox ; défaut : dossier du binaire. */
  readonly runtimeRoots?: readonly string[];
}

/** Profil synthétique des Job Objects de lecture de jauge (hors session). */
const QUOTA_PROFILE = "codex-quota" as ProfileId;

export function codexRegistration(config: CodexRegistrationConfig): AdapterRegistration {
  let located: CodexExecutable | null = null;
  // Résolution paresseuse : construire le registre ne lance aucun processus.
  const executable = (): CodexExecutable =>
    config.executable ?? (located ??= discoverCodex() ?? { path: "codex.exe" });
  return {
    id: CODEX_ADAPTER_ID,
    simulated: false,
    runtime: () => ({
      adapterId: CODEX_ADAPTER_ID,
      provider: "openai",
      model: config.model,
      authMode: "chatgpt",
    }),
    billing: () => ({ kind: "subscription_quota" }),
    runtimeRoots: () => {
      const resolved = executable();
      const script = resolved.prefixArgs?.[0];
      return (
        config.runtimeRoots ?? [
          path.dirname(resolved.path),
          ...(script ? [path.resolve(path.dirname(script), "../..")] : []),
        ]
      );
    },
    create: (context) =>
      new CodexAdapter({
        stepsStopHook: true,
        onStepsResult: (request, raw) =>
          saveStepsResult(
            context.workspaceDir,
            context.dataDir,
            request.policy.groups.identity.agentId,
            request.sessionId,
            raw,
          ),
        executable: executable(),
        codexHome: config.codexHome ?? path.join(context.dataDir, "codex-home"),
        workspaceDir: context.workspaceDir,
        ownerInboxDir: context.dataDir,
        nativeCapabilities: context.nativeCapabilities === true,
        ...(process.env["CODEX_HOME"]
          ? { nativeCodexHome: path.resolve(process.env["CODEX_HOME"]) }
          : {}),
        launcher: hostLauncher(context.host),
        quotaLauncher: supervisorLauncher(
          new ProcessTreeSupervisor(runtimeDirFor(context.dataDir)),
          QUOTA_PROFILE,
        ),
        threads: new FileThreadStore(
          config.threadsDir ?? path.join(context.dataDir, "codex-threads"),
        ),
        model: config.model,
        ...(config.effort === undefined ? {} : { effort: config.effort }),
        systemPrompt: (request) =>
          withFilResume(
            context.dataDir,
            context.workspaceDir,
            withWakePersonality(
              context.workspaceDir,
              typeof config.systemPrompt === "function"
                ? config.systemPrompt(request)
                : (config.systemPrompt ?? WAKE_HOME_SYSTEM_PROMPT),
            ),
          ),
      }),
  };
}

/** Chemin du processus Codex (Node pour npm) ; préférer discoverCodex pour ses arguments. */
export function locateCodex(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return discoverCodex(env)?.path ?? null;
}

/**
 * Configuration Codex du build, lue dans l'environnement du daemon (aucun secret) :
 * `MIND_WAKE_CODEX_BIN`, `MIND_WAKE_CODEX_MODEL`, `MIND_WAKE_CODEX_EFFORT`. Un binaire
 * introuvable donne une sonde indisponible, jamais un repli.
 */
export function codexRegistrationFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdapterRegistration {
  const effort = env["MIND_WAKE_CODEX_EFFORT"];
  const bin = env["MIND_WAKE_CODEX_BIN"];
  return codexRegistration({
    ...(bin === undefined || bin === ""
      ? {}
      : { executable: executableFromPath(path.resolve(bin)) ?? { path: bin } }),
    model: env["MIND_WAKE_CODEX_MODEL"] ?? CODEX_DEFAULT_MODEL,
    ...(effort === undefined || effort === "" ? {} : { effort }),
  });
}
