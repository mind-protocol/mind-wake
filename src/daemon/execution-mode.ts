import fs from "node:fs";
import path from "node:path";
export type ExecutionMode = "on" | "always-on";
const FILE = "execution-mode.json";
export function executionMode(dataDir: string): ExecutionMode {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as {
      mode?: unknown;
    };
    return data.mode === "always-on" ? "always-on" : "on";
  } catch {
    return "on";
  }
}
export function saveExecutionMode(dataDir: string, mode: ExecutionMode): void {
  const file = path.join(dataDir, FILE),
    tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, mode, updatedAt: new Date().toISOString() }) + "\n",
  );
  fs.renameSync(tmp, file);
}
