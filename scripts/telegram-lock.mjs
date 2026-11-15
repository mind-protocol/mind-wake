import fs from "node:fs";

/** Single Telegram consumer per data directory: telegram.pid names the owner. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function read(lock) {
  try {
    return fs.readFileSync(lock, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Returns true when `pid` now owns the lock, false when another live consumer does. */
export function acquireTelegramLock(lock, pid = process.pid, isAlive = alive, now = Date.now()) {
  const current = read(lock);
  if (current !== null) {
    const owner = Number(current);
    if (owner === pid) return true;
    if (owner > 0 && isAlive(owner)) return false;
    // An empty file may be an owner between create and write: leave it a moment.
    if (current === "" && now - fs.statSync(lock).mtimeMs < 10_000) return false;
    fs.rmSync(lock, { force: true });
  }
  try {
    fs.writeFileSync(lock, String(pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export function ownsTelegramLock(lock, pid = process.pid) {
  return read(lock) === String(pid);
}

/** Removes the lock only when it still names `pid`. */
export function releaseTelegramLock(lock, pid = process.pid) {
  if (ownsTelegramLock(lock, pid)) fs.rmSync(lock, { force: true });
}
