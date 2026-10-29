/**
 * Adapter factice, marqué SIMULÉ : conforme à `RuntimeAdapter`, il lance un vrai
 * processus enfant scripté (`agent-process.ts`) dans l'arborescence contenue fournie par
 * le runner, sans aucun appel modèle. Toute consommation est `simulated`. Ne sert jamais
 * de preuve d'intégration réelle (AGENTS §5).
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterId,
  CancelResult,
  CheckpointCandidate,
  DurationMs,
  ExperimentId,
  ProbeResult,
  ReconcileResult,
  RuntimeAdapter,
  SessionHandle,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../contracts/index.js";
import type { AdapterHost, CheckpointRequestable } from "../../runner/host.js";
import type { ContainedProcess } from "../../runner/process-tree.js";
import type { FakeScenario } from "./scenarios.js";

export const FAKE_ADAPTER_ID = "fake" as AdapterId;
export const FAKE_ADAPTER_VERSION = "0.1.0";

export interface FakeAdapterOptions {
  readonly host: AdapterHost;
  /** Scénario joué par chaque session ; peut dépendre de la session. */
  readonly scenario: FakeScenario | ((sessionId: SessionId) => FakeScenario);
  readonly maxProcesses?: number;
  /** Expérience à laquelle rattacher les checkpoints candidats. */
  readonly experimentFor?: (sessionId: SessionId) => ExperimentId;
}

const DEFAULT_EXPERIMENT = "fake-experiment" as ExperimentId;

interface FakeSession {
  readonly process: ContainedProcess;
  tokens: number;
  ended: boolean;
}

function agentScriptPath(): string {
  const compiled = fileURLToPath(new URL("./agent-process.js", import.meta.url));
  return fs.existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL("./agent-process.ts", import.meta.url));
}

function nowUtc(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

function parse(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const ERROR_CODES = ["auth_failed", "incompatible", "transient", "fatal"] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

function errorCode(value: unknown): ErrorCode {
  return ERROR_CODES.find((code) => code === value) ?? "fatal";
}

export class FakeAdapter implements RuntimeAdapter, CheckpointRequestable {
  readonly id = FAKE_ADAPTER_ID;
  readonly #host: AdapterHost;
  readonly #scenario: FakeAdapterOptions["scenario"];
  readonly #maxProcesses: number | undefined;
  readonly #experimentFor: (sessionId: SessionId) => ExperimentId;
  readonly #sessions = new Map<SessionId, FakeSession>();

  constructor(options: FakeAdapterOptions) {
    this.#host = options.host;
    this.#scenario = options.scenario;
    this.#maxProcesses = options.maxProcesses;
    this.#experimentFor = options.experimentFor ?? (() => DEFAULT_EXPERIMENT);
  }

  probe(): Promise<ProbeResult> {
    return Promise.resolve({
      adapterId: FAKE_ADAPTER_ID,
      version: FAKE_ADAPTER_VERSION,
      executionMechanism: "processus enfant local SIMULÉ, aucun appel modèle",
      available: true,
      simulated: true,
    });
  }

  capabilities(): Promise<AdapterCapabilities> {
    return Promise.resolve({
      tokenCounting: "exact",
      countedCategories: ["output"],
      // Simulé : la consommation est scriptée et le runner interrompt au plafond réservé.
      tokenCapEnforcement: "native",
      providerQuotaReading: "none",
      cancellation: "forced_only",
      residualUsageBound: { unit: "tokens", amount: 0 },
      isolationCompatible: true,
      userPrioritySignal: true,
      resumeModes: ["fresh_process_from_memory"],
    });
  }

  start(request: StartRequest): Promise<SessionHandle> {
    const scenario =
      typeof this.#scenario === "function" ? this.#scenario(request.sessionId) : this.#scenario;
    const encoded = Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
    const process_ = this.#host.spawnContained(request.sessionId, {
      executable: process.execPath,
      args: [agentScriptPath(), encoded],
      ...(this.#maxProcesses === undefined ? {} : { maxProcesses: this.#maxProcesses }),
    });
    this.#sessions.set(request.sessionId, { process: process_, tokens: 0, ended: false });
    return process_.started().then(() => ({
      adapterId: FAKE_ADAPTER_ID,
      sessionId: request.sessionId,
      startedAt: nowUtc(),
    }));
  }

  async *events(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return;
    const sessionId = handle.sessionId;
    for (;;) {
      const line = await session.process.readLine();
      if (line === null) return;
      const message = parse(line);
      if (message === null) continue;
      const at = nowUtc();
      switch (message["t"]) {
        case "started":
          yield { type: "started", sessionId, at };
          break;
        case "activity":
          yield { type: "activity", sessionId, at, summary: String(message["summary"]) };
          break;
        case "usage": {
          const tokens = Number(message["tokens"]);
          if (!Number.isSafeInteger(tokens) || tokens < 0) break;
          session.tokens += tokens;
          yield {
            type: "usage",
            sessionId,
            at,
            quantity: { unit: "tokens", amount: tokens },
            provenance: "simulated",
            tokenBreakdown: { output: tokens },
          };
          break;
        }
        case "action": {
          const verdict = this.#host.authorize(sessionId, message["action"]);
          session.process.send(
            JSON.stringify({ t: "verdict", id: message["id"], allowed: verdict.allowed }),
          );
          break;
        }
        case "checkpoint": {
          const candidate: CheckpointCandidate = {
            schemaVersion: CHECKPOINT_SCHEMA_VERSION,
            experimentId: this.#experimentFor(sessionId),
            sessionId,
            summary: String(message["summary"]),
            observations: [{ text: "observation simulée", confidence: "observed" }],
            failures: [],
            artifacts: [],
            incompleteWork: [],
            nextAction: "reprendre depuis ce checkpoint (simulé)",
            hibernationReason: "fin de session simulée",
          };
          yield { type: "checkpoint_candidate", sessionId, at, candidate };
          break;
        }
        case "rate_limited": {
          const retry = message["retryAfterMs"];
          yield {
            type: "rate_limited",
            sessionId,
            at,
            retryAfterMs: typeof retry === "number" ? retry : null,
          };
          break;
        }
        case "error":
          yield {
            type: "error",
            sessionId,
            at,
            code: errorCode(message["code"]),
            message: String(message["message"]),
          };
          break;
        case "ended":
          session.ended = true;
          yield { type: "ended", sessionId, at, exitReason: String(message["reason"]) };
          break;
        default:
          break;
      }
    }
  }

  requestCheckpoint(handle: SessionHandle): Promise<void> {
    this.#sessions.get(handle.sessionId)?.process.send(JSON.stringify({ t: "checkpoint_request" }));
    return Promise.resolve();
  }

  async cancel(handle: SessionHandle, timeoutMs: DurationMs): Promise<CancelResult> {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) return { status: "unconfirmed", detail: "session inconnue" };
    const result = await session.process.terminateTree(timeoutMs);
    return result.confirmed
      ? { status: "forced", within: Math.ceil(result.elapsedMs) }
      : { status: "unconfirmed", detail: result.detail ?? "terminaison non confirmée" };
  }

  /**
   * Usage confirmé seulement pour une session lancée par cette instance et dont le
   * processus est terminé. Après un redémarrage, l'usage est inconnu : incertain.
   */
  reconcile(sessionId: SessionId): Promise<ReconcileResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return Promise.resolve({ status: "uncertain", detail: "session inconnue de cette instance" });
    }
    if (!session.process.hasExited) {
      return Promise.resolve({ status: "uncertain", detail: "processus encore actif" });
    }
    return Promise.resolve({
      status: "confirmed",
      ended: true,
      usage: [{ unit: "tokens", amount: session.tokens }],
      provenance: "simulated",
    });
  }
}
