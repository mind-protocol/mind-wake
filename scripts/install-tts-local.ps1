<#
.SYNOPSIS
  Installe la voix locale neuronale de MIND Wake (services/tts-local) : Qwen3-TTS sur GPU CUDA,
  Piper sur CPU en secours. Prévu pour le PC de bureau (RTX 3090 Ti, 24 Go) ; ne rien lancer sur
  un portable saturé.

.DESCRIPTION
  1. Vérifie le GPU (nvidia-smi), Python 3.12 et ffmpeg.
  2. Crée le venv <DataDir>\tts-local\venv, installe torch/torchaudio CUDA, qwen-tts, piper-tts.
  3. Télécharge les modèles (Qwen3-TTS 1.7B VoiceDesign + Base + tokenizer ; voix Piper de série).
  4. Écrit <DataDir>\tts-local.json (enabled, url, python) : le pont Telegram et le client Node
     l'utilisent dès leur prochain lancement (aucun redémarrage n'est fait ici).
  5. Test : appareil, nom du GPU, latence pour Marco et VOX (leurs voix sont dessinées à ce moment).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tts-local.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tts-local.ps1 -CudaIndex cu126 -SkipSmoke
#>
param(
  [string]$DataDir = $(if ($env:MIND_WAKE_DATA_DIR) { $env:MIND_WAKE_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'mind-wake' }),
  [string]$CudaIndex = 'cu128',
  [int]$Port = 8766,
  [switch]$CpuOnly,
  [switch]$SkipModels,
  [switch]$SkipSmoke
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo 'services\tts-local\server.py'
$root = Join-Path $DataDir 'tts-local'
$venv = Join-Path $root 'venv'
$py = Join-Path $venv 'Scripts\python.exe'
$env:PYTHONIOENCODING = 'utf-8'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what : échec (code $LASTEXITCODE)" } }

Step 'GPU'
$gpu = $null
if (-not $CpuOnly -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  $gpu = (& nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | Select-Object -First 1)
}
if ($gpu) { Write-Host "GPU : $gpu" } else { Write-Host 'Pas de GPU NVIDIA détecté (ou -CpuOnly) : Piper seul.' -ForegroundColor Yellow; $CpuOnly = $true }

Step 'Python 3.12'
$base = $null
foreach ($candidate in @(@('py', '-3.12'), @('python3.12'), @('python'))) {
  if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
  $pyArgs = @($candidate | Select-Object -Skip 1) + @('-c', 'import sys;print("%d.%d"%sys.version_info[:2])')
  $version = & $candidate[0] @pyArgs
  if ($LASTEXITCODE -eq 0 -and $version -eq '3.12') { $base = $candidate; break }
}
if (-not $base) { throw 'Python 3.12 introuvable. Installer : winget install -e --id Python.Python.3.12' }
Write-Host "Python : $($base -join ' ')"

Step 'ffmpeg'
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Write-Host 'ffmpeg présent' } else { Write-Host 'ffmpeg absent : winget install -e --id Gyan.FFmpeg (requis pour les vocaux Telegram)' -ForegroundColor Yellow }

Step "venv $venv"
New-Item -ItemType Directory -Force $root | Out-Null
if (-not (Test-Path $py)) {
  $pyArgs = @($base | Select-Object -Skip 1) + @('-m', 'venv', $venv)
  & $base[0] @pyArgs; Check 'venv'
}
& $py -m pip install --upgrade pip wheel; Check 'pip'

Step 'Paquets'
if ($CpuOnly) {
  & $py -m pip install numpy soundfile piper-tts; Check 'piper-tts'
} else {
  # RTX 3090 Ti = Ampere sm_86 : couvert par les roues CUDA 12.x officielles.
  & $py -m pip install torch torchaudio --index-url "https://download.pytorch.org/whl/$CudaIndex"; Check "torch ($CudaIndex)"
  & $py -m pip install -U qwen-tts piper-tts numpy soundfile huggingface_hub; Check 'qwen-tts'
  # flash-attn est facultatif (moins de VRAM) et difficile à compiler sous Windows : non installé.
  & $py -c "import torch;assert torch.cuda.is_available(),'CUDA indisponible pour torch';print('torch',torch.__version__,'CUDA',torch.version.cuda,torch.cuda.get_device_name(0))"; Check 'torch CUDA'
}

if (-not $SkipModels) {
  Step 'Modèles'
  if (-not $CpuOnly) {
    & $py -c "from huggingface_hub import snapshot_download as d;[print(d(r)) for r in ('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign','Qwen/Qwen3-TTS-12Hz-1.7B-Base','Qwen/Qwen3-TTS-Tokenizer-12Hz')]"; Check 'Qwen3-TTS'
  }
  $piperDir = Join-Path $root 'piper'
  New-Item -ItemType Directory -Force $piperDir | Out-Null
  & $py -m piper.download_voices fr_FR-siwis-medium en_US-ljspeech-medium --data-dir $piperDir; Check 'voix Piper'
}

Step 'Réglages'
$config = [ordered]@{ enabled = $true; url = "http://127.0.0.1:$Port"; python = $py; autostart = $true; installedAt = (Get-Date).ToString('o'); gpu = $gpu }
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $DataDir 'tts-local.json'), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host $json

if (-not $SkipSmoke) {
  Step 'Test (appareil + latence ; dessine Marco et VOX au premier passage)'
  & $py $server smoke --data-dir $DataDir --text 'Bonjour, ici la voix locale. Tu m''entends bien ?'
  if ($LASTEXITCODE -ne 0) {
    $config.enabled = $false
    [System.IO.File]::WriteAllText((Join-Path $DataDir 'tts-local.json'), ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
    throw 'Test échoué : voix locale laissée désactivée (tts-local.json enabled=false).'
  }
  Write-Host "Écouter : $root\smoke-marco.wav et $root\smoke-vox.wav"
}
Write-Host "`nVoix locale prête. Serveur lancé à la demande par le client Node ($($config.url))." -ForegroundColor Green
