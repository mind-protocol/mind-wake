import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JOB_LAUNCHER_SOURCE } from "./job-launcher-source.js";

export const JOB_SOURCE_SHA256 = createHash("sha256").update(JOB_LAUNCHER_SOURCE).digest("hex");
export const JOB_EXECUTABLE = `mindwake-job-${JOB_SOURCE_SHA256.slice(0, 16)}.exe`;

/** Integrity/protocol check only. Windows remains the authority for signature/policy trust. */
export function bundledJobLauncher(
  directory: string,
): { available: true; launcherPath: string } | { available: false; reason: string } | null {
  if (!fs.existsSync(directory)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "job-launcher.json"), "utf8"));
    if (
      manifest.format !== "mind-wake.job-launcher.v1" ||
      manifest.sourceSha256 !== JOB_SOURCE_SHA256 ||
      manifest.file !== JOB_EXECUTABLE ||
      typeof manifest.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    ) {
      throw new Error("manifest incompatible avec cette version du moteur");
    }
    const launcherPath = path.join(directory, JOB_EXECUTABLE);
    const actual = createHash("sha256").update(fs.readFileSync(launcherPath)).digest("hex");
    if (actual !== manifest.sha256) throw new Error("empreinte SHA-256 incorrecte");
    return { available: true, launcherPath };
  } catch (error) {
    return {
      available: false,
      reason: `lanceur distribué invalide : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
