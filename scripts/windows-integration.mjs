/** Per-user Windows shortcuts. No registry, elevation, or execution-policy change. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
export function launcherArguments(m, startup = false) {
  const script = `& ${psLiteral(m.node)} ${psLiteral(path.join(m.repoDir, "scripts/desktop-supervisor.mjs"))} --manifest ${psLiteral(m.manifestFile)}${startup ? " --startup" : ""}`;
  return (
    "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " +
    Buffer.from(script, "utf16le").toString("base64")
  );
}
export function windowsIntegration(manifestFile, action, folders = {}) {
  if (process.platform !== "win32") throw Error("Windows required");
  if (!["install", "status", "enable", "disable"].includes(action)) throw Error("Unknown action");
  const m = { ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), manifestFile };
  if (m.version !== 1) throw Error("Unknown installation");
  const settings = path.join(path.dirname(manifestFile), "windows.json");
  const previous = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8")) : null;
  const enabled =
    action === "enable" || (action === "install" && previous?.startWithWindows !== false);
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$startupDir = if ($env:WAKE_SHORTCUT_STARTUP_DIR) { $env:WAKE_SHORTCUT_STARTUP_DIR } else { [Environment]::GetFolderPath('Startup') }
$desktopDir = if ($env:WAKE_SHORTCUT_DESKTOP_DIR) { $env:WAKE_SHORTCUT_DESKTOP_DIR } else { [Environment]::GetFolderPath('DesktopDirectory') }
$startup = Join-Path $startupDir 'MIND Wake.lnk'
$desktop = Join-Path $desktopDir 'MIND Wake.lnk'
function Write-WakeShortcut($location, $arguments) {
  $link = $shell.CreateShortcut($location)
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $link.Arguments = $arguments
  $link.WorkingDirectory = $env:WAKE_SHORTCUT_REPO
  $link.IconLocation = $env:WAKE_SHORTCUT_EXE + ',0'
  $link.Description = 'MIND Wake'
  $link.WindowStyle = 7
  $link.Save()
}
if ($env:WAKE_SHORTCUT_ACTION -eq 'install') { Write-WakeShortcut $desktop $env:WAKE_SHORTCUT_NORMAL }
if ($env:WAKE_SHORTCUT_ACTION -ne 'status') {
  if ($env:WAKE_SHORTCUT_ENABLED -eq 'true') { Write-WakeShortcut $startup $env:WAKE_SHORTCUT_STARTUP }
  elseif (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup }
}
@{ startWithWindows = (Test-Path -LiteralPath $startup); desktopShortcut = (Test-Path -LiteralPath $desktop) } | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        WAKE_SHORTCUT_ACTION: action,
        WAKE_SHORTCUT_ENABLED: String(enabled),
        WAKE_SHORTCUT_REPO: m.repoDir,
        WAKE_SHORTCUT_EXE: m.desktopExe,
        WAKE_SHORTCUT_STARTUP_DIR: folders.startup || "",
        WAKE_SHORTCUT_DESKTOP_DIR: folders.desktop || "",
        WAKE_SHORTCUT_NORMAL: launcherArguments(m),
        WAKE_SHORTCUT_STARTUP: launcherArguments(m, true),
      },
    },
  );
  if (result.error || result.status !== 0)
    throw Error(result.stderr || result.error?.message || "Windows shortcuts failed");
  const state = JSON.parse(result.stdout.trim());
  if (action !== "status") fs.writeFileSync(settings, JSON.stringify(state, null, 2));
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const dataDir =
      process.env.MIND_WAKE_DATA_DIR || path.join(process.env.LOCALAPPDATA || "", "mind-wake");
    console.log(
      JSON.stringify(
        windowsIntegration(
          path.join(dataDir, "installation/manifest.json"),
          process.argv[2] || "status",
        ),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
