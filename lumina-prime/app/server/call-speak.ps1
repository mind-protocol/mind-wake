param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile,[string]$Voice = '')
# Voix locale Windows pour le mode Appel : la voix nommée si elle est installée, sinon la première voix française.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  $named = @($installed | Where-Object { $Voice -ne '' -and $_.VoiceInfo.Name -eq $Voice })
  $french = @($installed | Where-Object { $_.VoiceInfo.Culture.Name -like 'fr-*' })
  if ($named.Count -gt 0) { $synth.SelectVoice($named[0].VoiceInfo.Name) }
  elseif ($french.Count -gt 0) { $synth.SelectVoice($french[0].VoiceInfo.Name) }
  $synth.SetOutputToWaveFile($OutputFile)
  $synth.Speak([System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8))
} finally { $synth.Dispose() }
