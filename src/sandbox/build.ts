/**
 * Construction du lanceur confiné depuis les sources du dépôt (`launcher-source.ts`), par
 * le `csc.exe` de .NET Framework 4.x livré avec Windows : aucun binaire téléchargé, aucun
 * outil à installer, aucun droit administrateur. Le nom du binaire porte l'empreinte de la
 * source : une source modifiée produit un nouveau binaire, jamais un binaire périmé.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SANDBOX_LAUNCHER_SOURCE } from "./launcher-source.js";

export const CSC_PATH = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

export type SandboxLauncherStatus =
  | { readonly available: true; readonly launcherPath: string; readonly sourceDigest: string }
  | { readonly available: false; readonly reason: string };

/** Empreinte (16 hex) de la source du lanceur : identifie le binaire construit. */
export function sandboxSourceDigest(): string {
  return createHash("sha256").update(SANDBOX_LAUNCHER_SOURCE).digest("hex").slice(0, 16);
}

/** Compile le lanceur dans `runtimeDir` s'il n'y est pas déjà. */
export function ensureSandboxLauncher(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform,
): SandboxLauncherStatus {
  if (platform !== "win32") {
    return { available: false, reason: "isolation démontrée sous Windows seulement (ADR-003)" };
  }
  const sourceDigest = sandboxSourceDigest();
  const launcherPath = path.join(runtimeDir, `mindwake-sandbox-${sourceDigest}.exe`);
  if (fs.existsSync(launcherPath)) return { available: true, launcherPath, sourceDigest };
  if (!fs.existsSync(CSC_PATH)) {
    return { available: false, reason: "csc.exe de .NET Framework 4.x introuvable" };
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const tmp = path.join(runtimeDir, `build-${randomUUID()}`);
  fs.mkdirSync(tmp);
  try {
    const source = path.join(tmp, "sandbox.cs");
    const out = path.join(tmp, "sandbox.exe");
    fs.writeFileSync(source, SANDBOX_LAUNCHER_SOURCE);
    const result = spawnSync(CSC_PATH, ["/nologo", "/optimize", `/out:${out}`, source], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || !fs.existsSync(out)) {
      const detail = `${result.stdout}${result.stderr}`.trim().slice(0, 500);
      return { available: false, reason: `compilation du lanceur impossible : ${detail}` };
    }
    try {
      fs.renameSync(out, launcherPath);
    } catch (error) {
      // Compilation concurrente : un autre processus a déjà publié le même binaire.
      if (!fs.existsSync(launcherPath)) throw error;
    }
    return { available: true, launcherPath, sourceDigest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
