/**
 * Adapter de test NON simulé dont le « runtime » est la sonde native du lanceur confiné
 * (`src/sandbox`) : elle tente des opérations système et rapporte les codes d'erreur.
 * Aucun modèle, aucun réseau. Sert à prouver le câblage sandbox → runner → daemon.
 */

import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterId,
  CancelResult,
  ProbeResult,
  ProviderQuotaSnapshot,
  ReconcileResult,
  RuntimeAdapter,
  SessionHandle,
  StartRequest,
  SubscriptionQuotaGuard,
  UtcTimestamp,
} from "../../../src/contracts/index.js";
import type { AdapterHost, QuotaReadable, SessionProcess } from "../../../src/runner/index.js";

export const PROBE_ID = "probe-test" as AdapterId;

export function utcNow(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp;
}

export interface ProbeLine {
  readonly op: string;
  readonly arg: string;
  readonly ok: boolean;
  readonly code: number;
}

export interface ProbeAdapterOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly unattended?: boolean;
  /** Adapter simulé : Job Object seul, sans sandbox. */
  readonly simulated?: boolean;
  /** Jauge officielle simulée par le test ; absente = aucune lecture de quota. */
  readonly quota?: () => readonly ProviderQuotaSnapshot[];
}

/**
 * Adapter de test non simulé : son « runtime » est la sonde native, qui tente des
 * opérations système et rapporte les codes d'erreur. Aucun modèle, aucun réseau.
 */
export class ProbeAdapter implements RuntimeAdapter, QuotaReadable {
  readonly id = PROBE_ID;
  readonly lines: ProbeLine[] = [];
  process: SessionProcess | null = null;

  constructor(
    private readonly host: AdapterHost,
    private readonly o: ProbeAdapterOptions,
  ) {}

  probe(): Promise<ProbeResult> {
    return Promise.resolve({
      adapterId: PROBE_ID,
      version: "test",
      executionMechanism: "sonde native de test, aucun modèle",
      available: true,
      simulated: this.o.simulated === true,
    });
  }

  capabilities(): Promise<AdapterCapabilities> {
    const quota = this.o.quota !== undefined;
    return Promise.resolve({
      tokenCounting: "none",
      countedCategories: [],
      tokenCapEnforcement: quota ? "provider_quota_guard" : "native",
      providerQuotaReading: quota ? "official" : "none",
      cancellation: "forced_only",
      residualUsageBound: null,
      isolationCompatible: true,
      userPrioritySignal: true,
      resumeModes: ["fresh_process_from_memory"],
    });
  }

  start(request: StartRequest): Promise<SessionHandle> {
    this.process = this.host.spawnContained(request.sessionId, {
      executable: this.o.executable,
      args: this.o.args,
      ...(this.o.unattended === undefined ? {} : { unattended: this.o.unattended }),
    });
    return Promise.resolve({
      adapterId: PROBE_ID,
      sessionId: request.sessionId,
      startedAt: utcNow(),
    });
  }

  async *events(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    const proc = this.process;
    if (proc === null) return;
    const base = { sessionId: handle.sessionId };
    yield { ...base, at: utcNow(), type: "started" };
    for (;;) {
      const line = await proc.readLine();
      if (line === null) break;
      if (!line.startsWith("probe ")) continue;
      const parsed = JSON.parse(line.slice("probe ".length)) as ProbeLine;
      this.lines.push(parsed);
      yield {
        ...base,
        at: utcNow(),
        type: "activity",
        summary: `${parsed.op} ${String(parsed.code)}`,
      };
    }
    const exit = await proc.exited;
    if (exit.mainExitCode === 0)
      yield { ...base, at: utcNow(), type: "ended", exitReason: "sonde terminée" };
  }

  async cancel(): Promise<CancelResult> {
    const result = await this.process?.terminateTree();
    return result?.confirmed === true
      ? { status: "forced", within: result.elapsedMs }
      : { status: "unconfirmed", detail: "terminaison non confirmée" };
  }

  reconcile(): Promise<ReconcileResult> {
    return Promise.resolve({ status: "confirmed", ended: true, usage: [], provenance: "measured" });
  }

  readQuota(): Promise<readonly ProviderQuotaSnapshot[]> {
    return Promise.resolve(this.o.quota?.() ?? []);
  }

  op(name: string, argPart?: string): ProbeLine | undefined {
    return this.lines.find(
      (l) => l.op === name && (argPart === undefined || l.arg.includes(argPart)),
    );
  }
}

export const GUARD: SubscriptionQuotaGuard = {
  enabled: true,
  accountRiskAcknowledged: true,
  startBelowBasisPoints: 6_000,
  stopAtBasisPoints: 8_000,
  userReserveBasisPoints: 1_000,
  overshootBoundBasisPoints: 500,
  maxSnapshotAgeMs: 60_000,
  launchWhenResetWithinMs: 6 * 3_600_000,
};

export function snapshot(used: number, observedAt: UtcTimestamp = utcNow()): ProviderQuotaSnapshot {
  return {
    windowKey: "primary",
    windowDurationMs: 5 * 3_600_000,
    usedBasisPoints: used,
    resetsAt: new Date(Date.now() + 3_600_000).toISOString() as UtcTimestamp,
    observedAt,
    provenance: "measured",
  };
}
