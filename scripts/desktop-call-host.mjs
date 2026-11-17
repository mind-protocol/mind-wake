/** Desktop-owned call gateway. Never enables Wake or starts an agent/model session. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function callPortOccupied(port = 8789) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
export async function callPageReady() {
  try {
    const response = await fetch("http://127.0.0.1:8789/desktop-call?receiver=desktop", { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const page = await response.text();
    return page.includes("<script") && page.includes("_expo/static/");
  } catch { return false; }
}

/** The watcher stays alive even when a legacy agent-owned gateway initially owns the port. */
export function startDesktopCallHost(manifest, log = () => {}) {
  const output = path.join(manifest.dataDir, "installation", "desktop-call");
  fs.mkdirSync(output, { recursive: true });
  const fd = fs.openSync(path.join(output, "host.log"), "a");
  const child = spawn(manifest.node, [path.join(manifest.repoDir, "scripts/desktop-call-host.mjs"),
    "--run", path.join(manifest.dataDir, "installation/manifest.json"), String(process.pid)], {
    cwd: manifest.repoDir, windowsHide: true, stdio: ["ignore", fd, fd],
    env: { ...process.env, MIND_WAKE_DATA_DIR: manifest.dataDir },
  });
  fs.closeSync(fd);
  child.on("error", error => log(`call host: ${error.message}`));
  return {
    async ready(timeoutMs = 12_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await callPageReady()) return true;
        if (child.exitCode !== null) break;
        await sleep(200);
      }
      log("Call preloading continues in background; see installation/desktop-call/host.log");
      return false;
    },
    stop() { child.kill(); },
  };
}

export async function watchCallGateway({ alive, occupied, start, wait = sleep, log = () => {} }) {
  let service;
  try {
    while (alive()) {
      if (!service && !(await occupied())) {
        try { service = await start(); log("Desktop call gateway ready"); }
        catch (error) { log(`Call gateway: ${error.message}`); }
      }
      await wait(2000);
    }
  } finally { await service?.close(); }
}

if (process.argv[2] === "--run") {
  const manifest = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const owner = Number(process.argv[4]);
  if (!Number.isSafeInteger(owner) || owner <= 0) throw Error("Desktop owner PID required");
  const outputDir = path.join(manifest.dataDir, "installation/desktop-call");
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  const alive = () => {
    if (stopping) return false;
    try { process.kill(owner, 0); return true; } catch { return false; }
  };
  await watchCallGateway({ alive, occupied: callPortOccupied,
    log: line => console.log(`${new Date().toISOString()} ${line}`),
    start: async () => {
      const { startWakeChat } = await import(pathToFileURL(path.join(manifest.repoDir, "lumina-prime/app/server/chat-main.mjs")).href);
      const networkFile = path.join(outputDir, "network.json");
      const network = fs.existsSync(networkFile) ? JSON.parse(fs.readFileSync(networkFile, "utf8")) : {};
      return startWakeChat({ wakeRoot: manifest.repoDir, dataDir: manifest.dataDir, outputDir,
        host: network.host ?? "127.0.0.1", hostnames: network.hostnames ?? [],
        privateNetworkConnect: network.privateNetworkConnect === true,
        origins: network.origins ?? [], port: 8789, localConnect: true });
    },
  });
}
