# install-local-llm.ps1 — Agent local @local : Ollama sur le PC fixe (RTX 3090 Ti, 24 Go).
# 1) installe Ollama (winget) s'il manque, 2) démarre le serveur, 3) télécharge le modèle,
# 4) test de fumée : une réponse en français, durée, et part du modèle en VRAM (ollama ps).
# Ne touche ni au moteur Wake ni au worker des rooms.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\install-local-llm.ps1 [-Model mistral-small3.2:24b] [-WithFallback] [-CheckOnly] [-Lan]
param(
  [string]$Model = 'mistral-small3.2:24b',
  [string]$Fallback = 'ministral-3:8b',
  [switch]$WithFallback,
  [switch]$CheckOnly,
  # Seulement si Wake tourne sur une AUTRE machine : écoute réseau (Ollama n'a aucune authentification).
  [switch]$Lan,
  [int]$NumCtx = 16384
)
$ErrorActionPreference = 'Stop'
$Url = 'http://127.0.0.1:11434'

function Test-Ollama {
  try { return (Invoke-RestMethod "$Url/api/version" -TimeoutSec 3).version } catch { return $null }
}

Write-Host '== GPU'
try { nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader } catch { Write-Warning 'nvidia-smi absent : installer le pilote NVIDIA.' }

if (-not $CheckOnly) {
  Write-Host '== Ollama'
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE) { throw 'winget install Ollama.Ollama a échoué' }
    $env:Path = "$env:Path;$env:LOCALAPPDATA\Programs\Ollama"
  }
  if ($Lan) {
    # Variable utilisateur lue par Ollama au démarrage ; règle de pare-feu limitée au réseau privé.
    [Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'User')
    $env:OLLAMA_HOST = '0.0.0.0:11434'
    Write-Host 'OLLAMA_HOST=0.0.0.0:11434 (utilisateur). Pare-feu (PowerShell admin) :'
    Write-Host '  New-NetFirewallRule -DisplayName "Ollama LAN" -Direction Inbound -Protocol TCP -LocalPort 11434 -Profile Private -RemoteAddress <IP du portable> -Action Allow'
  }
}

$version = Test-Ollama
if ($null -eq $version) {
  Write-Host 'Serveur Ollama absent : démarrage (ollama serve, fenêtre cachée).'
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and $null -eq $version; $i++) { Start-Sleep 1; $version = Test-Ollama }
  if ($null -eq $version) { throw "Ollama ne répond pas sur $Url" }
}
Write-Host "Ollama $version sur $Url"

if (-not $CheckOnly) {
  Write-Host "== Modèle $Model"
  ollama pull $Model
  if ($LASTEXITCODE) { throw "ollama pull $Model a échoué" }
  if ($WithFallback) {
    # ministral-3 demande Ollama >= 0.13.1 (page du modèle) ; sinon prendre -Fallback qwen3:8b.
    Write-Host "== Modèle de secours $Fallback"
    ollama pull $Fallback
    if ($LASTEXITCODE) { Write-Warning "ollama pull $Fallback a échoué (version d'Ollama ?)" }
  }
}

Write-Host '== Test de fumée'
$body = @{
  model = $Model
  stream = $false
  keep_alive = '30m'
  options = @{ num_ctx = $NumCtx; num_predict = 200; temperature = 0.15 }
  messages = @(
    @{ role = 'system'; content = 'Tu es Local, un modèle qui tourne sur le PC de NLR. Réponds en français, en une ou deux phrases.' },
    @{ role = 'user'; content = 'Dis bonjour à NLR et précise que tu tournes en local, sans outils.' }
  )
} | ConvertTo-Json -Depth 6
$watch = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-RestMethod "$Url/api/chat" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 600
$watch.Stop()
Write-Host "Réponse ($([math]::Round($watch.Elapsed.TotalSeconds, 1)) s, premier chargement compris) :"
Write-Host $r.message.content
if ($r.eval_count -and $r.eval_duration) {
  Write-Host ("Vitesse : {0:N1} tokens/s" -f ($r.eval_count / ($r.eval_duration / 1e9)))
}
Write-Host '== Modèle chargé (PROCESSOR doit dire 100% GPU)'
ollama ps
