/**
 * Adapter Claude Code (ADR-005) : `claude -p` en `stream-json`, conforme à `RuntimeAdapter`.
 *
 * - Lancement uniquement par un `ClaudeLauncher` (sandbox AppContainer ou Job Object du
 *   runner) ; en mode autonome, refus explicite hors sandbox à autotest réussi, et
 *   `--dangerously-skip-permissions` seulement dans ce cas.
 * - Identifiant de session fixé par le daemon (`--session-id`, puis `--resume`).
 * - Prompt système à chaque appel (`--system-prompt-file`, le CLI ne le range pas dans la
 *   session) ; fichier réécrit et changement signalé quand son empreinte change.
 * - Transport fournisseur par `ClaudeNetworkPort` (relais fournisseur, non implémenté ici).
 * - Aucun credential lu, copié ou transmis : l'authentification est celle du CLI officiel,
 *   dans un dossier de configuration dédié (`CLAUDE_CONFIG_DIR`).
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterId,
  BudgetQuantity,
  CancelResult,
  DurationMs,
  ProviderQuotaSnapshot,
  ProbeResult,
  ReconcileResult,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import {
  claudeEnvironment,
  hostProfileEnv,
  claudeRunArgs,
  claudeUsageArgs,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_TOOLS,
  userMessageLine,
  type ClaudePermissionStance,
} from "./command.js";
import {
  claudeSessionUuid,
  freshConversation,
  MemoryConversationStore,
  promptDigest,
  writePromptFile,
  type ClaudeConversationRecord,
  type ClaudeConversationStore,
} from "./conversation.js";
import type {
  ClaudeLauncher,
  ClaudeNetworkGrant,
  ClaudeNetworkPort,
  ClaudeProcess,
} from "./launch.js";
import { quotaSnapshots, type ClaudeQuotaReading } from "./quota.js";
import { errorCodeFor, parseStreamLine, type ClaudeTokenTotals } from "./stream.js";

/** Identifiant du runtime dans la policy et le registre (`RUNTIME_IDS`). */
export const CLAUDE_ADAPTER_ID = "claude" as AdapterId;

/**
 * Version minimale : `--permission-prompts` (2.1.259), `rate_limit_event` (2.1.181) et
 * `usage_report` sur `/usage` (Agent SDK 0.3.273, qui embarque Claude Code 2.1.273).
 */
export const CLAUDE_MIN_VERSION = "2.1.273";

const EXECUTION_MECHANISM =
  "CLI officiel Claude Code, mode non interactif `claude -p` en stream-json (code.claude.com/docs/en/headless)";

/** Délai de terminaison forcée, en dernier recours. */
const AFTER_RESULT_TERMINATION_MS = 1_000 as DurationMs;

/**
 * Après `result`, entrée fermée : délai laissé au CLI pour sortir de lui-même (code 0)
 * avant la terminaison forcée du job.
 */
const AFTER_RESULT_EXIT_GRACE_MS = 5_000;

export type ClaudeAutonomy =
  /**
   * Réveil planifié par le daemon : sandbox à autotest réussi, ou poste hôte avec le
   * consentement distinct au mode non isolé (ADR-006).
   */
  | "autonomous"
  /** Lancement manuel par l'humain : jamais de mode sans approbation. */
  | "supervised";

export interface ClaudeAdapterOptions {
  readonly stepsStopHook?: boolean;
  readonly onStepsResult?: (request: StartRequest, raw: string) => boolean;
  readonly launcher: ClaudeLauncher;
  /** Relais fournisseur ; obligatoire pour un lancement confiné (seule sortie réseau). */
  readonly network?: ClaudeNetworkPort;
  readonly autonomy: ClaudeAutonomy;
  /**
   * Consentement distinct de l'humain au mode sans approbation non isolé sur l'hôte
   * (ADR-006), lu dans la policy en vigueur à chaque lancement (champ
   * `hostUnsandboxedAcknowledged`). Absent ou `false` : mode autonome refusé sur l'hôte.
   */
  readonly hostUnsandboxedAcknowledged?: (sessionId?: SessionId) => boolean;
  /**
   * Lanceur des lectures de jauge hors session (`supervisorClaudeLauncher`) ; défaut :
   * `launcher`. Le runner refuse tout lancement hors de la session active.
   */
  readonly quotaLauncher?: ClaudeLauncher;
  /** Variables supplémentaires (aucun nom de secret), par exemple pour un banc de test. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * `replace` (défaut) : `--system-prompt-file` remplace le prompt de Claude Code ;
   * `append` : `--append-system-prompt-file` l'ajoute, outils et consignes du CLI conservés.
   */
  readonly systemPromptMode?: "replace" | "append";
  /** Source des variables de profil reprises sur l'hôte (tests) ; défaut `process.env`. */
  readonly hostEnvSource?: Readonly<Record<string, string | undefined>>;
  /** Chemin absolu du binaire `claude` officiel. */
  readonly executable: string;
  /** Arguments placés avant ceux de l'adapter (tests : script du faux exécutable). */
  readonly executablePrefixArgs?: readonly string[];
  /**
   * Dossier de configuration dédié, connecté par l'humain via `/login`. Absent :
   * configuration par défaut du CLI (lancement supervisé de l'humain).
   */
  readonly configDir?: string;
  /** Dossier côté contrôle où sont publiés les prompts système (lecture seule pour l'agent). */
  readonly promptDir: string;
  readonly systemPrompt: string | ((sessionId: SessionId) => string);
  /** Espace d'exploration de la session (dossier de travail du CLI). */
  readonly workspaceFor: (sessionId: SessionId) => string;
  /** Clé de conversation reprise d'un réveil à l'autre ; défaut : la session Wake. */
  readonly conversationKeyFor?: (sessionId: SessionId) => string;
  readonly conversations?: ClaudeConversationStore;
  /** Alias ou nom complet ; défaut `opus`. */
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly onTools?: (sessionId: SessionId, tools: readonly string[]) => void;
  readonly onStreamLine?: (sessionId: SessionId, line: string) => void;
  /** Configuration MCP de confiance ; ne charge pas les serveurs du workspace. */
  readonly mcpConfigFile?: string;
  readonly ownerInboxDir?: string;
  readonly maxTurns?: number;
  /**
   * Auto-compaction : si le réveil précédent de la conversation a dépassé ce nombre de
   * tokens mesurés, le réveil suivant commence par `/compact` (même conversation, contexte
   * résumé par le CLI) avant le message de réveil. Absent ou 0 : jamais.
   */
  readonly compactAboveTokens?: number;
  /**
   * Réglages choisis par l'agent (ADR-009), relus à chaque réveil : son seuil remplace
   * `compactAboveTokens`, et une nouvelle `compactRequest` demande une compaction.
   */
  readonly agentPilot?: () => {
    readonly compactAboveTokens?: number;
    readonly compactRequest?: string;
  } | null;
  readonly homeDir?: string;
  readonly gitBashPath?: string;
  /**
   * Voir `ClaudeEnvironmentOptions.disableNonessentialTraffic` ; défaut `true` pour les
   * sessions. Jamais posé pour `readQuota()`, sans quoi la jauge est absente.
   */
  readonly disableNonessentialTraffic?: boolean;
  /** Racines en lecture seule supplémentaires (Git Bash, outils déclarés). */
  readonly extraReadOnlyRoots?: readonly string[];
  /** Signal de jauge reçu en cours de session (`rate_limit_event`), pour la garde de quota. */
  readonly onQuotaSignal?: (sessionId: SessionId, signal: ClaudeQuotaSignal) => void;
  readonly now?: () => Date;
}

export interface ClaudeQuotaSignal {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAt: UtcTimestamp | null;
  readonly utilization: number | null;
  readonly creditsRequired: boolean;
  /** Fenêtre concernée et fenêtres `unifiedWindows` : observées en 2.1.308, non documentées. */
  readonly rateLimitType: string | null;
  readonly windows: readonly {
    readonly key: string;
    readonly utilization: number;
    readonly resetsAt: UtcTimestamp | null;
  }[];
}

export type ClaudeAdapterErrorCode = "isolation_required" | "transport_unavailable";

export class ClaudeAdapterError extends Error {
  constructor(
    readonly code: ClaudeAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeAdapterError";
  }
}

import { ForegroundYield } from "./foreground-yield.js";
import { readCurrentProject, projectChange } from "../../daemon/project-change.js";
import { pendingStepsRequests, observeStepsTool } from "../../daemon/steps-coordination.js";
import {
  stepsStopPrompt,
  captureProjectTransition,
  isStepsDecision,
} from "../../daemon/wake-steps.js";
import {
  ownerMessagePending,
  claimOwnerMessages,
  confirmOwnerClaim,
  releaseOwnerClaims,
} from "../../communication/owner-inbox.js";
import { ownerContent } from "../../communication/owner-content.js";

interface ClaudeSession {
  readonly request: StartRequest;
  projectStart: string | null;
  stepsStopSent: boolean;
  stepsStopComplete: boolean;
  stepsUsageComplete: boolean;
  cancelling: boolean;
  readonly deadline: StartRequest["deadline"];
  readonly foregroundYield: ForegroundYield | null;
  readonly inboxClaims: Set<string>;
  readonly process: ClaudeProcess;
  readonly claudeSessionId: string;
  readonly promptChanged: boolean;
  /** Sans approbation sur l'hôte (ADR-006) : signalé dans les événements. */
  readonly unsandboxed: boolean;
  readonly promptDigest: string;
  record: ClaudeConversationRecord;
  networkOpen: boolean;
  initSeen: boolean;
  result: { readonly tokens: ClaudeTokenTotals | null } | null;
  /** `/compact` envoyé : le message de réveil part après son résultat. */
  compacting: {
    readonly context: string;
    readonly image: StartRequest["wakeImage"];
    /** Frontière `compact_boundary` reçue : la compaction a réellement eu lieu. */
    done: boolean;
  } | null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function totalOf(tokens: ClaudeTokenTotals): number {
  return tokens.input + tokens.cachedInput + tokens.output;
}

/** Premier message d'erreur du CLI, tronqué ; le journal le masque encore avant écriture. */
function firstError(errors: readonly string[]): string {
  const first = errors[0];
  return first === undefined ? "" : ` : ${first.slice(0, 160)}`;
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = CLAUDE_ADAPTER_ID;
  readonly #options: ClaudeAdapterOptions;
  readonly #conversations: ClaudeConversationStore;
  readonly #sessions = new Map<SessionId, ClaudeSession>();
  readonly #now: () => Date;

  constructor(options: ClaudeAdapterOptions) {
    this.#options = options;
    this.#conversations = options.conversations ?? new MemoryConversationStore();
    this.#now = options.now ?? (() => new Date());
  }

  #at(): UtcTimestamp {
    return this.#now().toISOString() as UtcTimestamp;
  }

  probe(): Promise<ProbeResult> {
    const { executable } = this.#options;
    const base = {
      adapterId: CLAUDE_ADAPTER_ID,
      executionMechanism: this.#unsandboxed()
        ? `${EXECUTION_MECHANISM} — NON ISOLÉ : --dangerously-skip-permissions sur le poste hôte (ADR-006)`
        : EXECUTION_MECHANISM,
      simulated: false,
    };
    // Seule invocation hors lanceur : `--version`, sans environnement hérité ni réseau.
    const run = spawnSync(
      executable,
      [...(this.#options.executablePrefixArgs ?? []), "--version"],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: { SystemRoot: process.env["SystemRoot"] ?? "", windir: process.env["windir"] ?? "" },
      },
    );
    const version = /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1];
    if (run.error !== undefined || run.status !== 0 || version === undefined) {
      return Promise.resolve({
        ...base,
        version: "unknown",
        available: false,
        unavailableReason: `claude --version a échoué (${run.error?.message ?? `code ${String(run.status)}`})`,
      });
    }
    if (compareVersions(version, CLAUDE_MIN_VERSION) < 0) {
      return Promise.resolve({
        ...base,
        version,
        available: false,
        unavailableReason: `version ${version} antérieure au minimum ${CLAUDE_MIN_VERSION}`,
      });
    }
    return Promise.resolve({ ...base, version, available: true });
  }

  capabilities(): Promise<AdapterCapabilities> {
    const isolation = this.#options.launcher.isolation();
    return Promise.resolve({
      // `modelUsage` du résultat : comptes de l'API, toutes requêtes de l'exécution.
      tokenCounting: "exact",
      countedCategories: ["input", "cached_input", "output"],
      // Ni plafond de tokens natif (`--max-budget-usd` est une estimation en dollars qui
      // peut être dépassée), ni borne conservatrice : la borne est la garde de quota.
      tokenCapEnforcement: "provider_quota_guard",
      // `/usage` → `usage_report.rate_limits` : documenté, mais type déclaré expérimental.
      providerQuotaReading: "official",
      // SIGINT/SIGTERM n'atteignent pas un processus confiné : terminaison du job seule.
      cancellation: "forced_only",
      // Une requête déjà acceptée par l'API peut se terminer : borne non documentée.
      residualUsageBound: null,
      isolationCompatible: isolation.kind === "appcontainer" && isolation.selfTestPassed,
      userPrioritySignal: true,
      resumeModes: ["native_resume", "fresh_process_from_memory"],
    });
  }

  /** Mode autonome sur l'hôte avec consentement distinct : sans approbation, non isolé. */
  #unsandboxed(): boolean {
    return (
      this.#options.autonomy === "autonomous" &&
      this.#options.launcher.isolation().kind === "host_job" &&
      this.#options.hostUnsandboxedAcknowledged?.() === true
    );
  }

  #stance(sessionId: SessionId): ClaudePermissionStance {
    const isolation = this.#options.launcher.isolation(sessionId);
    if (this.#options.autonomy === "supervised") return "allowlist_only";
    if (isolation.kind === "host_job") {
      const consent =
        isolation.unsandboxedConsent === true ||
        this.#options.hostUnsandboxedAcknowledged?.(sessionId) === true;
      if (!consent) {
        throw new ClaudeAdapterError(
          "isolation_required",
          "lancement autonome refusé sur l'hôte : consentement distinct au mode non isolé absent de la policy (hostUnsandboxedAcknowledged, ADR-006)",
        );
      }
      return "skip_permissions_unsandboxed";
    }
    if (!isolation.selfTestPassed) {
      throw new ClaudeAdapterError(
        "isolation_required",
        `lancement autonome refusé : sandbox sans autotest réussi (${isolation.detail})`,
      );
    }
    if (this.#options.configDir === undefined) {
      throw new ClaudeAdapterError(
        "isolation_required",
        "lancement confiné refusé sans dossier de configuration dédié (CLAUDE_CONFIG_DIR)",
      );
    }
    return "skip_permissions_in_sandbox";
  }

  async #openNetwork(
    launcher: ClaudeLauncher,
    sessionId: SessionId,
  ): Promise<ClaudeNetworkGrant | null> {
    const isolation = launcher.isolation(sessionId);
    if (this.#options.network === undefined) {
      if (isolation.kind === "appcontainer") {
        throw new ClaudeAdapterError(
          "transport_unavailable",
          "aucun relais fournisseur : la sandbox n'a pas d'autre sortie réseau",
        );
      }
      return null;
    }
    return this.#options.network.open(sessionId);
  }

  async #closeNetwork(sessionId: SessionId): Promise<void> {
    try {
      await this.#options.network?.close(sessionId);
    } catch {
      // La fermeture du canal ne doit pas masquer la fin de session.
    }
  }

  #launch(
    launcher: ClaudeLauncher,
    sessionId: SessionId,
    args: readonly string[],
    grant: ClaudeNetworkGrant | null,
    cwd: string,
    deadline: UtcTimestamp | null,
    mode: {
      readonly quotaRead: boolean;
      readonly unattended: boolean;
      readonly nativeCapabilities?: boolean;
    },
  ): ClaudeProcess {
    const o = this.#options;
    const quotaRead = mode.quotaRead;
    // Mesuré avec 2.1.308 : sous `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `/usage` rend
    // `rate_limits: null` ; sans elle, la jauge revient. La lecture de jauge ne la pose donc pas.
    const disableNonessentialTraffic =
      quotaRead || mode.nativeCapabilities === true ? false : o.disableNonessentialTraffic;
    const host = launcher.isolation(sessionId).kind === "host_job";
    const env = claudeEnvironment({
      ...(host ? { inherited: hostProfileEnv(o.hostEnvSource) } : {}),
      ...(o.configDir === undefined ? {} : { configDir: o.configDir }),
      ...(o.homeDir === undefined ? {} : { homeDir: o.homeDir }),
      ...(o.gitBashPath === undefined ? {} : { gitBashPath: o.gitBashPath }),
      ...(disableNonessentialTraffic === undefined ? {} : { disableNonessentialTraffic }),
      ...(grant === null ? {} : { network: grant.env }),
      ...(mode.nativeCapabilities === true || o.extraEnv !== undefined
        ? {
            extra: {
              ...(o.extraEnv ?? {}),
              ...(mode.nativeCapabilities === true ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : {}),
            },
          }
        : {}),
    });
    return launcher.launch({
      sessionId,
      executable: o.executable,
      args: [...(o.executablePrefixArgs ?? []), ...args],
      cwd,
      env: { ...env, MIND_WAKE_SESSION: sessionId },
      readWriteRoots: [
        cwd,
        ...(o.configDir === undefined ? [] : [o.configDir]),
        ...(o.homeDir === undefined ? [] : [o.homeDir]),
      ],
      readOnlyRoots: [path.dirname(o.executable), o.promptDir, ...(o.extraReadOnlyRoots ?? [])],
      network: grant,
      deadline,
      unattended: mode.unattended,
    });
  }

  async start(request: StartRequest): Promise<SessionHandle> {
    const o = this.#options;
    const sessionId = request.sessionId;
    const permission = this.#stance(sessionId);
    const nativeCapabilities =
      request.policy.groups?.runtime?.nativeCapabilities === true &&
      permission === "skip_permissions_unsandboxed";
    const key = o.conversationKeyFor?.(sessionId) ?? sessionId;
    let record = this.#conversations.get(key) ?? freshConversation(key);
    const basePrompt =
      typeof o.systemPrompt === "function" ? o.systemPrompt(sessionId) : o.systemPrompt;
    const prompt =
      request.systemContext === undefined
        ? basePrompt
        : `${basePrompt}\n\n${request.systemContext}`;
    const digest = promptDigest(prompt);
    const promptFile = writePromptFile(o.promptDir, prompt, digest);
    const claudeSessionId = claudeSessionUuid(key, record.generation);
    const args = claudeRunArgs({
      model: o.model ?? DEFAULT_CLAUDE_MODEL,
      systemPromptFile: promptFile,
      systemPromptMode: o.systemPromptMode ?? "replace",
      tools: o.tools ?? DEFAULT_CLAUDE_TOOLS,
      nativeCapabilities,
      ...(o.ownerInboxDir !== undefined && permission === "skip_permissions_unsandboxed"
        ? {
            ownerInboxHook: {
              dataDir: o.ownerInboxDir,
              node: process.execPath,
              script: fileURLToPath(
                new URL("../../communication/owner-inbox-hook.js", import.meta.url),
              ),
            },
          }
        : {}),
      ...(o.mcpConfigFile === undefined ? {} : { mcpConfigFile: o.mcpConfigFile }),
      permission,
      session: { mode: record.started ? "resume" : "new", id: claudeSessionId },
      ...(o.maxTurns === undefined ? {} : { maxTurns: o.maxTurns }),
    });

    const grant = await this.#openNetwork(o.launcher, sessionId);
    let process_: ClaudeProcess;
    try {
      process_ = this.#launch(
        o.launcher,
        sessionId,
        args,
        grant,
        o.workspaceFor(sessionId),
        request.deadline,
        { quotaRead: false, unattended: permission !== "allowlist_only", nativeCapabilities },
      );
      await process_.started();
    } catch (error) {
      if (grant !== null) await this.#closeNetwork(sessionId);
      throw error;
    }
    // L'entrée reste ouverte (le lanceur la tient) : le message passe en `stream-json`.
    // Auto-compaction : la reprise d'une conversation trop lourde commence par `/compact`.
    const pilot = o.agentPilot?.() ?? null;
    const threshold = pilot?.compactAboveTokens ?? o.compactAboveTokens ?? 0;
    const requested =
      pilot?.compactRequest !== undefined && pilot.compactRequest !== record.lastCompactRequest;
    const compact =
      record.started && (requested || (threshold > 0 && (record.lastWakeTokens ?? 0) > threshold));
    if (compact && requested && pilot.compactRequest !== undefined) {
      // Demande servie une seule fois, même si le réveil échoue ensuite.
      record = { ...record, lastCompactRequest: pilot.compactRequest };
      this.#conversations.put(record);
    }
    const projectStart = readCurrentProject(o.workspaceFor(sessionId));
    process_.send(
      compact ? userMessageLine("/compact") : userMessageLine(request.context, request.wakeImage),
    );
    const inboxDir = o.ownerInboxDir;
    const inboxClaims = new Set<string>();
    if (inboxDir !== undefined) releaseOwnerClaims(inboxDir);
    const foregroundYield =
      inboxDir !== undefined && permission === "skip_permissions_unsandboxed"
        ? new ForegroundYield(
            () => ownerMessagePending(inboxDir),
            (line) => process_.send(line),
            () => {
              if (process_.hasExited) return false;
              const claim = randomUUID();
              const messages = claimOwnerMessages(inboxDir, claudeSessionId, claim);
              if (!messages.length) return false;
              try {
                inboxClaims.add(claim);
                const frame = JSON.parse(userMessageLine("")) as Record<string, unknown>;
                (frame["message"] as Record<string, unknown>)["content"] = ownerContent(
                  messages,
                  "claude",
                );
                frame["uuid"] = claim;
                const active = this.#sessions.get(sessionId);
                if (active) active.projectStart = readCurrentProject(o.workspaceFor(sessionId));
                process_.send(JSON.stringify(frame));
              } catch (error) {
                inboxClaims.delete(claim);
                releaseOwnerClaims(inboxDir, claudeSessionId);
                throw error;
              }
              return true;
            },
          )
        : null;
    foregroundYield?.start();
    void process_.exited
      .then(() => {
        foregroundYield?.stop();
        if (inboxDir !== undefined) releaseOwnerClaims(inboxDir, claudeSessionId);
      })
      .catch(() => undefined);
    this.#sessions.set(sessionId, {
      request,
      projectStart,
      stepsStopSent: false,
      stepsStopComplete: false,
      stepsUsageComplete: true,
      cancelling: false,
      deadline: request.deadline,
      foregroundYield,
      inboxClaims,
      process: process_,
      claudeSessionId,
      promptChanged: record.promptDigest !== null && record.promptDigest !== digest,
      unsandboxed: permission === "skip_permissions_unsandboxed",
      promptDigest: digest,
      record,
      networkOpen: grant !== null,
      initSeen: false,
      result: null,
      compacting: compact
        ? { context: request.context, image: request.wakeImage, done: false }
        : null,
    });
    return { adapterId: CLAUDE_ADAPTER_ID, sessionId, startedAt: this.#at() };
  }

  #save(session: ClaudeSession, record: ClaudeConversationRecord): void {
    session.record = record;
    this.#conversations.put(record);
  }

  /** Échec avant `system/init` : la conversation n'existe pas, la suivante repart à neuf. */
  #abandonConversation(session: ClaudeSession): void {
    if (session.initSeen) return;
    this.#save(session, freshConversation(session.record.key, session.record.generation + 1));
  }

  async #finish(sessionId: SessionId, session: ClaudeSession): Promise<void> {
    session.foregroundYield?.stop();
    // Fin de conversation : entrée fermée, le CLI sort de lui-même ; sinon terminaison.
    if (!session.process.hasExited && session.process.closeInput !== undefined) {
      session.process.closeInput();
      await Promise.race([
        session.process.exited,
        new Promise((resolve) => setTimeout(resolve, AFTER_RESULT_EXIT_GRACE_MS).unref()),
      ]);
    }
    if (!session.process.hasExited)
      await session.process.terminateTree(AFTER_RESULT_TERMINATION_MS);
    if (session.networkOpen) {
      session.networkOpen = false;
      await this.#closeNetwork(sessionId);
    }
  }

  async *events(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    const sessionId = handle.sessionId;
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    let resetsAtMs: number | null = null;
    let rateLimited = false;
    let errorEmitted = false;

    if (session.unsandboxed) {
      yield {
        type: "activity",
        sessionId,
        at: this.#at(),
        summary:
          "mode NON ISOLÉ : --dangerously-skip-permissions sur le poste hôte, consentement distinct (ADR-006)",
      };
    }
    if (session.promptChanged) {
      yield {
        type: "activity",
        sessionId,
        at: this.#at(),
        summary: `prompt système modifié (empreinte ${session.promptDigest.slice(0, 12)}), réinjecté`,
      };
    }

    for (;;) {
      const line = await session.process.readLine();
      const at = this.#at();
      if (line === null) {
        const exit = await session.process.exited;
        if (session.stepsStopSent) {
          yield {
            type: "activity",
            sessionId,
            at,
            summary: "ÉTAPES : flux du bilan interrompu ; usage du bilan inconnu",
          };
          await this.#finish(sessionId, session);
          yield { type: "ended", sessionId, at: this.#at(), exitReason: "result:success" };
          return;
        }
        this.#abandonConversation(session);
        yield {
          type: "error",
          sessionId,
          at,
          code: "transient",
          message: `flux stream-json interrompu sans résultat (code ${String(exit.mainExitCode)})`,
        };
        await this.#finish(sessionId, session);
        yield { type: "ended", sessionId, at: this.#at(), exitReason: "stream_cut" };
        return;
      }
      session.foregroundYield?.observe(line);
      {
        try {
          for (const r of pendingStepsRequests(this.#options.workspaceFor(sessionId)))
            observeStepsTool(
              this.#options.workspaceFor(sessionId),
              r.requestId,
              "claude",
              JSON.parse(line),
              this.#options.ownerInboxDir,
            );
        } catch {
          /* evidence unavailable, never accept a fabricated proposal */
        }
      }
      if (this.#options.ownerInboxDir !== undefined && session.inboxClaims.size) {
        try {
          const echo = JSON.parse(line) as {
            type?: string;
            isReplay?: boolean;
            uuid?: string;
            session_id?: string;
          };
          if (
            echo.type === "user" &&
            echo.isReplay === true &&
            echo.session_id === session.claudeSessionId &&
            typeof echo.uuid === "string" &&
            session.inboxClaims.has(echo.uuid)
          ) {
            confirmOwnerClaim(this.#options.ownerInboxDir, session.claudeSessionId, echo.uuid);
            session.inboxClaims.delete(echo.uuid);
          }
        } catch {
          /* A malformed echo never acknowledges a message. */
        }
      }
      for (const summary of session.foregroundYield?.notices.splice(0) ?? [])
        yield { type: "activity", sessionId, at: this.#at(), summary };
      try {
        this.#options.onStreamLine?.(sessionId, line);
      } catch {
        /* Observability must not interrupt work. */
      }
      try {
        const frame = JSON.parse(line) as {
          type?: string;
          message?: { content?: { type?: string; text?: string }[] };
        };
        if (
          frame.type === "assistant" &&
          isStepsDecision(
            frame.message?.content
              ?.filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("") ?? "",
          )
        )
          continue;
      } catch {
        /* ordinary parser handles malformed frames */
      }
      const item = parseStreamLine(line);
      switch (item.kind) {
        case "init":
          if (session.initSeen) break;
          session.initSeen = true;
          try {
            this.#options.onTools?.(sessionId, item.tools);
          } catch {
            /* tool inventory must not interrupt work */
          }
          this.#save(session, {
            ...session.record,
            started: true,
            promptDigest: session.promptDigest,
          });
          yield { type: "started", sessionId, at };
          if (item.tools.length > 0)
            yield {
              type: "activity",
              sessionId,
              at,
              summary: "Outils exposés par Claude : " + item.tools.join(", "),
            };
          if (item.sessionId !== session.claudeSessionId) {
            yield {
              type: "activity",
              sessionId,
              at,
              summary: "identifiant de session Claude différent de celui fixé par le daemon",
            };
          }
          break;
        case "activity":
          yield { type: "activity", sessionId, at, summary: item.summary };
          break;
        case "compacted":
          if (session.compacting !== null) session.compacting.done = true;
          yield {
            type: "activity",
            sessionId,
            at,
            summary: `conversation compactée : ${String(item.preTokens ?? "?")} → ${String(item.postTokens ?? "?")} tokens de contexte`,
          };
          break;
        case "permission_denied":
          yield { type: "activity", sessionId, at, summary: `outil refusé : ${item.tool}` };
          break;
        case "api_retry":
          yield {
            type: "activity",
            sessionId,
            at,
            summary: `nouvelle tentative API ${String(item.attempt)} (${item.error}, ${String(item.delayMs)} ms)`,
          };
          break;
        case "rate_limit": {
          if (item.resetsAtMs !== null) resetsAtMs = item.resetsAtMs;
          try {
            this.#options.onQuotaSignal?.(sessionId, {
              status: item.status,
              resetsAt:
                item.resetsAtMs === null
                  ? null
                  : (new Date(item.resetsAtMs).toISOString() as UtcTimestamp),
              utilization: item.utilization,
              creditsRequired: item.creditsRequired,
              rateLimitType: item.rateLimitType,
              windows: item.windows.map((w) => ({
                key: w.key,
                utilization: w.utilization,
                resetsAt:
                  w.resetsAtMs === null
                    ? null
                    : (new Date(w.resetsAtMs).toISOString() as UtcTimestamp),
              })),
            });
          } catch {
            // Un consommateur défaillant ne doit pas interrompre le flux d'événements.
          }
          if (item.status === "rejected" && !rateLimited) {
            rateLimited = true;
            yield {
              type: "rate_limited",
              sessionId,
              at,
              retryAfterMs: this.#retryAfter(resetsAtMs),
            };
          } else if (item.status === "allowed_warning") {
            yield { type: "activity", sessionId, at, summary: "avertissement de limite d'usage" };
          }
          break;
        }
        case "assistant_error":
          if (item.error === "rate_limit") {
            if (!rateLimited) {
              rateLimited = true;
              yield {
                type: "rate_limited",
                sessionId,
                at,
                retryAfterMs: this.#retryAfter(resetsAtMs),
              };
            }
          } else if (!errorEmitted && !session.stepsStopSent) {
            errorEmitted = true;
            yield {
              type: "error",
              sessionId,
              at,
              code: errorCodeFor(item.error),
              message: `erreur API ${item.error}`,
            };
          }
          break;
        case "result": {
          if (session.compacting !== null) {
            // Résultat de `/compact` : le réveil continue dans la même conversation.
            const { context, image, done } = session.compacting;
            session.compacting = null;
            if (!done) {
              yield {
                type: "activity",
                sessionId,
                at,
                summary:
                  "auto-compaction sans effet (aucune frontière de compaction) : réveil sur le contexte complet",
              };
            }
            session.projectStart = readCurrentProject(this.#options.workspaceFor(sessionId));
            session.process.send(userMessageLine(context, image));
            break;
          }
          const previousTotals = session.result?.tokens;
          const isStepsResult = session.stepsStopSent && !session.stepsStopComplete;
          if (isStepsResult) session.stepsStopComplete = true;
          if (
            isStepsResult &&
            (item.tokens === null ||
              (previousTotals != null &&
                (item.tokens.input < previousTotals.input ||
                  item.tokens.cachedInput < previousTotals.cachedInput ||
                  item.tokens.output < previousTotals.output)))
          )
            session.stepsUsageComplete = false;
          session.result = { tokens: item.tokens };
          if (item.tokens !== null) {
            this.#save(session, { ...session.record, lastWakeTokens: totalOf(item.tokens) });
          }
          if (item.tokens !== null) {
            // Mesuré avec 2.1.308 : après `--resume`, `modelUsage` ne couvre que cet appel.
            // modelUsage is cumulative within one live CLI process. Several turns
            // may now occur while background work runs: emit only the new usage.
            const tokens = {
              input: Math.max(0, item.tokens.input - (previousTotals?.input ?? 0)),
              cachedInput: Math.max(
                0,
                item.tokens.cachedInput - (previousTotals?.cachedInput ?? 0),
              ),
              output: Math.max(0, item.tokens.output - (previousTotals?.output ?? 0)),
            };
            yield {
              type: "usage",
              sessionId,
              at,
              quantity: { unit: "tokens", amount: totalOf(tokens) },
              provenance: "measured",
              tokenBreakdown: {
                input: tokens.input,
                cached_input: tokens.cachedInput,
                output: tokens.output,
              },
            };
          }
          if (isStepsResult && item.isError && item.apiErrorStatus === 429 && !rateLimited) {
            rateLimited = true;
            yield {
              type: "rate_limited",
              sessionId,
              at,
              retryAfterMs: this.#retryAfter(resetsAtMs),
            };
          }
          if (
            item.isError &&
            !rateLimited &&
            !errorEmitted &&
            item.subtype !== "error_max_turns" &&
            !isStepsResult
          ) {
            this.#abandonConversation(session);
            if (item.apiErrorStatus === 429) {
              yield {
                type: "rate_limited",
                sessionId,
                at,
                retryAfterMs: this.#retryAfter(resetsAtMs),
              };
            } else {
              const auth = item.apiErrorStatus === 401 || item.apiErrorStatus === 403;
              yield {
                type: "error",
                sessionId,
                at,
                code: auth ? "auth_failed" : "transient",
                message: `résultat en erreur (${item.subtype})${firstError(item.errors)}`,
              };
            }
          }
          const change = projectChange(
            session.projectStart,
            readCurrentProject(this.#options.workspaceFor(sessionId)),
          );
          const transition =
            change &&
            !session.stepsStopSent &&
            !item.isError &&
            this.#options.stepsStopHook === true
              ? captureProjectTransition(
                  this.#options.workspaceFor(sessionId),
                  this.#options.ownerInboxDir ??
                    path.dirname(this.#options.workspaceFor(sessionId)),
                  change,
                  sessionId,
                )
              : null;
          if (
            !session.stepsStopSent &&
            !item.isError &&
            session.foregroundYield &&
            (session.foregroundYield.hasWork ||
              session.inboxClaims.size > 0 ||
              (this.#options.ownerInboxDir !== undefined &&
                ownerMessagePending(this.#options.ownerInboxDir)))
          ) {
            session.foregroundYield.markIdle();
            yield {
              type: "activity",
              sessionId,
              at: this.#at(),
              summary:
                "Tour terminé ; le runtime reste ouvert pour les tâches en cours et les messages humains.",
            };
            break;
          }
          if (
            !session.stepsStopSent &&
            !item.isError &&
            !session.cancelling &&
            !(
              this.#options.ownerInboxDir !== undefined &&
              ownerMessagePending(this.#options.ownerInboxDir)
            )
          ) {
            try {
              const raw = (JSON.parse(line) as { result?: unknown }).result;
              if (typeof raw === "string" && isStepsDecision(raw))
                this.#options.onStepsResult?.(session.request, raw);
            } catch {
              /* ordinary work is independent */
            }
          }
          if (
            transition !== null &&
            change !== null &&
            this.#options.stepsStopHook === true &&
            !session.stepsStopSent &&
            !item.isError &&
            !rateLimited &&
            !errorEmitted &&
            !session.cancelling &&
            !session.process.hasExited &&
            (session.deadline === null || this.#now().getTime() < Date.parse(session.deadline)) &&
            !(
              this.#options.ownerInboxDir !== undefined &&
              ownerMessagePending(this.#options.ownerInboxDir)
            )
          ) {
            session.stepsStopSent = true;
            // No human claim/delivery into the JSON-only turn. Pending text stays queued.
            session.foregroundYield?.stop();
            try {
              session.process.send(
                userMessageLine(
                  stepsStopPrompt(
                    this.#options.workspaceFor(sessionId),
                    change,
                    sessionId,
                    this.#options.ownerInboxDir,
                  ),
                ),
              );
            } catch {
              yield {
                type: "activity",
                sessionId,
                at: this.#at(),
                summary:
                  "ÉTAPES : bilan non transmis ; travail précédent terminé, usage à rapprocher",
              };
              await this.#finish(sessionId, session);
              yield { type: "ended", sessionId, at: this.#at(), exitReason: "result:success" };
              return;
            }
            yield {
              type: "activity",
              sessionId,
              at: this.#at(),
              summary: "ÉTAPES : bilan de fin de réponse (un passage)",
            };
            break;
          }
          const humanPending =
            this.#options.ownerInboxDir !== undefined &&
            ownerMessagePending(this.#options.ownerInboxDir);
          if (isStepsResult && !item.isError && !session.cancelling && !humanPending) {
            let saved = false;
            try {
              const raw = (JSON.parse(line) as { result?: unknown }).result;
              if (typeof raw === "string")
                saved = this.#options.onStepsResult?.(session.request, raw) === true;
            } catch {
              /* report without losing measured usage */
            }
            yield {
              type: "activity",
              sessionId,
              at: this.#at(),
              summary: saved
                ? "ÉTAPES : bilan sauvegardé et publié dans le fil"
                : "ÉTAPES : bilan incomplet (vérifier réponse, fichier et fil)",
            };
          }
          if (isStepsResult && humanPending)
            yield {
              type: "activity",
              sessionId,
              at: this.#at(),
              summary: "ÉTAPES : bilan non publié ; message humain en attente prioritaire",
            };
          if (isStepsResult && item.isError)
            yield {
              type: "activity",
              sessionId,
              at: this.#at(),
              summary: "ÉTAPES : résultat de bilan en erreur ; travail précédent terminé",
            };
          await this.#finish(sessionId, session);
          const reason = isStepsResult ? "success" : (item.terminalReason ?? item.subtype);
          yield { type: "ended", sessionId, at: this.#at(), exitReason: `result:${reason}` };
          return;
        }
        case "usage_report":
        case "ignored":
        case "malformed":
          break;
      }
    }
  }

  #retryAfter(resetsAtMs: number | null): DurationMs | null {
    if (resetsAtMs === null) return null;
    return Math.max(0, Math.ceil(resetsAtMs - this.#now().getTime()));
  }

  async cancel(handle: SessionHandle, timeoutMs: DurationMs): Promise<CancelResult> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return { status: "unconfirmed", detail: "session inconnue" };
    session.cancelling = true;
    session.foregroundYield?.stop();
    const result = await session.process.terminateTree(timeoutMs);
    if (session.networkOpen) {
      session.networkOpen = false;
      await this.#closeNetwork(handle.sessionId);
    }
    return result.confirmed
      ? { status: "forced", within: Math.ceil(result.elapsedMs) }
      : { status: "unconfirmed", detail: result.detail ?? "terminaison non confirmée" };
  }

  /**
   * Usage confirmé seulement si le résultat final a été lu et le processus est terminé.
   * Flux coupé, annulation ou redémarrage du daemon : la consommation reste incertaine.
   */
  reconcile(sessionId: SessionId): Promise<ReconcileResult> {
    const session = this.#sessions.get(sessionId);
    if (session?.stepsStopSent && (!session.stepsStopComplete || !session.stepsUsageComplete))
      return Promise.resolve({
        status: "uncertain",
        detail: "bilan ÉTAPES commencé sans résultat final : usage du bilan inconnu",
      });
    if (session === undefined) {
      return Promise.resolve({ status: "uncertain", detail: "session inconnue de cette instance" });
    }
    if (!session.process.hasExited) {
      return Promise.resolve({ status: "uncertain", detail: "processus encore actif" });
    }
    if (session.result === null) {
      return Promise.resolve({
        status: "uncertain",
        detail: "aucun résultat final : usage inconnu",
      });
    }
    const usage: BudgetQuantity[] =
      session.result.tokens === null
        ? []
        : [{ unit: "tokens", amount: totalOf(session.result.tokens) }];
    if (usage.length === 0) {
      return Promise.resolve({ status: "uncertain", detail: "résultat sans comptage de tokens" });
    }
    return Promise.resolve({ status: "confirmed", ended: true, usage, provenance: "measured" });
  }

  #lastQuota: readonly ProviderQuotaSnapshot[] = [];

  /**
   * Une lecture échouée rend la dernière lecture réussie, avec son `observedAt` : la
   * policy la refuse dès qu'elle dépasse `maxSnapshotAgeMs`. Évite qu'un `/usage`
   * concurrent ou lent interrompe une session pour une jauge qui était lisible.
   */
  async readQuota(): Promise<readonly ProviderQuotaSnapshot[]> {
    try {
      const { snapshots } = await this.readQuotaReading();
      if (snapshots.length > 0) this.#lastQuota = snapshots;
      return snapshots.length > 0 ? snapshots : this.#lastQuota;
    } catch {
      return this.#lastQuota;
    }
  }

  /**
   * Lecture officielle de la jauge (`/usage`) avec son diagnostic, par `quotaLauncher`.
   * Aucune requête au modèle ; aucun outil ; aucune session conservée.
   */
  async readQuotaReading(timeoutMs = 30_000): Promise<ClaudeQuotaReading> {
    const launcher = this.#options.quotaLauncher ?? this.#options.launcher;
    const sessionId = `claude-quota-${randomBytes(6).toString("hex")}` as SessionId;
    const deadline = new Date(this.#now().getTime() + timeoutMs).toISOString() as UtcTimestamp;
    // Dossier de travail de la lecture : celui des prompts, côté contrôle (il doit exister).
    fs.mkdirSync(this.#options.promptDir, { recursive: true });
    const grant = await this.#openNetwork(launcher, sessionId);
    let process_: ClaudeProcess | null = null;
    try {
      process_ = this.#launch(
        launcher,
        sessionId,
        claudeUsageArgs(),
        grant,
        this.#options.promptDir,
        deadline,
        { quotaRead: true, unattended: false },
      );
      await process_.started();
      process_.send(userMessageLine("/usage"));
      const reading = await Promise.race([
        this.#awaitUsageReport(process_),
        new Promise<ClaudeQuotaReading>((resolve) =>
          setTimeout(() => {
            resolve({ snapshots: [], unmapped: [], unavailable: "délai de lecture dépassé" });
          }, timeoutMs).unref(),
        ),
      ]);
      return reading;
    } finally {
      if (process_ !== null && !process_.hasExited)
        await process_.terminateTree(AFTER_RESULT_TERMINATION_MS);
      if (grant !== null) await this.#closeNetwork(sessionId);
    }
  }

  async #awaitUsageReport(process_: ClaudeProcess): Promise<ClaudeQuotaReading> {
    for (;;) {
      const line = await process_.readLine();
      if (line === null) return { snapshots: [], unmapped: [], unavailable: "flux interrompu" };
      const item = parseStreamLine(line);
      if (item.kind === "usage_report") {
        if (item.limits === null) {
          return { snapshots: [], unmapped: [], unavailable: "rate_limits absent du rapport" };
        }
        return quotaSnapshots(item.limits, this.#at());
      }
      if (item.kind === "assistant_error") {
        return { snapshots: [], unmapped: [], unavailable: `erreur API ${item.error}` };
      }
      if (item.kind === "result") {
        // Connexion par clé API, jeton sans portée `user:profile` ou version trop ancienne.
        return { snapshots: [], unmapped: [], unavailable: "aucun usage_report dans la réponse" };
      }
    }
  }
}
