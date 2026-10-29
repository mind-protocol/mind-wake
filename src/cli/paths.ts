/**
 * Emplacement des données. Priorité : `--data-dir`, puis `MIND_WAKE_DATA_DIR`, puis le
 * dossier utilisateur par défaut de la plateforme. Aucune écriture ici.
 */

import fs from "node:fs";
import path from "node:path";
import type { CliContext } from "./context.js";

export const DATA_DIR_ENV = "MIND_WAKE_DATA_DIR";

export type DataDirSource = "option" | "environment" | "default";

export interface DataDir {
  readonly path: string;
  readonly source: DataDirSource;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function resolveDataDir(ctx: CliContext, option: string | undefined): DataDir {
  const fromOption = nonEmpty(option);
  if (fromOption !== undefined)
    return { path: path.resolve(ctx.cwd, fromOption), source: "option" };
  const fromEnv = nonEmpty(ctx.env[DATA_DIR_ENV]);
  if (fromEnv !== undefined) return { path: path.resolve(ctx.cwd, fromEnv), source: "environment" };
  const base =
    ctx.platform === "win32"
      ? (nonEmpty(ctx.env["LOCALAPPDATA"]) ?? path.join(ctx.homeDir, "AppData", "Local"))
      : (nonEmpty(ctx.env["XDG_DATA_HOME"]) ?? path.join(ctx.homeDir, ".local", "share"));
  return { path: path.resolve(base, "mind-wake"), source: "default" };
}

export type DataDirState =
  | { readonly status: "missing" }
  | { readonly status: "not_directory" }
  | { readonly status: "ok"; readonly writable: boolean };

/** Inspection en lecture seule. */
export function inspectDataDir(dir: string): DataDirState {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(dir);
  } catch {
    return { status: "missing" };
  }
  if (!stats.isDirectory()) return { status: "not_directory" };
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { status: "ok", writable: true };
  } catch {
    return { status: "ok", writable: false };
  }
}
