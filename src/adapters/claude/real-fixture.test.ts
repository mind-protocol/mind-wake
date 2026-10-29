/**
 * Rejeu du flux réel expurgé capturé par la fumée opt-in (Claude Code 2.1.308, 29 octobre
 * 2026, `real-smoke.test.ts`) : trois appels, session neuve, reprise, `/usage`.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import type { TreeTermination } from "../../runner/process-tree.js";
import {
  ClaudeAdapter,
  parseStreamLine,
  type ClaudeLauncher,
  type ClaudeProcess,
  type ClaudeQuotaSignal,
} from "./index.js";

const FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/claude/real-2.1.308.jsonl", import.meta.url),
);
/** Second passage : mode non isolé (ADR-006), Job Object, `/usage` sans trafic non essentiel coupé. */
const FIXTURE_UNSANDBOXED = fileURLToPath(
  new URL("../../../test/fixtures/claude/real-2.1.308-unsandboxed.jsonl", import.meta.url),
);

function linesOf(call: number, file = FIXTURE): string[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { call: number; message: unknown })
    .filter((entry) => entry.call === call)
    .map((entry) => JSON.stringify(entry.message));
}

/** Rejoue des lignes puis reste ouvert, comme le CLI en entrée `stream-json`. */
class ReplayProcess implements ClaudeProcess {
  readonly exited: Promise<{ readonly mainExitCode: number | null }>;
  readonly #lines: string[];
  #done = false;
  #resolve: (exit: { mainExitCode: number | null }) => void = () => undefined;

  constructor(lines: readonly string[]) {
    this.#lines = [...lines];
    this.exited = new Promise((resolve) => (this.#resolve = resolve));
  }

  started(): Promise<number> {
    return Promise.resolve(1);
  }

  get hasExited(): boolean {
    return this.#done;
  }

  readLine(): Promise<string | null> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return this.#done ? Promise.resolve(null) : this.exited.then(() => null);
  }

  send(): void {
    // Le message utilisateur n'a pas d'effet sur un rejeu.
  }

  terminateTree(): Promise<TreeTermination> {
    this.#done = true;
    this.#resolve({ mainExitCode: null });
    return Promise.resolve({ confirmed: true, elapsedMs: 0, kernelMs: null, via: "kill_command" });
  }
}

function request(sessionId: string): StartRequest {
  return {
    sessionId: sessionId as SessionId,
    reservationId: "r" as ReservationId,
    policy: {} as StartRequest["policy"],
    context: "c",
    maxInputTokens: 1_000,
    deadline: new Date(Date.now() + 60_000).toISOString() as UtcTimestamp,
  };
}

describe("adapter Claude Code : rejeu du flux réel 2.1.308", () => {
  it("chaque ligne réelle est reconnue", () => {
    const kinds = [1, 2, 3].flatMap((n) => linesOf(n)).map((line) => parseStreamLine(line).kind);
    expect(kinds).not.toContain("malformed");
    expect(kinds.filter((k) => k === "init")).toHaveLength(3);
    expect(kinds.filter((k) => k === "result")).toHaveLength(2);
    expect(kinds).toContain("usage_report");
  });

  it("usage par appel, signaux de jauge et absence de rate_limits sur /usage", async () => {
    let call = 0;
    const launcher: ClaudeLauncher = {
      isolation: () => ({ kind: "host_job", detail: "rejeu" }),
      launch: () => {
        call += 1;
        return new ReplayProcess(linesOf(call));
      },
    };
    const signals: ClaudeQuotaSignal[] = [];
    const dir = fs.mkdtempSync(`${fileURLToPath(new URL(".", import.meta.url))}/.replay-`);
    try {
      const adapter = new ClaudeAdapter({
        launcher,
        autonomy: "supervised",
        executable: "claude",
        promptDir: dir,
        systemPrompt: "p",
        workspaceFor: () => dir,
        conversationKeyFor: () => "replay",
        tools: [],
        onQuotaSignal: (_s, signal) => signals.push(signal),
      });
      const usages: AdapterEvent[] = [];
      for (const id of ["r1", "r2"]) {
        const handle = await adapter.start(request(id));
        for await (const event of adapter.events(handle)) {
          if (event.type === "usage") usages.push(event);
          expect(event.type).not.toBe("error");
        }
        expect(await adapter.reconcile(handle.sessionId)).toMatchObject({ status: "confirmed" });
      }
      // Reprise : l'usage rapporté est celui du seul appel, pas un cumul.
      expect(usages).toEqual([
        expect.objectContaining({
          quantity: { unit: "tokens", amount: 582 },
          tokenBreakdown: { input: 577, cached_input: 0, output: 5 },
        }),
        expect.objectContaining({
          quantity: { unit: "tokens", amount: 610 },
          tokenBreakdown: { input: 605, cached_input: 0, output: 5 },
        }),
      ]);
      expect(signals[0]).toMatchObject({
        status: "allowed",
        rateLimitType: "five_hour",
        windows: [
          { key: "five_hour", utilization: 0.1 },
          { key: "seven_day", utilization: 0.44 },
        ],
      });

      const reading = await adapter.readQuotaReading(5_000);
      expect(reading).toEqual({
        snapshots: [],
        unmapped: [],
        unavailable: "rate_limits absent du rapport",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mode non isolé : bypassPermissions et jauge officielle /usage", async () => {
    const init = parseStreamLine(linesOf(1, FIXTURE_UNSANDBOXED)[0] ?? "");
    expect(init).toMatchObject({ kind: "init", permissionMode: "bypassPermissions", tools: [] });
    let call = 0;
    const launcher: ClaudeLauncher = {
      isolation: () => ({ kind: "host_job", detail: "rejeu" }),
      launch: () => {
        call += 1;
        return new ReplayProcess(linesOf(call, FIXTURE_UNSANDBOXED));
      },
    };
    const dir = fs.mkdtempSync(`${fileURLToPath(new URL(".", import.meta.url))}/.replay-`);
    try {
      const adapter = new ClaudeAdapter({
        launcher,
        autonomy: "autonomous",
        hostUnsandboxedAcknowledged: () => true,
        executable: "claude",
        promptDir: dir,
        systemPrompt: "p",
        workspaceFor: () => dir,
        conversationKeyFor: () => "replay",
        tools: [],
      });
      const amounts: number[] = [];
      for (const id of ["u1", "u2"]) {
        const handle = await adapter.start(request(id));
        for await (const event of adapter.events(handle)) {
          if (event.type === "usage" && event.quantity.unit === "tokens") {
            amounts.push(event.quantity.amount);
          }
        }
      }
      expect(amounts).toEqual([577, 627]);
      const reading = await adapter.readQuotaReading(5_000);
      expect(reading.unavailable).toBeUndefined();
      expect(reading.unmapped).toEqual([]);
      expect(reading.snapshots.map((s) => [s.windowKey, s.usedBasisPoints])).toEqual([
        ["claude:session", 1300],
        ["claude:weekly_all", 4500],
        ["claude:weekly_scoped:Fable", 0],
      ]);
      expect(reading.snapshots[0]).toMatchObject({
        windowDurationMs: 5 * 3_600_000,
        resetsAt: "2026-10-29T15:59:59.713Z",
        provenance: "measured",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
