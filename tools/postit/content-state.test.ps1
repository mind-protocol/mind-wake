$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'content-state.ps1')
$dir=Join-Path ([IO.Path]::GetTempPath()) ('duo-marker-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($dir)
try {
 $profile=Join-Path $dir 'profile';[void][IO.Directory]::CreateDirectory($profile)
 $custom=Join-Path $dir 'custom-workspace';@{activeWorkspace=$custom}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $profile 'workspace-settings.json') -Encoding UTF8
 if((Resolve-PostitContentState '' $profile 'C:/source/tools/postit') -ne (Join-Path $custom 'artifacts/overlay/content-state.json')){throw 'Profile workspace ignored'}
 if(Resolve-PostitContentState '' '' 'C:/source/tools/postit'){throw 'Source repo guessed as live workspace'}
 if(Resolve-PostitContentState '' 'relative-profile' ''){throw 'Relative profile accepted'}
 $file=Join-Path $dir 'content-state.json';$mark=[pscustomobject]@{kind='sticky';text='Try a pin';x=10;y=10;at=0;id='old'}
 Write-PostitContentState $file @($mark);$first=[IO.File]::ReadAllText($file)|ConvertFrom-Json
 $mark.x=20;$mark.at=999;$mark.id='new';Write-PostitContentState $file @($mark);$same=[IO.File]::ReadAllText($file)|ConvertFrom-Json
 if($same.fingerprint -ne $first.fingerprint -or $same.changedAt -ne $first.changedAt){throw 'Position/schedule/id counted as new content'}
 $mark.text='Now the fork';Write-PostitContentState $file @($mark);$next=[IO.File]::ReadAllText($file)|ConvertFrom-Json
 if($next.fingerprint -eq $same.fingerprint){throw 'New text ignored'}
 Write-PostitContentState $file @();if(([IO.File]::ReadAllText($file)|ConvertFrom-Json).fingerprint -ne $next.fingerprint){throw 'Hide counted as content'}
 'semantic content marker: PASS'
}finally{Remove-Item -LiteralPath $dir -Recurse -Force}
