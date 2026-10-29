/**
 * Adapter Codex (ADR-002, ADR-004, ADR-005) : une session Wake = un processus
 * `codex app-server` (JSON-RPC sur stdio, version figée), un fil Codex repris d'un réveil
 * à l'autre et un tour. `app-server` est retenu plutôt que `codex exec --json` parce
 * qu'il est le seul à exposer la jauge officielle de quota (`account/rateLimits/*`),
 * l'interruption d'un tour (`turn/interrupt`) et l'usage par réponse ; OpenAI le déclare
 * expérimental, d'où la version figée et la sonde.
 *
 * Aucun credential ne passe par l'adapter : `CODEX_HOME` est dédié à Wake et le réseau,
 * sous AppContainer, n'existe que par le transport du relais fournisseur.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterId,
  CancelResult,
  DurationMs,
  PolicyRevision,
  ProbeResult,
  ProviderQuotaSnapshot,
  ReconcileResult,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import {
  buildAppServerCommand,
  threadPermissions,
  type CodexExecutable,
  type HostSandbox,
  type ThreadPermissions,
} from "./command.js";
import { promptFingerprint, type ThreadStore } from "./continuity.js";
import type {
  CodexLauncher,
  CodexProcess,
  IsolationAttestation,
  ProviderChannel,
  ProviderTransport,
} from "./launch.js";
import {
  asRecord,
  classifyCodexError,
  CODEX_SUPPORTED_VERSION,
  parseCodexVersion,
  parseTokenBreakdown,
  parseTurnError,
  quotaFromRateLimits,
  quotaFromRateLimitsResponse,
  subtractBreakdown,
  tokenCategories,
  type JsonRecord,
  type QuotaReading,
  type TokenBreakdown,
} from "./protocol.js";
import { RpcClient, RpcClosedError, RpcError, RpcTimeoutError } from "./rpc.js";

export const CODEX_ADAPTER_ID = "codex" as AdapterId;

const CLIENT_INFO = { name: "mind_wake", title: "MIND Wake", version: "0.1.0" } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Délai accordé à l'arrêt du serveur une fois le tour terminé. */
const SHUTDOWN_TIMEOUT_MS: DurationMs = 2_000;
const SUMMARY_MAX = 200;

export type CodexLaunchMode = "autonomous" | "manual";

export interface CodexAdapterOptions {
  readonly executable: CodexExecutable;
  /** Dossier Codex propre à Wake (configuration, connexion officielle). */
  readonly codexHome: string;
  /** Racine d'exploration : dossier de travail de Codex. */
  readonly workspaceDir: string;
  readonly launcher: CodexLauncher;
  /** Relais fournisseur ; obligatoire sous AppContainer (aucun autre réseau). */
  readonly transport?: ProviderTransport;
  readonly threads: ThreadStore;
  /**
   * Instructions développeur du fil, réinjectées quand leur empreinte change. Absentes :
   * le prompt de réveil composé par le daemon (`StartRequest.context`) suffit.
   */
  readonly systemPrompt?: string | ((request: StartRequest) => string);
  /** Clé de continuité du fil ; par défaut le profil de la policy. */
  readonly continuityKey?: (request: StartRequest) => string;
  readonly model?: string;
  /** Effort de raisonnement (`turn/start.effort`), valeur annoncée par le modèle. */
  readonly effort?: string;
  /** `autonomous` (défaut) exige AppContainer + autotest ; `manual` = lancé par l'humain. */
  readonly mode?: CodexLaunchMode;
  /**
   * Consentement distinct d'ADR-006 (mode sans approbation non isolé sur l'hôte). Par
   * défaut : `policy.groups.runtime.hostUnsandboxedAcknowledged === true`.
   */
  readonly hostUnattendedConsent?: (policy: PolicyRevision) => boolean;
  /**
   * Lanceur des lectures de jauge, hors session : le runner n'admet qu'un processus, celui
   * de la session active. Par défaut le lanceur des sessions (tests).
   */
  readonly quotaLauncher?: CodexLauncher;
  /**
   * Âge maximal d'une jauge reçue en cours de tour (`account/rateLimits/updated`) pour
   * répondre à `readQuota` sans lancer de processus ; 60 s par défaut.
   */
  readonly quotaReuseMs?: DurationMs;
  /** Sandbox Codex hors AppContainer (mode manuel) : `workspace-write` par défaut. */
  readonly hostSandbox?: HostSandbox;
  /** Fils éphémères (`thread/start.ephemeral`) : rien d'écrit dans l'historique Codex. */
  readonly ephemeralThreads?: boolean;
  /**
   * Versions acceptées ; par défaut la seule version validée. Une autre version n'est
   * admise qu'en mode manuel (test de fumée) et la sonde la signale comme non validée.
   */
  readonly acceptedVersions?: readonly string[];
  /** Connexion déjà configurée de l'utilisateur (`~/.codex`) : mode manuel seulement. */
  readonly allowUserCodexHome?: boolean;
  /** Surcharges `-c` supplémentaires ; les réglages de sûreté Wake priment. */
  readonly extraConfig?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  /** Lectures officielles de jauge reçues pendant une session ou lues à la demande. */
  readonly onQuota?: (reading: QuotaReading) => void;
  /** Sortie de `codex --version` ; par défaut, exécution directe sans réseau ni credential. */
  readonly versionCheck?: () => Promise<string>;
  readonly clock?: () => Date;
}

export type CodexAdapterErrorCode =
  "version_unsupported" | "isolation_required" | "transport_required" | "launch_failed";

export class CodexAdapterError extends Error {
  readonly code: CodexAdapterErrorCode;

  constructor(code: CodexAdapterErrorCode, message: string) {
    super(message);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}

type TurnState =
  "pending" | "inProgress" | "completed" | "interrupted" | "failed" | "stream_cut" | "aborted";

class EventQueue {
  readonly #items: AdapterEvent[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  push(event: AdapterEvent): void {
    if (this.#closed) return;
    this.#items.push(event);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  async *drain(): AsyncIterable<AdapterEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => (this.#waiter = resolve));
    }
  }
}

interface CodexSession {
  readonly sessionId: SessionId;
  readonly process: CodexProcess;
  readonly channel: ProviderChannel | null;
  readonly queue: EventQueue;
  readonly permissions: ThreadPermissions;
  rpc: RpcClient | null;
  threadId: string | null;
  turnId: string | null;
  turn: TurnState;
  turnDone: Promise<void>;
  resolveTurn: () => void;
  startedEmitted: boolean;
  ended: boolean;
  cancelling: boolean;
  /** Cumul du fil au dernier relevé ; `null` avant le premier relevé de ce tour. */
  lastTotal: TokenBreakdown | null;
  measuredTokens: number;
  usageReports: number;
  /** Dernière erreur non retentée, en attente de `turn/completed`. */
  lastError: { message: string; info: unknown } | null;
  /** Dernière jauge reçue (`account/rateLimits/updated`). */
  lastQuota: QuotaReading | null;
  finished: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function defaultVersionCheck(
  executable: CodexExecutable,
  codexHome: string,
): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      const env: Record<string, string> = { CODEX_HOME: codexHome };
      for (const key of ["SystemRoot", "SystemDrive", "windir", "PATH"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      execFile(
        executable.path,
        [...(executable.prefixArgs ?? []), "--version"],
        { env, timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          if (error !== null) reject(new Error(error.message));
          else resolve(stdout);
        },
      );
    });
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = CODEX_ADAPTER_ID;
  readonly #options: CodexAdapterOptions;
  readonly #sessions = new Map<SessionId, CodexSession>();
  readonly #versionCheck: () => Promise<string>;
  readonly #clock: () => Date;
  #version: Promise<{ version: string | null; reason?: string }> | null = null;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
    this.#versionCheck =
      options.versionCheck ?? defaultVersionCheck(options.executable, options.codexHome);
    this.#clock = options.clock ?? (() => new Date());
  }

  #now(): UtcTimestamp {
    return this.#clock().toISOString() as UtcTimestamp;
  }

  #detectVersion(): Promise<{ version: string | null; reason?: string }> {
    this.#version ??= this.#versionCheck().then(
      (output) => {
        const version = parseCodexVersion(output);
        return version === null
          ? { version: null, reason: "version de Codex illisible" }
          : { version };
      },
      (error: unknown) => {
        this.#version = null;
        return { version: null, reason: `codex introuvable : ${errorMessage(error)}` };
      },
    );
    return this.#version;
  }

  async probe(): Promise<ProbeResult> {
    const detected = await this.#detectVersion();
    const base = {
      adapterId: CODEX_ADAPTER_ID,
      version: detected.version ?? "inconnue",
      executionMechanism: `codex app-server ${CODEX_SUPPORTED_VERSION} (JSON-RPC stdio, déclaré expérimental par OpenAI)`,
      simulated: false,
    };
    if (detected.version === null) {
      return { ...base, available: false, unavailableReason: detected.reason ?? "inconnue" };
    }
    if (!this.#acceptedVersions().includes(detected.version)) {
      return {
        ...base,
        available: false,
        unavailableReason: `version ${detected.version} non validée (attendue ${CODEX_SUPPORTED_VERSION})`,
      };
    }
    if (detected.version !== CODEX_SUPPORTED_VERSION) {
      return {
        ...base,
        available: true,
        unavailableReason: `version ${detected.version} admise en mode manuel seulement, non validée`,
      };
    }
    return { ...base, available: true };
  }

  /** Une version non validée ou le `CODEX_HOME` de l'utilisateur n'existent qu'en manuel. */
  #manualOnly(): boolean {
    return (this.#options.mode ?? "autonomous") === "manual";
  }

  #acceptedVersions(): readonly string[] {
    return this.#manualOnly()
      ? (this.#options.acceptedVersions ?? [CODEX_SUPPORTED_VERSION])
      : [CODEX_SUPPORTED_VERSION];
  }

  capabilities(): Promise<AdapterCapabilities> {
    return Promise.resolve({
      // `thread/tokenUsage/updated` : compteurs officiels par réponse, à la fin de chacune.
      tokenCounting: "exact",
      countedCategories: ["input", "cached_input", "output", "reasoning"],
      // Aucun plafond de tokens imposable avec une connexion ChatGPT : seule la garde de
      // quota (jauge officielle + interruption au seuil) borne la voie abonnement.
      tokenCapEnforcement: "provider_quota_guard",
      providerQuotaReading: "official",
      cancellation: "graceful",
      // Consommation après interruption non documentée : inconnue, donc aucune borne.
      residualUsageBound: null,
      isolationCompatible: true,
      userPrioritySignal: true,
      resumeModes: ["fresh_process_from_memory", "native_resume"],
    });
  }

  /**
   * Mode sans approbation : sous AppContainer avec autotest réussi (ADR-005), ou sur l'hôte
   * avec le consentement distinct d'ADR-006 consigné dans la policy. Sinon, refus en
   * autonome. Une lecture de jauge (aucun tour) n'en demande jamais.
   */
  #assertLaunchAllowed(
    launcher: CodexLauncher,
    sessionId: SessionId,
    policy: PolicyRevision | null,
  ): { attestation: IsolationAttestation; bypass: boolean } {
    const attestation = launcher.isolation(sessionId);
    const confined = attestation.confined && attestation.selfTestPassed;
    const hostConsent =
      !attestation.confined &&
      policy !== null &&
      (this.#options.hostUnattendedConsent ?? defaultHostConsent)(policy);
    const bypass = policy !== null && (confined || hostConsent);
    if (policy !== null && (this.#options.mode ?? "autonomous") === "autonomous" && !bypass) {
      throw new CodexAdapterError(
        "isolation_required",
        `lancement autonome refusé : ni sandbox vérifiée, ni consentement au mode non isolé (ADR-006) — ${attestation.detail}`,
      );
    }
    if (attestation.confined && this.#options.transport === undefined) {
      throw new CodexAdapterError(
        "transport_required",
        "aucun transport fournisseur : le conteneur n'a pas d'autre réseau",
      );
    }
    return { attestation, bypass };
  }

  async #assertVersion(): Promise<void> {
    const detected = await this.#detectVersion();
    if (detected.version === null || !this.#acceptedVersions().includes(detected.version)) {
      throw new CodexAdapterError(
        "version_unsupported",
        detected.version === null
          ? (detected.reason ?? "version inconnue")
          : `version ${detected.version} non validée (attendue ${CODEX_SUPPORTED_VERSION})`,
      );
    }
  }

  /** `policy` nulle : lecture de jauge, sans fil ni tour, par `quotaLauncher`. */
  async #launch(
    sessionId: SessionId,
    policy: PolicyRevision | null,
  ): Promise<{
    process: CodexProcess;
    channel: ProviderChannel | null;
    bypass: boolean;
    isolated: boolean;
  }> {
    await this.#assertVersion();
    const launcher =
      policy === null
        ? (this.#options.quotaLauncher ?? this.#options.launcher)
        : this.#options.launcher;
    const { attestation, bypass } = this.#assertLaunchAllowed(launcher, sessionId, policy);
    const channel =
      this.#options.transport === undefined ? null : await this.#options.transport.open(sessionId);
    try {
      const command = buildAppServerCommand({
        executable: this.#options.executable,
        codexHome: this.#options.codexHome,
        workspaceDir: this.#options.workspaceDir,
        channel,
        allowUserCodexHome: this.#manualOnly() && this.#options.allowUserCodexHome === true,
        ...(this.#options.extraConfig === undefined
          ? {}
          : { extraConfig: this.#options.extraConfig }),
      });
      const process_ = launcher.launch(sessionId, { ...command, unattended: bypass });
      try {
        await process_.started();
      } catch (error) {
        await process_.terminateTree(SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
        throw new CodexAdapterError("launch_failed", `codex app-server : ${errorMessage(error)}`);
      }
      return {
        process: process_,
        channel,
        bypass,
        isolated: attestation.confined && attestation.selfTestPassed,
      };
    } catch (error) {
      await channel?.close().catch(() => undefined);
      throw error;
    }
  }

  async start(request: StartRequest): Promise<SessionHandle> {
    if (this.#sessions.has(request.sessionId)) {
      throw new Error(`session déjà lancée : ${request.sessionId}`);
    }
    const {
      process: process_,
      channel,
      bypass,
      isolated,
    } = await this.#launch(request.sessionId, request.policy);
    let resolveTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => (resolveTurn = resolve));
    const session: CodexSession = {
      sessionId: request.sessionId,
      process: process_,
      channel,
      queue: new EventQueue(),
      permissions: threadPermissions(bypass, this.#options.hostSandbox),
      rpc: null,
      threadId: null,
      turnId: null,
      turn: "pending",
      turnDone,
      resolveTurn,
      startedEmitted: false,
      ended: false,
      cancelling: false,
      lastTotal: null,
      measuredTokens: 0,
      usageReports: 0,
      lastError: null,
      lastQuota: null,
      finished: Promise.resolve(),
    };
    session.rpc = new RpcClient(process_, {
      requestTimeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onNotification: (method, params) => {
        this.#onNotification(session, method, params);
      },
      onClose: () => {
        this.#onStreamClosed(session);
      },
    });
    this.#sessions.set(request.sessionId, session);
    if (bypass && !isolated) {
      // ADR-006 : le mode non isolé doit rester visible dans le journal et les bilans.
      this.#emit(session, {
        type: "activity",
        sessionId: request.sessionId,
        at: this.#now(),
        summary: "mode sans approbation NON ISOLÉ sur l'hôte (ADR-006, consentement consigné)",
      });
    }
    session.finished = this.#drive(session, request);
    return { adapterId: CODEX_ADAPTER_ID, sessionId: request.sessionId, startedAt: this.#now() };
  }

  events(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return (async function* () {})();
    return session.queue.drain();
  }

  #emit(session: CodexSession, event: AdapterEvent): void {
    if (!session.ended) session.queue.push(event);
  }

  #emitStarted(session: CodexSession): void {
    if (session.startedEmitted) return;
    session.startedEmitted = true;
    this.#emit(session, { type: "started", sessionId: session.sessionId, at: this.#now() });
  }

  #emitError(
    session: CodexSession,
    code: "auth_failed" | "incompatible" | "transient" | "fatal",
    message: string,
  ): void {
    this.#emit(session, {
      type: "error",
      sessionId: session.sessionId,
      at: this.#now(),
      code,
      message,
    });
  }

  /** Traduit une erreur Codex en limitation ou en erreur d'adapter. */
  #emitTurnError(session: CodexSession, error: { message: string; info: unknown }): void {
    const kind = classifyCodexError(error.info, error.message).kind;
    if (kind === "rate_limited") {
      this.#emit(session, {
        type: "rate_limited",
        sessionId: session.sessionId,
        at: this.#now(),
        retryAfterMs: this.#retryAfter(session),
      });
      return;
    }
    this.#emitError(session, kind, error.message);
  }

  /**
   * Délai officiel : remise à zéro la plus lointaine parmi les fenêtres pleines de la
   * dernière jauge reçue ; `null` si aucune fenêtre pleine n'est connue.
   */
  #retryAfter(session: CodexSession): DurationMs | null {
    const now = this.#clock().getTime();
    const full = (session.lastQuota?.snapshots ?? []).filter((s) => s.usedBasisPoints >= 10_000);
    if (full.length === 0) return null;
    return Math.max(0, ...full.map((s) => Date.parse(s.resetsAt) - now));
  }

  async #drive(session: CodexSession, request: StartRequest): Promise<void> {
    const rpc = session.rpc;
    if (rpc === null) return;
    let reason = "completed";
    try {
      await rpc.request("initialize", { clientInfo: CLIENT_INFO });
      rpc.notify("initialized", {});
      const account = await rpc.request("account/read", { refreshToken: false });
      if (account["account"] === null && account["requiresOpenaiAuth"] === true) {
        this.#emitError(
          session,
          "auth_failed",
          "Codex n'est connecté à aucun compte (CODEX_HOME Wake)",
        );
        reason = "auth_required";
        return;
      }
      await this.#openThread(session, rpc, request);
      if (session.threadId === null) return;
      const started = await rpc.request("turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text: request.context }],
        ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
        ...(this.#options.effort === undefined ? {} : { effort: this.#options.effort }),
      });
      const turnId = asRecord(started["turn"])?.["id"];
      if (typeof turnId === "string") session.turnId ??= turnId;
      if (session.turn === "pending") session.turn = "inProgress";
      this.#emitStarted(session);
      await session.turnDone;
      reason = session.turn;
    } catch (error) {
      reason = this.#onDriveError(session, error);
    } finally {
      await this.#finish(session, reason);
    }
  }

  #onDriveError(session: CodexSession, error: unknown): string {
    if (session.cancelling) return "cancelled";
    if (error instanceof RpcClosedError) {
      this.#onStreamClosed(session);
      return "stream_cut";
    }
    if (error instanceof RpcTimeoutError) {
      this.#emitError(session, "transient", error.message);
      return "timeout";
    }
    if (error instanceof RpcError) {
      const info = asRecord(error.data)?.["codexErrorInfo"] ?? null;
      const kind = classifyCodexError(info, error.message).kind;
      if (kind === "rate_limited") {
        this.#emitTurnError(session, { message: error.message, info });
      } else {
        this.#emitError(session, kind, error.message);
      }
      return "rpc_error";
    }
    this.#emitError(session, "fatal", errorMessage(error));
    return "adapter_error";
  }

  async #openThread(session: CodexSession, rpc: RpcClient, request: StartRequest): Promise<void> {
    const key = this.#options.continuityKey?.(request) ?? String(request.policy.profileId);
    const given =
      typeof this.#options.systemPrompt === "function"
        ? this.#options.systemPrompt(request)
        : this.#options.systemPrompt;
    const prompt = given === undefined || given === "" ? null : given;
    const fingerprint = promptFingerprint(prompt ?? "");
    const instructions = prompt === null ? {} : { developerInstructions: prompt };
    const common = {
      cwd: this.#options.workspaceDir,
      approvalPolicy: session.permissions.approvalPolicy,
      sandbox: session.permissions.sandbox,
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
    };
    const previous = this.#options.threads.load(key);
    if (previous !== null) {
      try {
        const resumed = await rpc.request("thread/resume", {
          threadId: previous.threadId,
          excludeTurns: true,
          ...common,
          // Prompt système réinjecté seulement s'il a changé depuis la dernière session.
          ...(previous.promptFingerprint === fingerprint ? {} : instructions),
        });
        const id = asRecord(resumed["thread"])?.["id"];
        session.threadId = typeof id === "string" ? id : previous.threadId;
        this.#options.threads.save(key, {
          threadId: session.threadId,
          promptFingerprint: fingerprint,
          updatedAt: this.#now(),
        });
        this.#emit(session, {
          type: "activity",
          sessionId: session.sessionId,
          at: this.#now(),
          summary:
            previous.promptFingerprint === fingerprint
              ? "reprise du fil Codex précédent"
              : "reprise du fil Codex précédent, prompt système mis à jour",
        });
        return;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        this.#options.threads.forget(key);
        this.#emit(session, {
          type: "activity",
          sessionId: session.sessionId,
          at: this.#now(),
          summary: "fil Codex précédent non repris, nouveau fil",
        });
      }
    }
    const created = await rpc.request("thread/start", {
      ...common,
      ...instructions,
      serviceName: CLIENT_INFO.name,
      ephemeral: this.#options.ephemeralThreads === true,
    });
    const id = asRecord(created["thread"])?.["id"];
    if (typeof id !== "string") {
      this.#emitError(session, "incompatible", "thread/start sans identifiant de fil");
      return;
    }
    session.threadId = id;
    this.#options.threads.save(key, {
      threadId: id,
      promptFingerprint: fingerprint,
      updatedAt: this.#now(),
    });
  }

  #onNotification(session: CodexSession, method: string, params: JsonRecord): void {
    const at = this.#now();
    const sessionId = session.sessionId;
    switch (method) {
      case "turn/started": {
        const id = asRecord(params["turn"])?.["id"];
        if (typeof id === "string") session.turnId ??= id;
        if (session.turn === "pending") session.turn = "inProgress";
        this.#emitStarted(session);
        break;
      }
      case "item/started": {
        const item = asRecord(params["item"]);
        if (item?.["type"] === "commandExecution" && typeof item["command"] === "string") {
          this.#emit(session, {
            type: "activity",
            sessionId,
            at,
            summary: `commande : ${summary(item["command"])}`,
          });
        }
        break;
      }
      case "item/completed":
        this.#onItemCompleted(session, asRecord(params["item"]));
        break;
      case "thread/tokenUsage/updated":
        this.#onTokenUsage(session, params);
        break;
      case "account/rateLimits/updated": {
        const reading = quotaFromRateLimits(params["rateLimits"], at);
        session.lastQuota = reading;
        try {
          this.#options.onQuota?.(reading);
        } catch {
          // Un consommateur défaillant ne doit pas interrompre le flux d'événements.
        }
        break;
      }
      case "error": {
        const error = parseTurnError(params["error"]);
        if (error === null) break;
        if (params["willRetry"] === true) {
          this.#emit(session, {
            type: "activity",
            sessionId,
            at,
            summary: `erreur fournisseur, nouvelle tentative : ${summary(error.message)}`,
          });
        } else {
          session.lastError = error;
        }
        break;
      }
      case "turn/completed":
        this.#onTurnCompleted(session, asRecord(params["turn"]));
        break;
      default:
        break;
    }
  }

  #onItemCompleted(session: CodexSession, item: JsonRecord | null): void {
    if (item === null) return;
    const at = this.#now();
    const sessionId = session.sessionId;
    // Le raisonnement du modèle n'est jamais journalisé (AGENTS §3.10).
    switch (item["type"]) {
      case "agentMessage":
        if (typeof item["text"] === "string") {
          this.#emit(session, {
            type: "activity",
            sessionId,
            at,
            summary: `message : ${summary(item["text"])}`,
          });
        }
        break;
      case "fileChange": {
        const changes = Array.isArray(item["changes"]) ? item["changes"].length : 0;
        this.#emit(session, {
          type: "activity",
          sessionId,
          at,
          summary: `fichiers modifiés : ${String(changes)}`,
        });
        break;
      }
      case "mcpToolCall":
      case "webSearch":
      case "contextCompaction":
        this.#emit(session, {
          type: "activity",
          sessionId,
          at,
          summary: `élément ${item["type"]} terminé`,
        });
        break;
      default:
        break;
    }
  }

  /**
   * Usage mesuré : différence entre deux cumuls du fil. Le premier relevé du tour prend
   * `last` (dernière réponse), car le cumul du fil inclut les sessions précédentes. Les
   * relevés d'un autre tour (reprise du fil) ne servent que de point de départ.
   */
  #onTokenUsage(session: CodexSession, params: JsonRecord): void {
    const usage = asRecord(params["tokenUsage"]);
    const total = parseTokenBreakdown(usage?.["total"]);
    const last = parseTokenBreakdown(usage?.["last"]);
    if (total === null || last === null) return;
    const ours = session.turnId !== null && params["turnId"] === session.turnId;
    if (!ours) {
      session.lastTotal = total;
      return;
    }
    const delta =
      session.lastTotal === null ? last : (subtractBreakdown(total, session.lastTotal) ?? last);
    session.lastTotal = total;
    if (delta.totalTokens === 0) return;
    session.measuredTokens += delta.totalTokens;
    session.usageReports += 1;
    this.#emit(session, {
      type: "usage",
      sessionId: session.sessionId,
      at: this.#now(),
      quantity: { unit: "tokens", amount: delta.totalTokens },
      provenance: "measured",
      tokenBreakdown: tokenCategories(delta),
    });
  }

  #onTurnCompleted(session: CodexSession, turn: JsonRecord | null): void {
    if (turn === null) return;
    const id = turn["id"];
    if (session.turnId !== null && typeof id === "string" && id !== session.turnId) return;
    const status = turn["status"];
    if (status === "completed" || status === "interrupted") {
      session.turn = status;
    } else {
      session.turn = "failed";
      const error = parseTurnError(turn["error"]) ??
        session.lastError ?? { message: `tour terminé (${String(status)})`, info: null };
      this.#emitTurnError(session, error);
    }
    session.resolveTurn();
  }

  /** Flux coupé : tour en cours perdu, usage de la dernière requête inconnu. */
  #onStreamClosed(session: CodexSession): void {
    if (session.turn === "pending" || session.turn === "inProgress") {
      session.turn = session.cancelling ? "aborted" : "stream_cut";
      if (!session.cancelling) {
        this.#emitError(session, "transient", "flux codex app-server coupé avant la fin du tour");
      }
    }
    session.resolveTurn();
  }

  async #finish(session: CodexSession, reason: string): Promise<void> {
    if (!session.process.hasExited) {
      await session.process.terminateTree(SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
    }
    await session.channel?.close().catch(() => undefined);
    this.#emit(session, {
      type: "ended",
      sessionId: session.sessionId,
      at: this.#now(),
      exitReason: reason,
    });
    session.ended = true;
    session.queue.close();
  }

  /**
   * Interruption coopérative (`turn/interrupt`) dans la moitié du délai, puis terminaison
   * de l'arborescence par le lanceur, sans dépendre de Codex.
   */
  async cancel(handle: SessionHandle, timeoutMs: DurationMs): Promise<CancelResult> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return { status: "unconfirmed", detail: "session inconnue" };
    const begin = performance.now();
    const elapsed = (): number => performance.now() - begin;
    session.cancelling = true;
    const rpc = session.rpc;
    if (
      rpc !== null &&
      !rpc.closed &&
      session.turn === "inProgress" &&
      session.threadId !== null &&
      session.turnId !== null
    ) {
      const interrupt = rpc
        .request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId })
        .then(() => session.turnDone)
        .catch(() => undefined);
      await Promise.race([interrupt, sleep(timeoutMs / 2)]);
    }
    const graceful = session.turn === "interrupted" || session.turn === "completed";
    const termination = await session.process.terminateTree(Math.max(1, timeoutMs - elapsed()));
    if (!termination.confirmed) {
      return { status: "unconfirmed", detail: termination.detail ?? "terminaison non confirmée" };
    }
    if (session.turn === "pending" || session.turn === "inProgress") session.turn = "aborted";
    session.resolveTurn();
    const within = Math.ceil(elapsed());
    return graceful ? { status: "cancelled", within } : { status: "forced", within };
  }

  /**
   * Usage confirmé seulement pour un tour terminé normalement et mesuré par cette
   * instance. Tour échoué, interrompu ou coupé : la dernière requête peut n'avoir rien
   * rapporté, l'usage reste incertain (borne maximale conservée).
   */
  async reconcile(sessionId: SessionId): Promise<ReconcileResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return { status: "uncertain", detail: "session inconnue de cette instance" };
    }
    if (!session.process.hasExited || !session.ended) {
      await Promise.race([session.finished, sleep(SHUTDOWN_TIMEOUT_MS)]);
    }
    if (!session.process.hasExited) {
      return { status: "uncertain", detail: "processus codex encore actif" };
    }
    if (session.turn !== "completed") {
      return {
        status: "uncertain",
        detail: `tour ${session.turn} : ${String(session.measuredTokens)} tokens mesurés, dernière requête possiblement non rapportée`,
      };
    }
    if (session.usageReports === 0) {
      return { status: "uncertain", detail: "tour terminé sans relevé d'usage" };
    }
    return {
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: session.measuredTokens }],
      provenance: "measured",
    };
  }

  /**
   * Lecture officielle de la jauge (`account/rateLimits/read`) par un serveur sans fil
   * ni tour : aucune requête modèle. Sert à la garde de quota avant un lancement.
   */
  async readProviderQuota(): Promise<QuotaReading> {
    const sessionId = `codex-quota-${randomUUID()}` as SessionId;
    const { process: process_, channel } = await this.#launch(sessionId, null);
    const rpc = new RpcClient(process_, {
      requestTimeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onNotification: () => undefined,
      onClose: () => undefined,
    });
    try {
      await rpc.request("initialize", { clientInfo: CLIENT_INFO });
      rpc.notify("initialized", {});
      const result = await rpc.request("account/rateLimits/read", {});
      const reading = quotaFromRateLimitsResponse(result, this.#now());
      this.#options.onQuota?.(reading);
      return reading;
    } finally {
      await process_.terminateTree(SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
      await channel?.close().catch(() => undefined);
    }
  }

  /**
   * `QuotaReadable` du runner : fenêtres complètes lues officiellement. Une lecture
   * impossible rend un tableau vide, que le scheduler traite comme un quota inconnu.
   */
  async readQuota(): Promise<readonly ProviderQuotaSnapshot[]> {
    // Pendant une session, la jauge arrive à chaque fin de tour : la réutiliser si récente.
    const reuseMs = this.#options.quotaReuseMs ?? 60_000;
    const now = this.#clock().getTime();
    for (const session of this.#sessions.values()) {
      const recent = session.lastQuota?.snapshots.filter(
        (s) => now - Date.parse(s.observedAt) <= reuseMs,
      );
      if (!session.ended && recent !== undefined && recent.length > 0) return recent;
    }
    try {
      return (await this.readProviderQuota()).snapshots;
    } catch {
      return [];
    }
  }
}

/** Consentement ADR-006 consigné dans la policy (seule la valeur `true` vaut accord). */
function defaultHostConsent(policy: PolicyRevision): boolean {
  return policy.groups.runtime.hostUnsandboxedAcknowledged === true;
}
