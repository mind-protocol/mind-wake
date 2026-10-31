import fs from "node:fs";
import path from "node:path";
import type { CodexExecutable } from "./command.js";

/** Resolve the official npm shim as node + script; never execute a .cmd via a shell. */
export function executableFromPath(file: string, node = process.execPath): CodexExecutable | null {
  if (!path.isAbsolute(file)) return null;
  if (/[/\\]node_modules[/\\]@openai[/\\]codex[/\\]bin[/\\]codex\.js$/i.test(file))
    return fs.existsSync(file) ? { path: node, prefixArgs: [file] } : null;
  if (/\.cmd$/i.test(file)) {
    const script = path.join(path.dirname(file), "node_modules/@openai/codex/bin/codex.js");
    return fs.existsSync(file) && fs.existsSync(script)
      ? { path: node, prefixArgs: [script] }
      : null;
  }
  return fs.existsSync(file) ? { path: file } : null;
}

export function discoverCodex(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexExecutable | null {
  const given = env["MIND_WAKE_CODEX_BIN"];
  if (given) return executableFromPath(path.resolve(given));
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(path.delimiter).filter(Boolean);
  const local = env["LOCALAPPDATA"];
  const candidates = dirs.flatMap((dir) => [
    path.join(dir, "codex.exe"),
    path.join(dir, "codex.cmd"),
  ]);
  if (env["CODEX_INSTALL_DIR"]) candidates.push(path.join(env["CODEX_INSTALL_DIR"], "codex.exe"));
  if (local)
    candidates.push(
      path.join(local, "Programs/OpenAI/Codex/bin/codex.exe"),
      path.join(local, "Programs/Codex/resources/codex.exe"),
      path.join(local, "OpenAI/Codex/bin/codex.exe"),
      path.join(local, "Programs/Codex/bin/codex.exe"),
    );
  if (env["APPDATA"]) candidates.push(path.join(env["APPDATA"], "npm/codex.cmd"));
  for (const candidate of candidates) {
    const resolved = executableFromPath(candidate);
    if (resolved) return resolved;
  }
  return null;
}
