$ErrorActionPreference = 'Stop'
$engineId = [int]$env:WAKE_RESTART_PID
$expectedStart = [DateTimeOffset]::Parse($env:WAKE_RESTART_STARTED)
$engine = Get-Process -Id $engineId -ErrorAction SilentlyContinue
if ($null -eq $engine) { exit 0 }
# PID plus start time prevents killing an unrelated process after PID reuse.
$age = ($expectedStart.UtcDateTime - $engine.StartTime.ToUniversalTime()).TotalSeconds
if ($engine.ProcessName -ne 'node' -or $age -lt 0 -or $age -gt 60) {
    throw 'Identité du moteur différente du statut enregistré ; arrêt refusé.'
}
# Use the verified process handle, not a fresh PID lookup.
$engine.Kill()
if (-not $engine.WaitForExit(10000)) { throw 'Le moteur ne confirme pas son arrêt.' }
