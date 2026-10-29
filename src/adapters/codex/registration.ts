/**
 * Enregistrement de Codex dans le registre d'adapters du daemon (forme `AdapterRegistration`
 * du câblage des runtimes). Typé structurellement : le registre n'est pas encore dans
 * `main` ; il suffit d'ajouter `codexRegistration(config)` à `defaultRegistry()`.
 *
 * Runtime déclaré : fournisseur `openai`, connexion ChatGPT (`authMode: "chatgpt"`),
 * facturation `subscription_quota` (forfait borné par la jauge officielle, ADR-004/005).
 */

import path from "node:path";
import type { RuntimeGroup, StartRequest } from "../../contracts/index.js";
import type { BillingFacts } from "../../policy/index.js";
import { CODEX_ADAPTER_ID, CodexAdapter } from "./codex-adapter.js";
import type { CodexExecutable } from "./command.js";
import { FileThreadStore } from "./continuity.js";
import { hostLauncher, type CodexLauncher, type RunnerHostLike } from "./launch.js";

export interface CodexRegistrationConfig {
  readonly executable: CodexExecutable;
  /** `CODEX_HOME` dédié à Wake, où l'humain a fait `codex login`. */
  readonly codexHome: string;
  /** Modèle fixé par la configuration Wake, comparé à `policy.runtime.model`. */
  readonly model: string;
  readonly effort?: string;
  readonly systemPrompt: string | ((request: StartRequest) => string);
  /** Dossier des fils persistés, hors de l'espace d'exploration. */
  readonly threadsDir: string;
  /** Consentement ADR-006 lu dans la policy ; absent = mode non isolé refusé. */
  readonly hostUnattendedConsent?: CodexAdapterConsent;
  /** Lanceur des lectures de jauge hors session (`supervisorLauncher`). */
  readonly quotaLauncher?: CodexLauncher;
  /** Racines à accorder en lecture/exécution dans la sandbox ; défaut : dossier du binaire. */
  readonly runtimeRoots?: readonly string[];
}

type CodexAdapterConsent = NonNullable<
  ConstructorParameters<typeof CodexAdapter>[0]["hostUnattendedConsent"]
>;

/** Contexte offert par le daemon à la fabrique (sous-ensemble employé). */
export interface CodexFactoryContext {
  readonly host: RunnerHostLike;
  readonly workspaceDir: string;
}

export function codexRegistration(config: CodexRegistrationConfig) {
  return {
    id: CODEX_ADAPTER_ID,
    simulated: false,
    runtime: (): RuntimeGroup => ({
      adapterId: CODEX_ADAPTER_ID,
      provider: "openai",
      model: config.model,
      authMode: "chatgpt",
    }),
    billing: (): BillingFacts => ({ kind: "subscription_quota" }),
    runtimeRoots: (): readonly string[] =>
      config.runtimeRoots ?? [path.dirname(config.executable.path)],
    create: (context: CodexFactoryContext): CodexAdapter =>
      new CodexAdapter({
        executable: config.executable,
        codexHome: config.codexHome,
        workspaceDir: context.workspaceDir,
        launcher: hostLauncher(context.host),
        threads: new FileThreadStore(config.threadsDir),
        systemPrompt: config.systemPrompt,
        model: config.model,
        ...(config.effort === undefined ? {} : { effort: config.effort }),
        ...(config.hostUnattendedConsent === undefined
          ? {}
          : { hostUnattendedConsent: config.hostUnattendedConsent }),
        ...(config.quotaLauncher === undefined ? {} : { quotaLauncher: config.quotaLauncher }),
      }),
  };
}
