/**
 * Daemon en mode réel, sans aucun appel modèle : registre d'adapters, `probe`, autotest
 * de refus réel au démarrage, scheduler sur la garde de quota (déclenchement avant remise
 * à zéro), runner dans la sandbox AppContainer + Job Object. Le « runtime » est la sonde
 * native du lanceur (adapter de test non simulé). Profils AppContainer éphémères et ACE
 * de test retirés et vérifiés après chaque test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROFILE, demoDir, seedSimulatedProfile, type DemoDir } from "../../test/demo/harness.js";
import {
  GUARD,
  PROBE_ID,
  ProbeAdapter,
  snapshot,
  type ProbeAdapterOptions,
} from "../../test/fixtures/runner/probe-adapter.js";
import { SHARED_RUNTIME_DIR } from "../../test/fixtures/runner/setup.js";
import type { IsolationSelfTestReport } from "../sandbox/index.js";
import { ephemeralProfileName, runIsolationSelfTest, Sandbox } from "../sandbox/index.js";
import { openStoreReadOnly } from "../store/index.js";
import { DaemonError, WakeDaemon } from "./daemon.js";
import { latestSelfTest } from "./isolation.js";
import { artifactsDirFor, controlDbPath, workspaceDirFor } from "./paths.js";
import { AdapterRegistry, FAKE_REGISTRATION, type AdapterRegistration } from "./registry.js";
import { latestDaemonRun } from "./runs.js";

const WINDOWS = process.platform === "win32";
const TIMEOUT = 90_000;

describe.runIf(WINDOWS)("daemon en mode réel (adapter de test non simulé)", () => {
  let base: string;
  let runtime: string;
  let outside: string;
  let probeExe: string;
  let dir: DemoDir;
  let sandbox: Sandbox;
  let probeAvailable: boolean;
  let quotaUsed: number;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-daemon-real-"));
    runtime = path.join(base, "runtime");
    outside = path.join(base, "outside");
    for (const d of [runtime, outside]) fs.mkdirSync(d);
    const builder = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    if (!builder.status.available) throw new Error(builder.status.reason);
    probeExe = path.join(runtime, "probe.exe");
    fs.copyFileSync(builder.status.launcherPath, probeExe);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(fs.existsSync(base)).toBe(false);
  });

  beforeEach(() => {
    dir = demoDir("mind-wake-real-");
    seedSimulatedProfile(dir.path, { runtimeAdapterId: PROBE_ID, subscriptionQuota: GUARD });
    sandbox = new Sandbox(path.join(base, "build"), ephemeralProfileName("mindwake.test"));
    probeAvailable = true;
    quotaUsed = 2_000;
  });

  afterEach(() => {
    const artifacts = artifactsDirFor(dir.path);
    const roots = { readWrite: fs.existsSync(artifacts) ? [artifacts] : [], readOnly: [runtime] };
    sandbox.revoke(roots);
    expect(sandbox.aclStatus(roots).filter((a) => a.granted)).toEqual([]);
    expect(sandbox.deleteProfile()).toMatchObject({
      exists: false,
      registryMapping: false,
      folder: false,
    });
    dir.remove();
  });

  let lastAdapter: ProbeAdapter | null = null;

  function registry(options: Partial<ProbeAdapterOptions> = {}): AdapterRegistry {
    const registration: AdapterRegistration = {
      id: PROBE_ID,
      simulated: false,
      runtime: () => ({ adapterId: PROBE_ID, provider: "none", model: "none", authMode: "none" }),
      billing: () => ({ kind: "subscription_quota" }),
      runtimeRoots: () => [runtime],
      create: (context) => {
        const adapter = new ProbeAdapter(context.host, {
          executable: probeExe,
          args: [
            "probe",
            `write:${path.join(artifactsDirFor(dir.path), "inside.txt")}`,
            `write:${path.join(outside, "escape.txt")}`,
            `write:${controlDbPath(dir.path)}`,
          ],
          unattended: true,
          quota: () => [snapshot(quotaUsed)],
          ...options,
        });
        lastAdapter = adapter;
        const probe = adapter.probe.bind(adapter);
        adapter.probe = async () => ({
          ...(await probe()),
          available: probeAvailable,
          ...(probeAvailable ? {} : { unavailableReason: "CLI absent (banc)" }),
        });
        return adapter;
      },
    };
    return new AdapterRegistry([FAKE_REGISTRATION, registration]);
  }

  async function openReal(
    selfTest: () => Promise<IsolationSelfTestReport> = () => runIsolationSelfTest(),
  ): Promise<WakeDaemon> {
    return WakeDaemon.open({
      dataDir: dir.path,
      profileId: PROFILE,
      simulated: false,
      registry: registry(),
      isolation: { sandbox, selfTest },
      runtimeDir: SHARED_RUNTIME_DIR,
      recheckIntervalMs: 1_000,
      exitAfterSessions: 1,
    });
  }

  it(
    "autotest réel, déclenchement sur la jauge, session confinée de bout en bout",
    async () => {
      const daemon = await openReal();
      expect(daemon.simulated).toBe(false);
      const summary = await daemon.run();
      expect(summary.sessions).toHaveLength(1);
      expect(summary.sessions[0]).toMatchObject({ outcome: "completed", isolation: "sandbox" });
      expect(fs.readFileSync(path.join(artifactsDirFor(dir.path), "inside.txt"), "utf8")).toContain(
        "mindwake-probe",
      );
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);

      const store = openStoreReadOnly(controlDbPath(dir.path));
      try {
        const selfTest = latestSelfTest(store.db, PROFILE);
        expect(selfTest).toMatchObject({ passed: true, cleanupVerified: true, failed: [] });
        expect(latestDaemonRun(store.db, PROFILE)).toMatchObject({
          mode: "real",
          adapterId: PROBE_ID,
        });
        const events = store.uow.journal.list(PROFILE);
        expect(events.find((e) => e.type === "daemon_started")?.metadata).toMatchObject({
          mode: "real",
          isolation: "sandbox",
        });
        // Aucune enveloppe de tokens propre à Wake : la garde de quota borne la session.
        expect(events.find((e) => e.type === "budget_reserved")?.metadata).toMatchObject({
          maxima: [expect.objectContaining({ unit: "sessions" })],
        });
        expect(events.findLast((e) => e.type === "session_ended")?.metadata).toMatchObject({
          isolation: "sandbox",
          aclRevoked: true,
          simulated: false,
        });
      } finally {
        store.close();
      }
      expect(fs.existsSync(workspaceDirFor(dir.path))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "autotest de refus en échec : aucune session, profil bloqué avec motif",
    async () => {
      const failed: IsolationSelfTestReport = {
        passed: false,
        platform: "win32",
        profile: null,
        checks: [
          {
            id: "write_outside_root",
            expected: "denied",
            outcome: "allowed",
            code: 0,
            passed: false,
          },
        ],
        termination: null,
        cleanup: { aclRemoved: true, profileRemoved: true, tempRemoved: true },
        notDemonstrated: [],
        durationMs: 1,
      };
      const daemon = await openReal(() => Promise.resolve(failed));
      const running = daemon.run();
      const deadline = Date.now() + 15_000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        const store = openStoreReadOnly(controlDbPath(dir.path));
        try {
          const profile = store.uow.profiles.get(PROFILE);
          state = profile?.state;
          if (state === "blocked") {
            expect(profile?.stateReason).toMatch(/^sandbox_unavailable/);
            break;
          }
        } finally {
          store.close();
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      daemon.requestStop("fin du test");
      const summary = await running;
      expect(state).toBe("blocked");
      expect(summary.sessions).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "mode non isolé consenti : session sur l'hôte, ni sandbox ni autotest exigés",
    async () => {
      dir.remove();
      dir = demoDir("mind-wake-host-");
      seedSimulatedProfile(dir.path, {
        runtimeAdapterId: PROBE_ID,
        subscriptionQuota: GUARD,
        hostUnsandboxed: true,
      });
      // Demande de réveil déposée par l'agent lors d'une session précédente.
      const wakeupsDir = path.join(workspaceDirFor(dir.path), "wakeups");
      fs.mkdirSync(wakeupsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wakeupsDir, "retest.json"),
        JSON.stringify({
          version: 1,
          id: "retest-rule-110",
          when: { at: "2026-01-01T00:00:00Z" },
          prompt: "Re-run the rule 110 test and compare.",
        }),
      );
      const lines: string[] = [];
      const daemon = await WakeDaemon.open({
        theme: "small emergent systems",
        dataDir: dir.path,
        profileId: PROFILE,
        simulated: false,
        registry: registry(),
        runtimeDir: SHARED_RUNTIME_DIR,
        recheckIntervalMs: 1_000,
        exitAfterSessions: 1,
        log: (line) => lines.push(line),
      });
      const summary = await daemon.run();
      expect(summary.sessions[0]).toMatchObject({
        outcome: "completed",
        isolation: "host_unsandboxed",
      });
      expect(lines.some((l) => l.startsWith("[NON ISOLÉ]"))).toBe(true);
      // Prompt de réveil composé et transmis par `context`, note de l'agent en place de relance.
      const context = lastAdapter?.context ?? "";
      expect(context).toContain("You are waking up in MIND Wake");
      expect(context).toContain(`Your space: ${workspaceDirFor(dir.path)}.`);
      expect(context).toContain("NOT ISOLATED");
      expect(context).toContain("small emergent systems");
      expect(context).toContain("> Re-run the rule 110 test and compare.");
      expect(context).not.toMatch(/\{\{[a-z_]+\}\}/);
      expect(fs.existsSync(path.join(wakeupsDir, "retest.json"))).toBe(false);
      expect(fs.existsSync(path.join(wakeupsDir, "schema", "agent-wakeup.schema.json"))).toBe(true);
      const store = openStoreReadOnly(controlDbPath(dir.path));
      try {
        expect(latestSelfTest(store.db, PROFILE)).toBeNull();
        const events = store.uow.journal.list(PROFILE);
        expect(events.find((e) => e.type === "daemon_started")?.metadata).toMatchObject({
          isolation: "host_unsandboxed",
        });
        expect(events.findLast((e) => e.type === "session_ended")?.metadata).toMatchObject({
          isolation: "host_unsandboxed",
        });
      } finally {
        store.close();
      }
    },
    TIMEOUT,
  );

  it("refuse un adapter enregistré que probe dit indisponible, sans repli", async () => {
    probeAvailable = false;
    const refused = await openReal().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonError);
    expect(refused).toMatchObject({ code: "adapter_unavailable" });
    expect((refused as Error).message).toMatch(/CLI absent/);
  });
});
