/**
 * Codex RÉEL confiné dans l'AppContainer (S10), désactivé par défaut :
 * `MIND_WAKE_SANDBOX_CODEX=1`. Aucun appel modèle possible : sans broker, le conteneur n'a
 * aucun réseau, et le `CODEX_HOME` dédié est vide (aucune connexion). Le test vérifie que
 * `codex app-server` démarre sous le profil AppContainer, que le JSON-RPC passe par les
 * pipes du lanceur et que l'adapter s'arrête sur `auth_failed` avant tout fil.
 *
 * Effets temporaires, tous retirés : profil AppContainer éphémère, copie du binaire Codex
 * (≈ 350 Mo) dans une racine en lecture seule, dossiers sous `%TEMP%`.
 *
 * Variable facultative : `MIND_WAKE_CODEX_BIN` (sinon `where codex`).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdapterEvent,
  PolicyRevision,
  ProfileId,
  ReservationId,
  SessionId,
  StartRequest,
  UtcTimestamp,
} from "../../contracts/index.js";
import { ephemeralProfileName, Sandbox } from "../../sandbox/sandbox.js";
import { sandboxSourceDigest } from "../../sandbox/build.js";
import { runIsolationSelfTest } from "../../sandbox/self-test.js";
import {
  appContainerLauncher,
  CODEX_SUPPORTED_VERSION,
  CodexAdapter,
  MemoryThreadStore,
  parseCodexVersion,
} from "./index.js";

const ENABLED = process.env["MIND_WAKE_SANDBOX_CODEX"] === "1" && process.platform === "win32";

function codexBinDir(): string {
  const given = process.env["MIND_WAKE_CODEX_BIN"];
  const exe =
    given ??
    execFileSync("where", ["codex"], { encoding: "utf8" })
      .split(/\r?\n/)
      .find((l) => l.toLowerCase().endsWith(".exe"))
      ?.trim();
  if (exe === undefined) throw new Error("codex.exe introuvable");
  return path.dirname(fs.realpathSync.native(exe));
}

describe.skipIf(!ENABLED)(
  "Codex réel dans l'AppContainer (opt-in MIND_WAKE_SANDBOX_CODEX=1)",
  () => {
    it("démarre confiné, répond en JSON-RPC et s'arrête sans compte ni réseau", async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-codex-sandbox-"));
      const dirs = {
        build: path.join(base, "build"),
        runtime: path.join(base, "runtime"),
        codexHome: path.join(base, "codex-home"),
        workspace: path.join(base, "workspace"),
        control: path.join(base, "control"),
      };
      for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
      for (const name of fs.readdirSync(codexBinDir())) {
        if (name.toLowerCase().endsWith(".exe")) {
          fs.copyFileSync(path.join(codexBinDir(), name), path.join(dirs.runtime, name));
        }
      }
      const binary = path.join(dirs.runtime, "codex.exe");
      const version =
        parseCodexVersion(execFileSync(binary, ["--version"], { encoding: "utf8" })) ?? "inconnue";

      const report = await runIsolationSelfTest();
      const sandbox = new Sandbox(dirs.build, ephemeralProfileName("mindwake.codextest"));
      const timings: Record<string, number> = {};
      try {
        sandbox.ensureProfile();
        const launcher = appContainerLauncher({
          sandbox,
          launcherDigest: sandboxSourceDigest(),
          selfTest: { passed: report.passed, launcherDigest: sandboxSourceDigest() },
          jobName: () => `Local\\mindwake-codextest-${randomBytes(8).toString("hex")}`,
          readWriteRoots: [dirs.workspace, dirs.codexHome],
          readOnlyRoots: [dirs.runtime],
          protectedPaths: [dirs.control],
          maxProcesses: 32,
          memoryLimitMb: 4_096,
          maxWallMs: 120_000,
        });
        expect(launcher.isolation("s" as SessionId)).toMatchObject({
          confined: true,
          selfTestPassed: true,
        });

        const adapter = new CodexAdapter({
          executable: { path: binary },
          codexHome: dirs.codexHome,
          workspaceDir: dirs.workspace,
          // Version installée non validée : admise en mode manuel seulement. Le confinement
          // vérifié donne quand même le mode sans approbation (danger-full-access).
          mode: "manual",
          acceptedVersions: [CODEX_SUPPORTED_VERSION, version],
          launcher,
          // Transport fermé : aucun broker, donc aucun réseau dans le conteneur.
          transport: {
            open: () =>
              Promise.resolve({ configOverrides: {}, env: {}, close: () => Promise.resolve() }),
          },
          threads: new MemoryThreadStore(),
          systemPrompt: "Test de confinement MIND Wake.",
          requestTimeoutMs: 60_000,
        });

        const request: StartRequest = {
          sessionId: `sandbox-${String(Date.now())}` as SessionId,
          reservationId: "sandbox" as ReservationId,
          policy: { profileId: "sandbox" as ProfileId } as PolicyRevision,
          context: "Réponds seulement OK",
          maxInputTokens: 1_000,
          deadline: new Date(Date.now() + 120_000).toISOString() as UtcTimestamp,
        };
        const begin = performance.now();
        const handle = await adapter.start(request);
        timings["start"] = performance.now() - begin;
        const events: AdapterEvent[] = [];
        for await (const event of adapter.events(handle)) events.push(event);
        timings["ended"] = performance.now() - begin;

        console.log(JSON.stringify({ version, timings, events }, null, 2));
        expect(events.find((e) => e.type === "error")).toMatchObject({ code: "auth_failed" });
        expect(events.at(-1)).toMatchObject({ type: "ended", exitReason: "auth_required" });
        // Codex a écrit son état dans le CODEX_HOME dédié, dans le conteneur.
        expect(fs.readdirSync(dirs.codexHome).length).toBeGreaterThan(0);
      } finally {
        const status = sandbox.deleteProfile();
        expect(status.exists).not.toBe(true);
        fs.rmSync(base, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
