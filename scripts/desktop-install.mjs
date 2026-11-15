/**
 * Recompile et installe le desktop pour une modification Rust (`npm run desktop:install`).
 * Une modification d'interface seule n'en a pas besoin : `npm run desktop:ui` suffit,
 * l'app ouverte sert desktop/ui depuis le disque et se recharge d'elle-même.
 *
 * Étapes : interface, `cargo build --release`, copie dans
 * installation/desktop-builds/<sha256>/ (le binaire en cours reste intact), bascule du seul
 * champ `desktopExe` du manifeste, puis arrêt de l'ancienne app : son superviseur relit le
 * manifeste et lance la nouvelle. Sans superviseur, l'app est seulement installée.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultManifest(env = process.env) {
  const data = env.MIND_WAKE_DATA_DIR || path.join(env.LOCALAPPDATA || "", "mind-wake");
  return path.join(data, "installation", "manifest.json");
}

/** Copie le binaire sous son empreinte et bascule `desktopExe` ; rend l'ancien et le nouveau. */
export function installDesktopBinary(manifestFile, builtExe) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const bytes = fs.readFileSync(builtExe);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(path.dirname(manifestFile), "desktop-builds", hash);
  const exe = path.join(dir, path.basename(builtExe));
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(exe)) fs.copyFileSync(builtExe, exe);
  fs.writeFileSync(
    path.join(dir, "mind-wake-desktop.runtime.json"),
    JSON.stringify({ node: manifest.node, repoDir: manifest.repoDir, dataDir: manifest.dataDir }),
  );
  const previous = manifest.desktopExe;
  if (previous !== exe) {
    // Relire juste avant d'écrire : seule la clé desktopExe change.
    const current = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const tmp = `${manifestFile}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...current, desktopExe: exe }, null, 2) + "\n");
    fs.renameSync(tmp, manifestFile);
  }
  return { previous, exe, hash };
}

function step(label, command, args) {
  console.log(`desktop:install — ${label}`);
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit", windowsHide: true });
  if (result.status !== 0)
    throw Error(`${label} a échoué (${String(result.status ?? result.error)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { manifest: { type: "string" }, "no-restart": { type: "boolean" } },
  });
  const manifestFile = path.resolve(values.manifest ?? defaultManifest());
  if (!fs.existsSync(manifestFile)) throw Error(`Manifeste introuvable : ${manifestFile}`);
  const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  step("interface", process.execPath, [npm, "run", "desktop:ui"]);
  step("binaire", "cargo", [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "desktop/src-tauri/Cargo.toml",
  ]);
  const built = path.join(repo, "desktop/src-tauri/target/release/mind-wake-desktop.exe");
  const { previous, exe } = installDesktopBinary(manifestFile, built);
  console.log(`desktop:install — installé : ${exe}`);
  if (values["no-restart"] || previous === exe) {
    console.log("desktop:install — pas de relance (binaire identique ou --no-restart)");
  } else {
    // Arrête seulement l'ancienne app de cette installation ; son superviseur relance la nouvelle.
    const stop = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name 'mind-wake-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:MIND_OLD_DESKTOP } | Stop-Process",
      ],
      {
        env: { ...process.env, MIND_OLD_DESKTOP: previous ?? "" },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    console.log(
      stop.status === 0
        ? "desktop:install — ancienne app arrêtée ; le superviseur relance la nouvelle"
        : "desktop:install — arrêt de l'ancienne app impossible ; relancer le panneau à la main",
    );
  }
}
