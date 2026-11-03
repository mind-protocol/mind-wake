# Resolve only an explicit profile/workspace or the deployed workspace/artifacts/tools host.
function Resolve-PostitContentState([string]$ExplicitFile, [string]$DataDir, [string]$HostDirectory) {
  if ($ExplicitFile) {
    if (-not [IO.Path]::IsPathRooted($ExplicitFile)) { return '' }
    return [IO.Path]::GetFullPath($ExplicitFile)
  }
  if ($DataDir) {
    if (-not [IO.Path]::IsPathRooted($DataDir)) { return '' }
    $workspace=Join-Path $DataDir 'workspace'
    $settings=Join-Path $DataDir 'workspace-settings.json'
    if ([IO.File]::Exists($settings)) {
      try { $workspace=([IO.File]::ReadAllText($settings)|ConvertFrom-Json).activeWorkspace } catch { return '' }
      if (-not $workspace -or -not [IO.Path]::IsPathRooted($workspace)) { return '' }
    }
    return [IO.Path]::GetFullPath((Join-Path $workspace 'artifacts/overlay/content-state.json'))
  }
  if ($HostDirectory) {
    $artifacts=Split-Path (Split-Path $HostDirectory)
    if ((Split-Path $artifacts -Leaf) -eq 'artifacts') { return [IO.Path]::GetFullPath((Join-Path $artifacts 'overlay/content-state.json')) }
  }
  return ''
}
# Semantic content marker only: no screenshots, input collection, or Wake activation.
function Write-PostitContentState([string]$File, $ShownMarks) {
  if (-not $File -or @($ShownMarks).Count -eq 0) { return }
  $semantic = @($ShownMarks | ForEach-Object {
    $entry=[ordered]@{kind="$($_.kind)";text="$($_.text)";title="$($_.title)";label="$($_.label)";find="$($_.find)";question_text="$($_.question.text)"}
    if ($_.kind -eq 'box') {foreach ($prop in @('x','y','w','h')) {$entry[$prop]=$_.PSObject.Properties[$prop].Value}}
    if ($_.question) {$entry['options']=@($_.question.options | ForEach-Object {"$($_.label)"});$entry['mode']="$($_.question.mode)"}
    $entry
  }) | ConvertTo-Json -Depth 10 -Compress
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($semantic)))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
  $now=[DateTime]::UtcNow.ToString('o'); $changed=$now
  try {$previous=[IO.File]::ReadAllText($File)|ConvertFrom-Json;if($previous.fingerprint -eq $hash){$changed=$previous.changedAt}}catch{}
  $marker=[ordered]@{version=1;fingerprint=$hash;changedAt=$changed;refreshedAt=$now}
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($File))
  $temp=$File+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temp,($marker|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
    if([IO.File]::Exists($File)){[IO.File]::Replace($temp,$File,($temp+".backup"));[IO.File]::Delete($temp+".backup")}else{[IO.File]::Move($temp,$File)}
  } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
