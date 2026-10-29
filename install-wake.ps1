#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'mind-wake'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'mind-wake'),
  [switch]$DownloadOnly,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$baseUrl = 'https://mind-wake-intro.immnfest.chatgpt.site'
$archiveName = 'mind-wake-windows-x64-20261029'
$Destination = [System.IO.Path]::GetFullPath($Destination)
$http = $null
try {
  if (Test-Path -LiteralPath $Destination) {
    throw "Destination already exists: $Destination. Nothing replaced. Run again with -Destination and a new directory."
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $http = New-Object System.Net.Http.HttpClient
  $http.Timeout = [TimeSpan]::FromMinutes(5)
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('mind-wake-download-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  $zipFile = Join-Path $tempDir 'mind-wake.zip'
  Write-Host "[1/5] Downloading $baseUrl/downloads/$archiveName.zip"
  $bytes = $http.GetByteArrayAsync("$baseUrl/downloads/$archiveName.zip").GetAwaiter().GetResult()
  [System.IO.File]::WriteAllBytes($zipFile, $bytes)
  Write-Host "Downloaded $($bytes.Length) bytes to $zipFile"
  $checksum = $http.GetStringAsync("$baseUrl/downloads/$archiveName.sha256").GetAwaiter().GetResult()
  $expected = ($checksum.Trim() -split '\s+')[0]
  if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Server did not return a valid SHA-256 checksum.' }
  $actual = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "SHA-256 mismatch. Archive retained for diagnosis: $zipFile" }
  Write-Host '[2/5] SHA-256 verified. Extracting...'
  Expand-Archive -LiteralPath $zipFile -DestinationPath $tempDir
  $source = Join-Path $tempDir 'mind-wake'
  if (!(Test-Path -LiteralPath (Join-Path $source 'package.json')) -or !(Test-Path -LiteralPath (Join-Path $source 'bin\mind-wake-desktop.exe'))) {
    throw 'Incomplete archive: engine or desktop missing.'
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Move-Item -LiteralPath $source -Destination $Destination
  Write-Host "Ready: $Destination"
  if ($DownloadOnly) {
    Write-Host 'Download-only complete. No dependencies, MCP or profile changed.'
    return
  }
  foreach ($required in @('node.exe','npm.cmd','codex.exe')) {
    if (!(Get-Command $required -ErrorAction SilentlyContinue)) { throw "Downloaded successfully, but $required is missing from PATH. Files remain at $Destination. Follow install.md to continue." }
  }
  Push-Location -LiteralPath $Destination
  try {
    Write-Host '[3/5] Installing Node dependencies...'
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)." }
    Write-Host '[4/5] Building engine...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Engine build failed ($LASTEXITCODE)." }
    Write-Host '[5/5] Connecting local MCP and desktop...'
    $setupArgs = @('scripts/setup.mjs','--apply','--data-dir',$DataDir)
    if ($NoOpen) { $setupArgs += '--no-open' }
    & node.exe @setupArgs
    if ($LASTEXITCODE -ne 0) { throw "Local setup failed ($LASTEXITCODE). Files remain at $Destination." }
    Write-Host "Installed at $Destination. Profile: $DataDir"
    Write-Host 'Open a new Codex session to load MCP. Autonomous wakes still require activation from install.md.'
  } finally { Pop-Location }
} catch {
  [Console]::Error.WriteLine('MIND Wake installation failed: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($http) { $http.Dispose() }
}
