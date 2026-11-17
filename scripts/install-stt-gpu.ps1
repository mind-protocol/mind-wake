# install-stt-gpu.ps1 — Transcription locale sur GPU NVIDIA (prévu pour le PC fixe, RTX 3090 Ti).
# 1) dépendances Python (faster-whisper + cuBLAS 12 / cuDNN 9 en wheels pip, requis par ctranslate2 4.x)
# 2) téléchargement du modèle dans le cache Hugging Face (transcribe.py ne télécharge jamais seul)
# 3) contrôle en une commande : périphérique utilisé + temps de transcription d'un échantillon.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\install-stt-gpu.ps1 [-Model large-v3|large-v3-turbo] [-Python python]
param(
  [ValidateSet('large-v3', 'large-v3-turbo')] [string]$Model = 'large-v3',
  [string]$Python = 'python',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Transcribe = Join-Path $Repo 'services\telegram\transcribe.py'

Write-Host '== GPU'
try { nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader } catch { Write-Warning 'nvidia-smi absent : installer le pilote NVIDIA.' }

if (-not $CheckOnly) {
  Write-Host '== Dépendances Python'
  # Versions relevées sur le portable le 16 nov. 2026 : faster-whisper 1.2.1, ctranslate2 4.8.1 (CUDA 12, cuDNN 9).
  & $Python -m pip install --upgrade 'faster-whisper==1.2.1' 'ctranslate2>=4.5,<5' 'nvidia-cublas-cu12==12.*' 'nvidia-cudnn-cu12==9.*' 'huggingface_hub'
  if ($LASTEXITCODE) { throw 'pip a échoué' }

  Write-Host "== Modèle $Model"
  & $Python -c "from faster_whisper import download_model; print(download_model('$Model'))"
  if ($LASTEXITCODE) { throw 'téléchargement du modèle échoué' }
}

Write-Host '== Contrôle'
& $Python -c "import ctranslate2; print('ctranslate2', ctranslate2.__version__, 'GPU vus:', ctranslate2.get_cuda_device_count())"
$dir = Join-Path $env:TEMP 'stt-gpu-check'
New-Item -ItemType Directory -Force $dir | Out-Null
$wav = Join-Path $dir 'sample.wav'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fr = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'fr*' } | Select-Object -First 1
if ($fr) { $s.SelectVoice($fr.VoiceInfo.Name) }
$s.SetOutputToWaveFile($wav)
$s.Speak('Bonjour Marco. Je teste Claude Code et MindWake sur la 3090 Ti, avec Bassel, ElevenLabs et Suno.')
$s.Dispose()
# Le modèle positionnel sert de repli CPU ; --device cuda force le GPU pour le contrôle.
& $Python $Transcribe $wav $Model --device cuda --gpu-model $Model
if ($LASTEXITCODE) { throw 'transcription GPU échouée (voir stderr ci-dessus)' }
Write-Host 'Attendu : "device": "cuda". Ensuite transcribe.py choisit le GPU tout seul (--device auto).'
