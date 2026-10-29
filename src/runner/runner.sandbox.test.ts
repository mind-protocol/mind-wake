/**
 * Runner branché sur la sandbox réelle (S10 → runner, ADR-003, ADR-005) : un adapter
 * non simulé lance un petit exécutable de test (la sonde native du lanceur, aucun modèle)
 * dans l'AppContainer + Job Object, avec les racines de la policy. Refus réels du système,
 * mode sans approbation refusé hors sandbox, garde de quota relue pendant la session.
 * Profils AppContainer éphémères et ACE de test retirés et vérifiés après chaque test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE,
  REVISION,
  allowDecision,
  favorableChecks,
  prepareProfile,
  tempDir,
  type PolicyOverrides,
} from "../../test/fixtures/runner/setup.js";
import { SHARED_RUNTIME_DIR } from "../../test/fixtures/runner/setup.js";
import {
  GUARD,
  PROBE_ID,
  ProbeAdapter,
  snapshot,
  utcNow,
  type ProbeAdapterOptions,
} from "../../test/fixtures/runner/probe-adapter.js";
import type { BudgetQuantity, ReservationId, SessionId, UtcTimestamp } from "../contracts/index.js";
import { ephemeralProfileName, Sandbox } from "../sandbox/index.js";
import { openStore, type Store } from "../store/index.js";
import { ProcessTreeSupervisor } from "./process-tree.js";
import { RunnerError, SessionRunner, type LaunchGrant, type RunnerOptions } from "./runner.js";
import { StopFlag } from "./controls.js";
import type { RunnerSandbox } from "./sandboxing.js";

const WINDOWS = process.platform === "win32";
const TIMEOUT = 60_000;

let counter = 0;

/** Réservation de session, comme après `decideLaunch` et `ledger.reserve`. */
function reserve(
  store: Store,
  maxima: readonly BudgetQuantity[],
  onSubscription = false,
): LaunchGrant {
  counter += 1;
  const sessionId = `sandbox-${String(process.pid)}-${String(counter)}` as SessionId;
  const reservationId = `reservation-${sessionId}` as ReservationId;
  const at = utcNow();
  const revision = store.uow.policies.getRevision(REVISION);
  if (revision === null) throw new Error("révision absente");
  const period = store.uow.ledger.ensurePeriod(PROFILE, revision.groups.budget.period, at, [
    { unit: "tokens", cap: 10_000, userReserve: 2_000 },
    { unit: "sessions", cap: 5, userReserve: 0 },
  ]);
  const reserved = store.uow.ledger.reserve({
    id: reservationId,
    sessionId,
    profileId: PROFILE,
    periodIds: [period.id],
    maxima,
    at,
  });
  if (reserved.status !== "reserved") throw new Error(`réservation refusée : ${reserved.detail}`);
  return {
    profileId: PROFILE,
    sessionId,
    experimentId: null,
    reservationId,
    decision: allowDecision(),
    context: "contexte borné de test",
    maxInputTokens: 1_000,
    onSubscription,
  };
}

/** Lancement refusé avant toute session : la réservation est close, à sa borne maximale. */
function release(store: Store, grant: LaunchGrant): void {
  store.uow.ledger.markUncertain(grant.reservationId, utcNow());
}

const TOKENS_AND_SESSION: readonly BudgetQuantity[] = [
  { unit: "tokens", amount: 3_000 },
  { unit: "sessions", amount: 1 },
];

describe.runIf(WINDOWS)("runner sous sandbox réelle (AppContainer + Job Object)", () => {
  let base: string;
  let runtime: string;
  let outside: string;
  let secret: string;
  let probeExe: string;
  let data: { path: string; remove(): void };
  let store: Store;
  let sandbox: Sandbox;
  let readiness: { ok: boolean; detail: string };
  let adapter: ProbeAdapter | null;
  /** Décalage de l'horloge du daemon (lecture de jauge qui vieillit). */
  let skewMs = 0;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-runner-sandbox-"));
    runtime = path.join(base, "runtime");
    outside = path.join(base, "outside");
    for (const dir of [runtime, outside]) fs.mkdirSync(dir);
    secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret factice de test\n");
    const builder = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    if (!builder.status.available) throw new Error(builder.status.reason);
    // Le petit exécutable de test : copie du lanceur, en mode sonde.
    probeExe = path.join(runtime, "probe.exe");
    fs.copyFileSync(builder.status.launcherPath, probeExe);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(fs.existsSync(base)).toBe(false);
  });

  function open(overrides: PolicyOverrides = {}): void {
    data = tempDir();
    store = openStore(path.join(data.path, "control.sqlite"));
    prepareProfile(store.uow, { runtime: { adapterId: PROBE_ID }, ...overrides });
    sandbox = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    sandbox.ensureProfile();
    readiness = { ok: true, detail: "autotest de refus réussi (banc)" };
    adapter = null;
    skewMs = 0;
  }

  beforeEach(() => {
    open();
  });

  afterEach(() => {
    // Nettoyage vérifié après chaque test, qu'il ait réussi ou échoué.
    const workspace = path.join(data.path, "workspace");
    const notes = path.join(workspace, "notes");
    const roots = {
      readWrite: fs.existsSync(notes) ? [notes] : [],
      readOnly: [runtime],
    };
    sandbox.revoke(roots);
    expect(sandbox.aclStatus(roots).filter((a) => a.granted)).toEqual([]);
    expect(sandbox.deleteProfile()).toMatchObject({
      exists: false,
      registryMapping: false,
      folder: false,
    });
    store.close();
    data.remove();
  });

  function runnerSandbox(): RunnerSandbox {
    return {
      ready: () => readiness,
      launch: (spec) => sandbox.launch(spec),
      workspaceDir: path.join(data.path, "workspace"),
      runtimeRoots: [runtime],
      protectedPaths: [path.join(data.path, "control.sqlite"), data.path],
    };
  }

  function runner(
    options: ProbeAdapterOptions,
    extra: { sandbox?: boolean; runner?: Partial<RunnerOptions> } = {},
  ): SessionRunner {
    return new SessionRunner({
      uow: store.uow,
      profileId: PROFILE,
      supervisor: new ProcessTreeSupervisor(SHARED_RUNTIME_DIR),
      ...(extra.sandbox === false ? {} : { sandbox: runnerSandbox() }),
      stopFlag: new StopFlag(data.path),
      adapter: (host) => {
        adapter = new ProbeAdapter(host, options);
        return adapter;
      },
      // Horloge du daemon et signal de priorité observés sur la même horloge décalable.
      now: () => new Date(Date.now() + skewMs),
      liveChecks: () => ({
        ...favorableChecks(),
        userPriority: {
          favorable: true,
          observedAt: new Date(Date.now() + skewMs).toISOString() as UtcTimestamp,
        },
      }),
      ...(extra.runner === undefined ? {} : { options: extra.runner }),
    });
  }

  function probeAdapter(): ProbeAdapter {
    if (adapter === null) throw new Error("adapter non construit");
    return adapter;
  }

  it(
    "lance l'exécutable confiné : racine de la policy accordée, tout le reste refusé par le système",
    async () => {
      const notes = path.join(data.path, "workspace", "notes");
      const r = runner({
        executable: probeExe,
        args: [
          "probe",
          `write:${path.join(notes, "inside.txt")}`,
          `write:${path.join(outside, "escape.txt")}`,
          `read:${secret}`,
          `write:${path.join(data.path, "control.sqlite")}`,
          `read:${path.join(data.path, "control.sqlite")}`,
          "env:MIND_WAKE_FAKE_SECRET",
        ],
        unattended: true,
      });
      process.env["MIND_WAKE_FAKE_SECRET"] = "ne-doit-pas-passer";
      try {
        const result = await (await r.launch(reserve(store, TOKENS_AND_SESSION))).done;
        expect(result).toMatchObject({ outcome: "completed", isolation: "sandbox" });
      } finally {
        delete process.env["MIND_WAKE_FAKE_SECRET"];
      }
      const a = probeAdapter();
      expect(a.op("write", "inside.txt")).toMatchObject({ ok: true, code: 0 });
      expect(fs.readFileSync(path.join(notes, "inside.txt"), "utf8")).toContain("mindwake-probe");
      expect(a.op("write", "escape.txt")).toMatchObject({ ok: false, code: 5 });
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
      expect(a.op("read", "secret.txt")).toMatchObject({ ok: false, code: 5 });
      expect(a.lines.filter((l) => l.arg.includes("control.sqlite"))).toEqual([
        expect.objectContaining({ op: "write", ok: false, code: 5 }),
        expect.objectContaining({ op: "read", ok: false, code: 5 }),
      ]);
      expect(a.op("env")?.ok).toBe(false);
      const ended = store.uow.journal.list(PROFILE).findLast((e) => e.type === "session_ended");
      expect(ended?.metadata).toMatchObject({ isolation: "sandbox", aclRevoked: true });
      expect(
        store.uow.journal.list(PROFILE).find((e) => e.type === "session_started")?.metadata,
      ).toMatchObject({ isolation: "sandbox", simulated: false });
    },
    TIMEOUT,
  );

  it(
    "refuse un adapter réel sans sandbox, ou tant que l'autotest n'a pas réussi",
    async () => {
      const options = { executable: probeExe, args: ["probe", "sleep:10"] };
      const first = reserve(store, TOKENS_AND_SESSION);
      await expect(runner(options, { sandbox: false }).launch(first)).rejects.toMatchObject({
        code: "sandbox_unavailable",
      });
      release(store, first);
      readiness = { ok: false, detail: "autotest de refus jamais exécuté" };
      const second = reserve(store, TOKENS_AND_SESSION);
      await expect(runner(options).launch(second)).rejects.toThrow(
        /autotest de refus jamais exécuté/,
      );
      release(store, second);
      expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
      expect(store.uow.profiles.get(PROFILE)?.state).toBe("ready");
    },
    TIMEOUT,
  );

  it(
    "refuse le mode sans approbation hors sandbox (adapter simulé, Job Object seul)",
    async () => {
      const r = runner(
        { executable: probeExe, args: ["probe", "sleep:10"], unattended: true, simulated: true },
        { sandbox: false },
      );
      const result = await (await r.launch(reserve(store, TOKENS_AND_SESSION))).done;
      expect(result).toMatchObject({ outcome: "failed", isolation: "job_only" });
      expect(result.reason).toMatch(/unattended|sans approbation/);
      expect(probeAdapter().process).toBeNull();
      const denied = store.uow.journal
        .list(PROFILE)
        .filter((e) => e.type === "action_denied")
        .map((e) => e.metadata);
      expect(denied).toContainEqual(
        expect.objectContaining({ detail: "runner.unattended_outside_sandbox" }),
      );
    },
    TIMEOUT,
  );

  it("refuse une réservation sans borne de tokens hors voie abonnement", async () => {
    const r = runner({ executable: probeExe, args: ["probe", "sleep:10"] });
    const grant = reserve(store, [{ unit: "sessions", amount: 1 }]);
    const refused = await r.launch(grant).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunnerError);
    expect(refused).toMatchObject({ code: "reservation_unbounded" });
    expect(store.uow.sessions.listOpen(PROFILE)).toHaveLength(0);
  });

  describe("mode non isolé consenti (ADR-006)", () => {
    beforeEach(() => {
      sandbox.deleteProfile();
      store.close();
      data.remove();
      open({ runtime: { adapterId: PROBE_ID, hostUnsandboxedAcknowledged: true } });
    });

    it(
      "lance sur l'hôte dans un Job Object, sans sandbox, mode sans approbation permis",
      async () => {
        const escape = path.join(outside, `host-${String(process.pid)}.txt`);
        const r = runner(
          { executable: probeExe, args: ["probe", `write:${escape}`], unattended: true },
          { sandbox: false },
        );
        const result = await (await r.launch(reserve(store, TOKENS_AND_SESSION))).done;
        expect(result).toMatchObject({ outcome: "completed", isolation: "host_unsandboxed" });
        // Non isolé : l'écriture hors de l'espace d'exploration réussit (ADR-006).
        expect(probeAdapter().op("write")).toMatchObject({ ok: true, code: 0 });
        fs.rmSync(escape, { force: true });
        const started = store.uow.journal.list(PROFILE).find((e) => e.type === "session_started");
        expect(started?.reason).toMatch(/NON ISOLÉE/);
        expect(started?.metadata).toMatchObject({ isolation: "host_unsandboxed" });
      },
      TIMEOUT,
    );

    it(
      "arrêt d'urgence : l'arborescence hôte est terminée sans coopération",
      async () => {
        const r = runner(
          { executable: probeExe, args: ["probe", "sleep:60000"], unattended: true },
          { sandbox: false },
        );
        const running = await r.launch(reserve(store, TOKENS_AND_SESSION));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stop = await r.stop();
        expect(stop.termination).toMatchObject({ confirmed: true });
        expect(stop.termination?.elapsedMs).toBeLessThan(1_000);
        const result = await running.done;
        expect(result).toMatchObject({ outcome: "interrupted", reason: "kill_switch" });
      },
      TIMEOUT,
    );
  });

  describe("voie abonnement : jauge relue pendant la session", () => {
    beforeEach(() => {
      // Remplace le banc par défaut : la policy porte la garde de quota.
      sandbox.deleteProfile();
      store.close();
      data.remove();
      open({ budget: { subscriptionQuota: GUARD } });
    });

    it(
      "interrompt au seuil d'arrêt et termine l'arborescence confinée",
      async () => {
        let used = 2_000;
        const r = runner(
          {
            executable: probeExe,
            args: ["probe", "sleep:60000"],
            unattended: true,
            quota: () => [snapshot(used)],
          },
          { runner: { quotaPollIntervalMs: 50, checkpointGraceMs: 200 } },
        );
        const running = await r.launch(reserve(store, [{ unit: "sessions", amount: 1 }], true));
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(r.activeSessionId).toBe(running.sessionId);
        used = 8_000;
        const result = await running.done;
        expect(result).toMatchObject({
          outcome: "interrupted",
          isolation: "sandbox",
          profileState: "hibernating",
        });
        expect(result.reason).toBe(
          "policy.budget_exhausted: subscription.stop_threshold_reached: primary used_bp=8000",
        );
        expect(result.termination?.confirmed).toBe(true);
        expect(result.tokens).toBe(0);
      },
      TIMEOUT,
    );

    it(
      "interrompt quand la lecture se périme pendant la session",
      async () => {
        const frozen = utcNow();
        const stale = runner(
          {
            executable: probeExe,
            args: ["probe", "sleep:60000"],
            quota: () => [snapshot(1_000, frozen)],
          },
          { runner: { quotaPollIntervalMs: 50, checkpointGraceMs: 200 } },
        );
        const running = await stale.launch(reserve(store, [{ unit: "sessions", amount: 1 }], true));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(stale.activeSessionId).toBe(running.sessionId);
        // L'adapter ne rapporte plus de lecture fraîche : elle dépasse maxSnapshotAgeMs.
        skewMs = GUARD.enabled ? GUARD.maxSnapshotAgeMs + 1_000 : 0;
        const result = await running.done;
        skewMs = 0;
        expect(result.outcome).toBe("interrupted");
        expect(result.reason).toMatch(/budget_unknown: subscription\.snapshot_stale: primary/);
        expect(result.termination?.confirmed).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "interrompt sans lecture de jauge, jamais en aveugle",
      async () => {
        const absent = runner(
          { executable: probeExe, args: ["probe", "sleep:60000"], quota: () => [] },
          { runner: { quotaPollIntervalMs: 50, checkpointGraceMs: 200 } },
        );
        const second = await (
          await absent.launch(reserve(store, [{ unit: "sessions", amount: 1 }], true))
        ).done;
        expect(second.outcome).toBe("interrupted");
        expect(second.reason).toMatch(/budget_unknown: subscription\.quota_unknown/);
      },
      TIMEOUT,
    );
  });
});
