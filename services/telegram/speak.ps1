param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $french = @($voice.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'fr-*' -and $_.Enabled })
  if ($french.Count -gt 0) { $voice.SelectVoice($french[0].VoiceInfo.Name) }
  $voice.SetOutputToWaveFile($OutputFile)
  $voice.Speak([System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8))
} finally { $voice.Dispose() }
