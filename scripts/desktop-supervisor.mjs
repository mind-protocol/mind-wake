/** The installed shortcuts own this watcher. Exit 0 means intentional quit/second instance. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { startLocal, nodeArgs } from "./start-local.mjs";
import { codexRuntimeEnv } from "./installation.mjs";
import { startDesktopCallHost } from "./desktop-call-host.mjs";

export function restartDelay(code, signal, failures) {
  if (code === 75 && !signal) return 0; // Explicit app restart, not a crash.
  return code === 0 && !signal ? null : Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
}
/** Intervalle de la veille du moteur. */
export const ENGINE_WATCH_MS = 60_000;
export function canStartScheduled(status) {
  return (
    status?.ok === true &&
    !status.data?.profile?.emergencyStopLocked &&
    ["ready", "hibernating"].includes(status.data?.profile?.state) &&
    status.data?.daemon?.state !== "running"
  );
}
export async function startSupervised(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const log = fs.openSync(path.join(path.dirname(manifestFile), "desktop-supervisor.log"), "a");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        m.node,
        [
          ...nodeArgs(m),
          path.join(m.repoDir, "scripts/desktop-supervisor.mjs"),
          "--manifest",
          manifestFile,
        ],
        {
          cwd: m.repoDir,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
        },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    fs.closeSync(log);
  }
}
/** `keepMode` : démarre le moteur sans `on`, le mode mémorisé (On / Always-on) est repris. */
export function startScheduled(m, { keepMode = false, run = spawnSync, spawnIt = spawnEngine } = {}) {
  const args = [path.join(m.repoDir, "dist/cli/main.js")];
  const env = { ...process.env, ...codexRuntimeEnv(m), MIND_WAKE_DATA_DIR: m.dataDir };
  const command = (verb) =>
    run(m.node, [...args, verb, "--json"], {
      env,
      cwd: m.repoDir,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
  const status = command("status");
  if (status.status !== 0 || !canStartScheduled(JSON.parse(status.stdout))) return;
  if (!keepMode) {
    const on = command("on");
    if (on.status !== 0) throw Error("Scheduled startup refused");
  }
  spawnIt(m, env);
}
/**
 * Démarrage de Windows (raccourci Startup, `--startup`). Réglage `startupMode` de
 * `installation/windows.json` : `"off"` (défaut) ou `"resume"`.
 */
export const STARTUP_MODES = ["off", "resume"];
export function startupMode(manifestFile) {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(path.dirname(manifestFile), "windows.json"), "utf8"),
    );
    return settings?.startupMode === "resume" ? "resume" : "off";
  } catch {
    return "off";
  }
}
/** Off : la pause est applicable (profil configuré, ni arrêté ni verrouillé). */
export function canStartOff(status) {
  return (
    status?.ok === true &&
    !status.data?.profile?.emergencyStopLocked &&
    ["ready", "hibernating", "running", "checkpointing", "paused"].includes(
      status.data?.profile?.state,
    )
  );
}
/**
 * Off au démarrage de Windows : Wake passe en Pause (« Éteint » dans l'app) avant que le
 * moteur ne démarre, donc aucune session (principal, forks, second fil) tant que l'humain
 * ne choisit pas On ou Always-on. Le moteur démarre quand même, en pause : il réconcilie une
 * session interrompue par l'extinction et garde les services permanents ; le bouton On ou
 * Always-on le trouve prêt. Le mode mémorisé (On / Always-on) n'est pas modifié.
 */
export function startOff(m, run = spawnSync, spawnIt = spawnEngine) {
  const args = [path.join(m.repoDir, "dist/cli/main.js")];
  const env = { ...process.env, ...codexRuntimeEnv(m), MIND_WAKE_DATA_DIR: m.dataDir };
  const command = (verb) =>
    run(m.node, [...args, verb, "--json"], {
      env,
      cwd: m.repoDir,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
  const status = command("status");
  if (status.status !== 0) throw Error("Startup status unavailable");
  const parsed = JSON.parse(status.stdout);
  if (!canStartOff(parsed)) return "unchanged";
  if (parsed.data.profile.state !== "paused") {
    const paused = command("pause");
    if (paused.status !== 0) throw Error("Startup pause refused");
  }
  if (parsed.data?.daemon?.state !== "running") spawnIt(m, env);
  return "paused";
}
/**
 * Moteur arrêté brutalement (exécution sans fin enregistrée) : on le relance, sans changer
 * de mode. Une session restée ouverte ne bloque pas : le daemon la clôt au démarrage
 * (orpheline, rien n'est rejoué). Un arrêt propre ou d'urgence n'est jamais relancé ici.
 */
export function canRestartCrashed(status) {
  return (
    status?.ok === true &&
    status.data?.daemon?.state === "crashed" &&
    !status.data?.profile?.emergencyStopLocked &&
    ["ready", "hibernating", "running", "checkpointing"].includes(status.data?.profile?.state)
  );
}
export function restartCrashedEngine(m) {
  const env = { ...process.env, ...codexRuntimeEnv(m), MIND_WAKE_DATA_DIR: m.dataDir };
  const status = spawnSync(m.node, [path.join(m.repoDir, "dist/cli/main.js"), "status", "--json"], {
    env,
    cwd: m.repoDir,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15000,
  });
  if (status.status !== 0 || !canRestartCrashed(JSON.parse(status.stdout))) return false;
  spawnEngine(m, env);
  return true;
}
function spawnEngine(m, env) {
  const log = fs.openSync(path.join(m.dataDir, "daemon.log"), "a");
  try {
    const daemon = spawn(
      m.node,
      [
        ...nodeArgs(m),
        path.join(m.repoDir, "scripts/engine-supervisor.mjs"),
        "--manifest",
        path.join(m.dataDir, "installation/manifest.json"),
      ],
      {
        env,
        cwd: m.repoDir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      },
    );
    daemon.on("error", (error) =>
      fs.appendFileSync(
        path.join(m.dataDir, "installation/desktop-supervisor.log"),
        `${new Date().toISOString()} daemon: ${error.message}\n`,
      ),
    );
    daemon.unref();
  } finally {
    fs.closeSync(log);
  }
}
/** A process can exit between spawn resolving and the owner subscribing. */
export function waitForDesktopExit(child) {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
}
export async function supervise(manifestFile, startup, launch = startLocal, createCallHost = startDesktopCallHost) {
  const log = (message) =>
    fs.appendFileSync(
      path.join(path.dirname(manifestFile), "desktop-supervisor.log"),
      `${new Date().toISOString()} ${message}\n`,
    );
  if (startup) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (startupMode(manifestFile) === "resume") startScheduled(m, { keepMode: true });
      else log(`startup: off (${startOff(m)})`);
    } catch (error) {
      log(`startup: ${error.message}`);
    }
  }
  const configured = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  // Veille du moteur : relance seulement après un arrêt brutal (voir canRestartCrashed).
  if (configured.repoDir !== undefined) {
    setInterval(() => {
      try {
        if (restartCrashedEngine(configured)) log("engine crashed; restarted");
      } catch (error) {
        log(`engine watch: ${error.message}`);
      }
    }, ENGINE_WATCH_MS).unref();
  }
  let callHost = null;
  try {
    if (configured.repoDir && configured.dataDir && configured.node)
      callHost = createCallHost(configured, log);
  } catch (error) { log(`call preload: ${error.message}`); }
  // Prepare the gateway before WebView loads its hidden call frame. This does not
  // depend on the agent daemon, so Pause and Force-off remain untouched.
  try {
  try { await callHost?.ready(); } catch (error) { log(`call preload: ${error.message}`); }
  if (configured.maintenance) {
    const { superviseDesktopMaintenance } = await import("./desktop-maintenance.mjs");
    return await superviseDesktopMaintenance(manifestFile, launch);
  }
  let failures = 0;
  for (;;) {
    const started = Date.now();
    let delay;
    try {
      const child = await launch(manifestFile, "desktop", { restart: false, supervised: true });
      log(`desktop started (${child.pid ?? "unknown"})`);
      const { code, signal } = await waitForDesktopExit(child);
      if (Date.now() - started > 60000) failures = 0;
      delay = restartDelay(code, signal, failures++);
      if (delay === null) {
        log(`desktop exited (${code ?? signal}); supervisor stopped after clean exit`);
        return;
      }
      log(`desktop exited (${code ?? signal}); restarting in ${delay}ms`);
    } catch (error) {
      delay = restartDelay(null, null, failures++);
      log(`launch failed: ${error.message}; retry in ${delay}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  } finally { callHost?.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { manifest: { type: "string" }, startup: { type: "boolean" } },
  });
  if (!values.manifest) throw Error("--manifest required");
  await supervise(path.resolve(values.manifest), values.startup === true);
}
