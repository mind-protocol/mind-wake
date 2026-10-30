/** Standalone agent control. A workspace argument is mandatory; never selects a live profile. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readAgentScreenshotPolicy } from "../daemon/agent-screenshot-policy.js";

export function setAgentScreenshotPolicy(
  workspace: string,
  mode: "on" | "off" | "auto",
  idleThresholdMs?: number,
): unknown {
  if (!["on", "off", "auto"].includes(mode)) throw new Error("mode: on, off ou auto");
  if (
    idleThresholdMs !== undefined &&
    (!Number.isSafeInteger(idleThresholdMs) || idleThresholdMs < 1 || idleThresholdMs > 86_400_000)
  )
    throw new Error("idleThresholdMs: entier de 1 à 86400000");
  const artifacts = path.join(path.resolve(workspace), "artifacts");
  const file = path.join(artifacts, "pilote.json");
  let original: string | null = null;
  let pilot: Record<string, unknown> = { version: 1 };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error("pilote.json doit être un fichier régulier de 4096 octets maximum");
    original = fs.readFileSync(file, "utf8");
    const raw: unknown = JSON.parse(original);
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (raw as Record<string, unknown>)["version"] !== 1
    )
      throw new Error("pilote.json: objet version 1 attendu ; aucune modification");
    pilot = raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previous = readAgentScreenshotPolicy(artifacts);
  pilot["wakeScreenshot"] = {
    mode,
    ...(idleThresholdMs === undefined
      ? previous === null
        ? {}
        : { idleThresholdMs: previous.idleThresholdMs }
      : { idleThresholdMs }),
  };
  const serialized = JSON.stringify(pilot, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > 4096)
    throw new Error("pilote.json résultant dépasse 4096 octets");
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = path.join(artifacts, `.pilote-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current !== original) throw new Error("pilote.json modifié entre-temps ; réessayer");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    file,
    configured: readAgentScreenshotPolicy(artifacts),
    applies:
      "next launch in a daemon containing agent-screenshot-policy; existing images are retained",
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [workspace, mode, threshold, ...extra] = process.argv.slice(2);
    if (!workspace || !mode || extra.length > 0 || !["on", "off", "auto", "show"].includes(mode))
      throw new Error(
        "Usage: node agent-screenshot.js <workspace> on|off|auto|show [idleThresholdMs]",
      );
    if (mode === "show") {
      if (threshold !== undefined) throw new Error("show n'accepte pas de seuil");
      console.log(
        JSON.stringify(
          {
            configured: readAgentScreenshotPolicy(
              path.join(path.resolve(workspace), "artifacts"),
              null,
            ),
            note: "workspace choice only; null means no readable explicit choice. The daemon may retain a saved choice; inspect wake_screenshot_decided. Application and provider receipt are not verified",
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          setAgentScreenshotPolicy(
            workspace,
            mode as "on" | "off" | "auto",
            threshold === undefined ? undefined : Number(threshold),
          ),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
