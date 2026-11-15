/**
 * Veille autonome, pour une installation dont le superviseur du desktop est plus ancien que la
 * veille du moteur (`restartCrashedEngine`). Toutes les minutes :
 * - relance le moteur après un arrêt brutal, avec les mêmes règles que le desktop
 *   (`canRestartCrashed` : jamais après Force-off ni un arrêt voulu) ;
 * - relance le worker des forks si un fork est activé et qu'aucun worker ne tourne.
 * Une seule veille par installation (`engine-watchdog.json`). Arrêt : tuer son processus.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { restartCrashedEngine } from "./desktop-supervisor.mjs";

const { values } = parseArgs({ options: { manifest: { type: "string" } } });
if (!values.manifest) throw Error("--manifest required");
const manifestFile = path.resolve(values.manifest);
const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const lockFile = path.join(m.dataDir, "engine-watchdog.json");
const log = (line) =>
  fs.appendFileSync(
    path.join(path.dirname(manifestFile), "desktop-supervisor.log"),
    `${new Date().toISOString()} watchdog: ${line}\n`,
  );

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
try {
  const prior = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (prior.pid !== process.pid && alive(prior.pid)) process.exit(0);
} catch {
  // Pas de veille précédente.
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

const cli = path.join(m.repoDir, "dist/cli/main.js");
const env = { ...process.env, MIND_WAKE_DATA_DIR: m.dataDir };

function forkWorker() {
  const status = spawnSync(m.node, [cli, "forks", "status", "--json", "--data-dir", m.dataDir], {
    env,
    cwd: m.repoDir,
    windowsHide: true,
    encoding: "utf8",
    timeout: 20000,
  });
  if (status.status !== 0) return;
  const data = JSON.parse(status.stdout).data;
  if (data.running || data.profile !== "run" || !data.forks.some((f) => f.enabled)) return;
  const out = fs.openSync(path.join(m.dataDir, "forks.log"), "a");
  try {
    spawn(m.node, [cli, "forks", "run", "--data-dir", m.dataDir], {
      env,
      cwd: m.repoDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
    }).unref();
    log("fork worker absent; restarted");
  } finally {
    fs.closeSync(out);
  }
}

function check() {
  try {
    if (restartCrashedEngine(m)) log("engine crashed; restarted");
  } catch (error) {
    log(`engine: ${error.message}`);
  }
  try {
    forkWorker();
  } catch (error) {
    log(`forks: ${error.message}`);
  }
}
log(`started (pid ${String(process.pid)})`);
check();
setInterval(check, 60_000);
