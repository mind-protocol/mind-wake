import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod";

const configSchema = z.strictObject({
  workspaceDir: z.string(),
  githubUrl: z.string(),
  enabled: z.boolean(),
  activeWorkspace: z.string(),
});
export type WorkspaceConfig = z.infer<typeof configSchema>;
export function readLocalJson(file: string): unknown {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 65536)
    throw Error("Invalid local workspace settings file");
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}
export function atomicLocalJson(file: string, value: unknown): void {
  if (fs.existsSync(file)) readLocalJson(file);
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function workspaceConfig(dataDir: string): WorkspaceConfig {
  const file = path.join(dataDir, "workspace-settings.json"),
    fallback = path.join(dataDir, "workspace");
  if (!fs.existsSync(file))
    return { workspaceDir: fallback, activeWorkspace: fallback, githubUrl: "", enabled: false };
  const value = configSchema.parse(readLocalJson(file));
  if (!path.isAbsolute(value.workspaceDir) || !path.isAbsolute(value.activeWorkspace))
    throw Error("Workspace paths must be absolute");
  return value;
}
export function githubUrl(value: string): string {
  const m =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value.trim(),
    );
  if (!m?.[1] || !m[2] || [m[1], m[2]].some((v) => v === "." || v === ".."))
    throw Error("Use a GitHub repository URL without credentials, query or fragment");
  return value.trim().startsWith("git@")
    ? `git@github.com:${m[1]}/${m[2]}.git`
    : `https://github.com/${m[1]}/${m[2]}.git`;
}
export function validateWorkspace(dataDir: string, requested: string): string {
  if (!path.isAbsolute(requested)) throw Error("Choose an absolute existing workspace folder");
  const real = fs.realpathSync(requested);
  if (!fs.statSync(real).isDirectory()) throw Error("Workspace must be a directory");
  const relative = path.relative(real, fs.realpathSync(dataDir));
  if (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw Error("Workspace must not contain the Wake profile and its credentials");
  return real;
}
export function activateWorkspace(dataDir: string): void {
  const c = workspaceConfig(dataDir);
  if (c.activeWorkspace === c.workspaceDir) return;
  c.activeWorkspace = validateWorkspace(dataDir, c.workspaceDir);
  atomicLocalJson(path.join(dataDir, "workspace-settings.json"), c);
}
