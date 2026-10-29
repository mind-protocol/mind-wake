/**
 * Adapter Gemini CLI (ADR-005, ADR-006), conforme à `RuntimeAdapter`. Il lance la CLI
 * officielle en mode non interactif (`--prompt`, `--output-format stream-json`) dans
 * l'espace d'exploration, avec une configuration propre à Wake (`GEMINI_CLI_HOME`) et un
 * environnement explicite sans secret hérité, toujours dans un Job Object pour que l'arrêt
 * d'urgence termine toute l'arborescence.
 *
 * Deux lancements : dans la sandbox AppContainer (réseau par le relais, suspendu), ou sur
 * le poste hôte, NON ISOLÉ, avec le réseau de l'hôte (ADR-006). Sur l'hôte, `--approval-mode
 * yolo` et l'autonomie exigent le consentement distinct `hostUnsandboxedAcknowledged`.
 *
 * Aucune lecture officielle du quota restant n'existe pour Gemini CLI : le runtime est
 * refusé en mode autonome (`providerQuotaReading: "none"`) et reste réservé au lancement
 * manuel par l'humain.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterId,
  CancelResult,
  DurationMs,
  PolicyRevision,
  ProbeResult,
  ReconcileResult,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import {
  buildArgs,
  DEFAULT_EXCLUDED_TOOLS,
  GEMINI_SESSION_ID,
  writeHomeConfiguration,
  type ApprovalMode,
} from "./config.js";
import {
  decideLaunch,
  GeminiLaunchRefused,
  type GeminiLaunchPort,
  type GeminiProcess,
  type LaunchIsolation,
  type LaunchMode,
  type ProviderTransportLease,
  type ProviderTransportPort,
} from "./launch.js";
import {
  classifyError,
  classifyExitCode,
  GEMINI_EXIT_CODES,
  parseStreamLine,
  tokenBreakdown,
  type GeminiStreamStats,
} from "./protocol.js";

export const GEMINI_ADAPTER_ID = "gemini" as AdapterId;
/** Version de la CLI installée lors de la vérification de la documentation. */
export const GEMINI_CLI_VERIFIED_VERSION = "0.52.0";
export const GEMINI_EXECUTION_MECHANISM =
  "Gemini CLI non interactif (--prompt, --output-format stream-json), GEMINI_CLI_HOME propre à Wake";

const DEFAULT_MAX_SESSION_TURNS = 50;
const SUMMARY_CHARS = 160;
const VERSION_TIMEOUT_MS = 15_000;

export interface GeminiCommand {
  /** Exécutable lancé : `node.exe` (copie confinée) ou un binaire autonome. */
  readonly executable: string;
  /** Arguments placés avant ceux de la CLI, par exemple le script d'entrée du paquet. */
  readonly prefixArgs?: readonly string[];
}

export interface GeminiAdapterOptions {
  readonly command: GeminiCommand;
  readonly launch: GeminiLaunchPort;
  /** Canal du relais fournisseur, sandbox seulement ; ignoré sur l'hôte (ADR-006). */
  readonly transport?: ProviderTransportPort;
  readonly mode: LaunchMode;
  /**
   * `yolo` exige la sandbox vérifiée, ou sur l'hôte le consentement au mode non isolé.
   * Défaut : `default`.
   */
  readonly approvalMode?: ApprovalMode;
  /**
   * Lecture du consentement distinct au mode non isolé dans la policy
   * (`hostUnsandboxedAcknowledged`, ADR-006). Absent = pas de consentement.
   */
  readonly hostUnsandboxedAcknowledged?: (policy: PolicyRevision) => boolean;
  /** Modèle ; défaut : `policy.groups.runtime.model`. */
  readonly model?: string;
  /** Espace d'exploration de la session (doit exister). */
  readonly workspaceFor: (sessionId: SessionId) => string;
  /** `GEMINI_CLI_HOME` : configuration et historique de la CLI, accessible à l'agent. */
  readonly homeDir: string;
  /** État de l'adapter (index des sessions), hors de toute racine accordée à l'agent. */
  readonly stateDir: string;
  readonly maxSessionTurns?: number;
  /** Liste blanche des outils intégrés (`tools.core`). */
  readonly coreTools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly maxProcesses?: number;
  /**
   * Reprise native (`--resume <id>`) depuis la session Wake indiquée. Non vérifiée avec
   * `--prompt` dans la documentation : désactivée tant que ce callback est absent.
   */
  readonly resumeFrom?: (sessionId: SessionId) => SessionId | null;
  /** Lecture de la version (`--version`) ; injectable pour les tests. */
  readonly readVersion?: () => Promise<string>;
}

/** Trace persistée d'une session, écrite par l'adapter seul. */
interface SessionRecord {
  geminiSessionId: string | null;
  stats: GeminiStreamStats | null;
  ended: boolean;
  exitCode: number | null;
}

interface LiveSession {
  readonly process: GeminiProcess;
  readonly isolation: LaunchIsolation;
  readonly lease: ProviderTransportLease | null;
  readonly record: SessionRecord;
  cancelled: boolean;
  consumed: boolean;
}

function nowUtc(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

function summary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class GeminiAdapter implements RuntimeAdapter {
  readonly id = GEMINI_ADAPTER_ID;
  readonly #options: GeminiAdapterOptions;
  readonly #sessions = new Map<SessionId, LiveSession>();

  constructor(options: GeminiAdapterOptions) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    const base = {
      adapterId: GEMINI_ADAPTER_ID,
      executionMechanism: `${GEMINI_EXECUTION_MECHANISM} — ${
        this.#options.launch.kind === "host"
          ? "NON ISOLÉ : poste hôte, Job Object seul (ADR-006)"
          : "sandbox AppContainer + Job Object"
      }`,
      simulated: false,
    };
    try {
      const output = await (this.#options.readVersion ?? (() => this.#readVersion()))();
      const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
      if (version === undefined) {
        return {
          ...base,
          version: "inconnue",
          available: false,
          unavailableReason: "version illisible",
        };
      }
      return { ...base, version, available: true };
    } catch (error) {
      return {
        ...base,
        version: "inconnue",
        available: false,
        unavailableReason: `gemini --version : ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  capabilities(): Promise<AdapterCapabilities> {
    return Promise.resolve({
      // `result.stats` en fin de session : mesure officielle de la CLI, absente si coupée.
      tokenCounting: "exact",
      countedCategories: ["input", "cached_input", "output", "unexposed"],
      // Ni plafond de tokens, ni lecture de quota : aucune borne imposable.
      tokenCapEnforcement: "none",
      providerQuotaReading: "none",
      // Pas d'annulation coopérative documentée en mode non interactif : arrêt du job.
      cancellation: "forced_only",
      residualUsageBound: null,
      // Gemini CLI n'a encore jamais tourné dans l'AppContainer : non démontré.
      isolationCompatible: false,
      userPrioritySignal: false,
      resumeModes:
        this.#options.resumeFrom === undefined
          ? ["fresh_process_from_memory"]
          : ["fresh_process_from_memory", "native_resume"],
    });
  }

  async start(request: StartRequest): Promise<SessionHandle> {
    const options = this.#options;
    if (this.#sessions.has(request.sessionId)) {
      throw new Error(`session déjà lancée : ${request.sessionId}`);
    }
    const decision = decideLaunch({
      mode: options.mode,
      approvalMode: options.approvalMode ?? "default",
      portKind: options.launch.kind,
      isolation: await options.launch.isolationVerified(),
      hostUnsandboxedConsent: options.hostUnsandboxedAcknowledged?.(request.policy) === true,
      providerQuotaReading: "none",
    });
    if (!decision.allowed) throw new GeminiLaunchRefused(decision.refusal, decision.reason);

    const workspace = path.resolve(options.workspaceFor(request.sessionId));
    const home = path.resolve(options.homeDir);
    const stateDir = path.resolve(options.stateDir);
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`espace d'exploration absent : ${workspace}`);
    }
    if (isWithin(workspace, stateDir) || isWithin(home, stateDir)) {
      throw new Error("l'état de l'adapter doit rester hors des racines accordées à l'agent");
    }

    const model = options.model ?? request.policy.groups.runtime.model;
    const resumeSessionId = this.#resumeTarget(request.sessionId);
    const args = buildArgs({
      prompt: request.context,
      model,
      approvalMode: decision.approvalMode,
      ...(resumeSessionId === null ? {} : { resumeSessionId }),
    });
    writeHomeConfiguration(home, {
      model,
      maxSessionTurns: options.maxSessionTurns ?? DEFAULT_MAX_SESSION_TURNS,
      excludedTools: options.excludedTools ?? DEFAULT_EXCLUDED_TOOLS,
      ...(options.coreTools === undefined ? {} : { coreTools: options.coreTools }),
    });

    // Sur l'hôte, la CLI emploie le réseau de l'hôte : aucun relais (ADR-006).
    const lease =
      options.transport === undefined || decision.isolation !== "sandbox"
        ? null
        : await options.transport.open(request.sessionId);
    const env: Record<string, string> = { ...(lease?.env ?? {}) };
    if ("GEMINI_CLI_HOME" in env) {
      await lease?.close();
      throw new Error("le transport ne peut pas redéfinir GEMINI_CLI_HOME");
    }
    env["GEMINI_CLI_HOME"] = home;
    env["NO_COLOR"] = "1";

    const maxWallMs = Date.parse(request.deadline) - Date.now();
    let process_: GeminiProcess;
    try {
      if (!Number.isFinite(maxWallMs) || maxWallMs <= 0) throw new Error("échéance dépassée");
      process_ = options.launch.launch({
        sessionId: request.sessionId,
        executable: options.command.executable,
        args: [...(options.command.prefixArgs ?? []), ...args],
        workspace,
        home,
        env,
        broker: lease?.broker ?? null,
        maxWallMs,
        ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
      });
      await process_.started();
    } catch (error) {
      await lease?.close();
      throw error;
    }
    const record: SessionRecord = {
      geminiSessionId: null,
      stats: null,
      ended: false,
      exitCode: null,
    };
    this.#sessions.set(request.sessionId, {
      process: process_,
      isolation: decision.isolation,
      lease,
      record,
      cancelled: false,
      consumed: false,
    });
    this.#persist(request.sessionId, record);
    return { adapterId: GEMINI_ADAPTER_ID, sessionId: request.sessionId, startedAt: nowUtc() };
  }

  async *events(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined || session.consumed) return;
    session.consumed = true;
    const sessionId = handle.sessionId;
    const { record } = session;
    let sawResult = false;
    let reportedError = false;
    let lastMalformed = false;
    let pendingText = "";
    const flush = function* (): Generator<AdapterEvent> {
      if (pendingText.trim() !== "") {
        yield { type: "activity", sessionId, at: nowUtc(), summary: summary(pendingText) };
      }
      pendingText = "";
    };

    try {
      if (session.isolation === "unsandboxed") {
        yield {
          type: "activity",
          sessionId,
          at: nowUtc(),
          summary: "mode NON ISOLÉ : poste hôte, accès complet au compte (ADR-006)",
        };
      }
      for (;;) {
        const line = await session.process.readLine();
        if (line === null) break;
        if (line.trim() === "") continue;
        const event = parseStreamLine(line);
        lastMalformed = event.kind === "malformed";
        const at = nowUtc();
        switch (event.kind) {
          case "init":
            if (GEMINI_SESSION_ID.test(event.sessionId)) record.geminiSessionId = event.sessionId;
            this.#persist(sessionId, record);
            yield { type: "started", sessionId, at };
            break;
          case "message":
            if (event.role === "assistant") pendingText += event.content;
            break;
          case "tool_use":
            yield* flush();
            yield { type: "activity", sessionId, at, summary: `outil ${summary(event.toolName)}` };
            break;
          case "tool_result":
            if (event.status === "error") {
              yield {
                type: "activity",
                sessionId,
                at,
                summary: `outil en échec : ${summary(event.errorMessage ?? "sans détail")}`,
              };
            }
            break;
          case "error": {
            yield* flush();
            if (event.severity === "warning") {
              yield {
                type: "activity",
                sessionId,
                at,
                summary: `avertissement : ${summary(event.message)}`,
              };
              break;
            }
            const kind = classifyError("", event.message);
            if (kind.kind === "rate_limited") {
              yield { type: "rate_limited", sessionId, at, retryAfterMs: kind.retryAfterMs };
            } else {
              reportedError = true;
              yield {
                type: "error",
                sessionId,
                at,
                code: kind.code,
                message: summary(event.message),
              };
            }
            break;
          }
          case "result": {
            yield* flush();
            sawResult = true;
            if (event.stats !== null) {
              record.stats = event.stats;
              this.#persist(sessionId, record);
              yield {
                type: "usage",
                sessionId,
                at,
                quantity: { unit: "tokens", amount: event.stats.totalTokens },
                provenance: "measured",
                tokenBreakdown: tokenBreakdown(event.stats),
              };
            }
            if (event.status === "error") {
              const detail = event.error ?? { type: "unknown", message: "échec sans détail" };
              const kind = classifyError(detail.type, detail.message);
              if (kind.kind === "rate_limited") {
                yield { type: "rate_limited", sessionId, at, retryAfterMs: kind.retryAfterMs };
              } else {
                reportedError = true;
                yield {
                  type: "error",
                  sessionId,
                  at,
                  code: kind.code,
                  message: summary(`${detail.type} : ${detail.message}`),
                };
              }
            }
            break;
          }
          case "unknown":
          case "malformed":
            break;
        }
      }
      yield* flush();

      const exit = await session.process.exited;
      record.ended = true;
      record.exitCode = exit.mainExitCode;
      this.#persist(sessionId, record);
      const at = nowUtc();
      const code = exit.mainExitCode;
      if (session.cancelled) {
        yield { type: "ended", sessionId, at, exitReason: "cancelled" };
        return;
      }
      if (code === GEMINI_EXIT_CODES.turnLimit) {
        yield { type: "ended", sessionId, at, exitReason: "turn_limit" };
        return;
      }
      if (!sawResult) {
        // Flux interrompu : pas de `result`, donc pas de mesure d'usage.
        const cut = code === null || code === 0 || lastMalformed;
        if (cut) {
          yield {
            type: "error",
            sessionId,
            at,
            code: "transient",
            message: `sortie coupée sans résultat (code ${String(code)})`,
          };
          yield { type: "ended", sessionId, at, exitReason: "truncated" };
          return;
        }
      }
      if (code !== null && code !== 0 && !reportedError && !sawResult) {
        const failure = classifyExitCode(code);
        yield { type: "error", sessionId, at, code: failure.code, message: failure.reason };
      }
      yield {
        type: "ended",
        sessionId,
        at,
        exitReason: code === 0 ? "completed" : `exit_${String(code)}`,
      };
    } finally {
      await session.lease?.close();
    }
  }

  async cancel(handle: SessionHandle, timeoutMs: DurationMs): Promise<CancelResult> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return { status: "unconfirmed", detail: "session inconnue" };
    session.cancelled = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs + 250);
    });
    try {
      const result = await Promise.race([session.process.terminateTree(timeoutMs), timeout]);
      if (result === null) {
        return {
          status: "unconfirmed",
          detail: `terminaison non confirmée après ${String(timeoutMs)} ms`,
        };
      }
      return result.confirmed
        ? { status: "forced", within: Math.ceil(result.elapsedMs) }
        : { status: "unconfirmed", detail: result.detail ?? "terminaison non confirmée" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Usage confirmé seulement si la session est terminée et que la CLI a publié ses
   * statistiques (`result.stats`). Après un redémarrage, l'index persisté fait foi.
   */
  reconcile(sessionId: SessionId): Promise<ReconcileResult> {
    const live = this.#sessions.get(sessionId);
    if (live !== undefined && !live.process.hasExited) {
      return Promise.resolve({ status: "uncertain", detail: "processus encore actif" });
    }
    const record = live?.record ?? this.#readIndex()[sessionId];
    if (record === undefined) {
      return Promise.resolve({ status: "uncertain", detail: "session inconnue de l'adapter" });
    }
    if (live === undefined && !record.ended) {
      return Promise.resolve({ status: "uncertain", detail: "fin de session jamais observée" });
    }
    if (record.stats === null) {
      return Promise.resolve({
        status: "uncertain",
        detail: "aucune statistique officielle publiée (sortie coupée ou arrêt forcé)",
      });
    }
    return Promise.resolve({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: record.stats.totalTokens }],
      provenance: "measured",
    });
  }

  #resumeTarget(sessionId: SessionId): string | null {
    const previous = this.#options.resumeFrom?.(sessionId) ?? null;
    if (previous === null) return null;
    const id = this.#readIndex()[previous]?.geminiSessionId ?? null;
    return id !== null && GEMINI_SESSION_ID.test(id) ? id : null;
  }

  #indexPath(): string {
    return path.join(this.#options.stateDir, "gemini-sessions.json");
  }

  #readIndex(): Record<string, SessionRecord> {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.#indexPath(), "utf8"));
      return typeof value === "object" && value !== null
        ? (value as Record<string, SessionRecord>)
        : {};
    } catch {
      return {};
    }
  }

  #persist(sessionId: SessionId, record: SessionRecord): void {
    const index = this.#readIndex();
    index[sessionId] = record;
    fs.mkdirSync(this.#options.stateDir, { recursive: true });
    const target = this.#indexPath();
    const temporary = `${target}.${String(process.pid)}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`);
    fs.renameSync(temporary, target);
  }

  #readVersion(): Promise<string> {
    const { executable, prefixArgs = [] } = this.#options.command;
    const env: Record<string, string> = { GEMINI_CLI_HOME: path.resolve(this.#options.homeDir) };
    for (const key of ["SystemRoot", "SystemDrive", "windir", "PATH", "Path"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [...prefixArgs, "--version"],
        { timeout: VERSION_TIMEOUT_MS, env, windowsHide: true },
        (error, stdout) => {
          if (error !== null) reject(new Error(error.message));
          else resolve(stdout);
        },
      );
    });
  }
}
