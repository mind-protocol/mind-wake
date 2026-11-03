#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'mind-wake'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'mind-wake'),
  [switch]$NoOpen,
  [switch]$Login,
  [switch]$Start,
  [switch]$AcceptNative,
  [string]$Model,
  [string]$TimeZone,
  [string[]]$Share = @(),
  [string]$CodexHome = $env:CODEX_HOME
)
$ErrorActionPreference = 'Stop'
$Destination = [System.IO.Path]::GetFullPath($Destination)
$wakeSource = 'https://github.com/mind-protocol/mind-wake.git'
function Invoke-WakeCommand {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable failed ($LASTEXITCODE). Installation stopped; files retained at $Destination." }
}
try {
  if ($Start -and !$AcceptNative) { throw '-Start requires -AcceptNative after the human agreed to native access and subscription use.' }
  foreach ($required in @('git.exe', 'node.exe', 'npm.cmd', 'cargo.exe')) {
    if (!(Get-Command $required -ErrorAction SilentlyContinue)) {
      throw "$required is missing from PATH. Install the prerequisites described in install.md, then retry."
    }
  }
  if (Test-Path -LiteralPath $Destination) {
    $wakeRoot = & git.exe -C $Destination rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0 -or [System.IO.Path]::GetFullPath($wakeRoot) -ne $Destination) {
      throw "Destination must be the root of a MIND Wake Git clone: $Destination. Nothing replaced."
    }
    $wakeOrigin = & git.exe -C $Destination remote get-url origin
    if ($LASTEXITCODE -ne 0 -or $wakeOrigin -notin @($wakeSource, 'git@github.com:mind-protocol/mind-wake.git')) {
      throw 'Unexpected Git origin. Inspect the existing checkout before continuing.'
    }
    $wakeBranch = & git.exe -C $Destination branch --show-current
    if ($LASTEXITCODE -ne 0 -or $wakeBranch -ne 'main') { throw 'Select the main branch before updating; no branch changed automatically.' }
    $wakeChanges = & git.exe -C $Destination status --porcelain
    if ($LASTEXITCODE -ne 0 -or $wakeChanges) { throw 'Local changes present. Preserve and reconcile them before updating; nothing reset or stashed.' }
    Write-Host '[1/5] Updating the existing clone with git pull --ff-only...'
    Invoke-WakeCommand 'git.exe' @('-C', $Destination, 'pull', '--ff-only', 'origin', 'main')
  } else {
    Write-Host '[1/5] Cloning MIND Wake...'
    Invoke-WakeCommand 'git.exe' @('clone', '--branch', 'main', '--single-branch', '--', $wakeSource, $Destination)
  }
  Push-Location -LiteralPath $Destination
  try {
    Write-Host '[2/5] Installing Node dependencies...'
    Invoke-WakeCommand 'npm.cmd' @('ci')
    Write-Host '[3/5] Building engine and desktop UI...'
    Invoke-WakeCommand 'npm.cmd' @('run', 'build')
    Invoke-WakeCommand 'npm.cmd' @('run', 'desktop:ui')
    Write-Host '[4/5] Building the Windows desktop...'
    Invoke-WakeCommand 'cargo.exe' @('build', '--locked', '--release', '--manifest-path', 'desktop/src-tauri/Cargo.toml')
    Write-Host '[5/5] Connecting local MCP and desktop...'
    $setupArgs = @('scripts/setup.mjs', '--apply', '--data-dir', $DataDir)
    if ($NoOpen) { $setupArgs += '--no-open' }
    if ($Login) { $setupArgs += '--login' }
    if ($CodexHome) { $setupArgs += @('--codex-home', $CodexHome) }
    if ($Start) { $setupArgs += @('--start', '--accept-native') }
    if ($Model) { $setupArgs += @('--model', $Model) }
    if ($TimeZone) { $setupArgs += @('--time-zone', $TimeZone) }
    foreach ($wakeSharedSource in $Share) { $setupArgs += @('--share', $wakeSharedSource) }
    Invoke-WakeCommand 'node.exe' $setupArgs
    Write-Host "Installed from Git at $Destination. Profile: $DataDir"
    Write-Host 'Continue in the app conversation: review access, start your agent, then reply to its greeting.'
  } finally { Pop-Location }
} catch {
  [Console]::Error.WriteLine('MIND Wake installation failed: ' + $_.Exception.Message)
  exit 1
}
