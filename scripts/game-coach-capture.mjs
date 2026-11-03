/** Native Computer Use consumer. No collector, detached process or screenshot helper. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const ownedName = /^coach-(\d{13})-([a-f0-9-]{36})\.png$/;
const markerText = "mind-wake-game-coach-history-v1\n";
const limit = 40;

async function directory(dataDir) {
  if (!path.isAbsolute(dataDir)) throw new Error("dataDir must be absolute");
  const base = await fs.realpath(dataDir);
  const dir = path.join(base, "screen-history");
  let created = false;
  try {
    await fs.mkdir(dir);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if ((await fs.lstat(dir)).isSymbolicLink() || (await fs.realpath(dir)) !== dir)
    throw new Error("screen-history must be a real private directory");
  const marker = path.join(dir, ".game-coach-history");
  if (created) await fs.writeFile(marker, markerText, { flag: "wx", mode: 0o600 });
  if (
    (await fs.lstat(marker)).isSymbolicLink() ||
    (await fs.readFile(marker, "utf8")) !== markerText
  )
    throw new Error("Unrecognized screen-history ownership marker");
  return dir;
}

async function entries(dir) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const match = ownedName.exec(entry.name);
    if (!match) continue;
    const file = path.join(dir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe managed history entry");
    rows.push({ file, capturedAt: new Date(Number(match[1])).toISOString() });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  // The durable index preserves insertion order even if the wall clock moves back.
  const indexPath = path.join(dir, "index.json");
  try {
    if ((await fs.lstat(indexPath)).isSymbolicLink()) throw new Error("Unsafe history index");
    const saved = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.frames))
      throw new Error("Invalid history index");
    const remaining = new Map(rows.map((row) => [row.file, row]));
    const ordered = [];
    for (const row of saved.frames) {
      if (remaining.has(row.file)) {
        ordered.push(remaining.get(row.file));
        remaining.delete(row.file);
      }
    }
    return [...ordered, ...remaining.values()];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return rows;
  }
}

/** Only files with our exact name format in our marked directory may be removed. */
export async function saveCoachFrame({ dataDir, url, capturedAt }) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  const stamp = Date.parse(capturedAt);
  if (!match || !Number.isSafeInteger(stamp) || stamp < 0 || stamp > 9999999999999)
    throw new Error("Expected a timestamped native PNG");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("Screenshot is not a PNG");
  const dir = await directory(dataDir);
  const lockPath = path.join(dir, ".write-lock");
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    const prior = await entries(dir);
    while (prior.length >= limit) await fs.unlink(prior.shift().file);
    const file = path.join(dir, `coach-${String(stamp).padStart(13, "0")}-${randomUUID()}.png`);
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const index = [...prior, { file, capturedAt }];
    const temporary = path.join(dir, `.index-${randomUUID()}.tmp`);
    await fs.writeFile(
      temporary,
      JSON.stringify({ version: 1, limit, frames: index }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(temporary, path.join(dir, "index.json"));
    return { frame: { file, capturedAt }, index, indexPath: path.join(dir, "index.json") };
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

/** guard must consult current runtime stop/pause and the known authorized game surface.
 * Native sky calls automatically display the four images in node_repl. Do not emit twice.
 * Abort/Computer Use errors propagate immediately; never retry after Escape.
 */
export async function captureCoachBatch({
  sky,
  window,
  dataDir,
  guard,
  signal,
  intervalMs = 5000,
  clock = () => performance.now(),
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof guard !== "function" || !window?.app || !Number.isInteger(window.id))
    throw new Error("A returned native game window and a live authorization guard are required");
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
    throw new Error("intervalMs must be 1000..60000");
  const check = async () => {
    signal?.throwIfAborted();
    if ((await guard(window)) !== true)
      throw new Error("Game coaching suspended or surface no longer authorized");
    signal?.throwIfAborted();
  };
  const start = clock();
  const frames = [];
  let latest;
  for (let i = 0; i < 4; i++) {
    const target = start + (i * intervalMs) / 4;
    while (clock() < target) {
      await check();
      await sleep(Math.max(0, Math.min(100, target - clock())));
    }
    await check();
    const captureStartedAt = now().toISOString();
    const state = await sky.get_window_state({
      window,
      include_screenshot: true,
      include_text: false,
    });
    const capturedAt = now().toISOString();
    await check();
    if (
      state.window?.id !== window.id ||
      state.window?.app !== window.app ||
      state.screenshots?.length !== 1
    )
      throw new Error("Native capture changed surface or returned ambiguous screenshots");
    latest = await saveCoachFrame({ dataDir, url: state.screenshots[0].url, capturedAt });
    frames.push({
      ...latest.frame,
      captureStartedAt,
      screenshotId: state.screenshots[0].id,
      width: state.screenshots[0].width,
      height: state.screenshots[0].height,
      originX: state.screenshots[0].originX,
      originY: state.screenshots[0].originY,
      window: { app: window.app, id: window.id },
    });
  }
  return {
    frames,
    index: latest.index,
    indexPath: latest.indexPath,
    targetIntervalMs: intervalMs,
    targetOffsetsMs: [0, 1, 2, 3].map((i) => (i * intervalMs) / 4),
  };
}
