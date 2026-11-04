import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Optional owner-configured sidecar; no credentials in arguments or environment. */
export async function ensureTelegram(m) {
  const file = path.join(m.dataDir, "telegram.json");
  if (!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, "utf8")).enabled !== true)
    return null;
  const lock = path.join(m.dataDir, "telegram.pid");
  try {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid > 0) {
      process.kill(pid, 0);
      return pid;
    }
  } catch {}
  const stdout = fs.openSync(path.join(m.dataDir, "telegram.stdout.log"), "a");
  const stderr = fs.openSync(path.join(m.dataDir, "telegram.stderr.log"), "a");
  try {
    const child = spawn(
      m.node ?? process.execPath,
      [path.join(m.repoDir, "scripts/telegram-bridge.mjs"), m.dataDir],
      {
        cwd: m.repoDir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr],
      },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(JSON.stringify({ pid: await ensureTelegram(manifest) }));
}
