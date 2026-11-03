# Invisible controls only. Local temporary selection fixture, no owner inbox/capture.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
$dir=Join-Path ([IO.Path]::GetTempPath()) ('postit-input-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try {
 $transport=[pscustomobject]@{cli=(Join-Path $dir 'fixture.mjs');data_dir=$dir;response_dir=$dir}
 $script:sent=0
 function Start-FreeformPostitReply($state) {
  if(-not (Test-Path -LiteralPath $state.file)){throw 'Transport before save'}
  $script:sent++
 }
 $parent=New-Object Windows.Forms.Form
 $form=New-ReplyPostit $transport 'own_fixture' $null $parent
 $form.Tag.input.Text="L'ete, oui !"
 Send-FreeformPostit $form
 if(-not $form.IsDisposed -or -not $parent.IsDisposed){throw 'Send did not close exactly the reply and its parent'}
 $saved=Get-Content -Raw -LiteralPath $form.Tag.file | ConvertFrom-Json
 if($saved.capture -or $saved.reply_to -ne 'own_fixture' -or $saved.text -notmatch 'Reponse au post-it'){throw 'Reply context/capture wrong'}
 if($script:sent -ne 1){throw 'Unexpected transport count'}
 $cancel=New-ReplyPostit $transport
 $cancel.Close()
 if($script:sent -ne 1){throw 'Close transmitted content'}
 $point=[pscustomobject]@{x=12;y=24;at_ms=123456;root_window='42'}
 $target=New-ReplyPostit $transport '' $point
 $target.Tag.input.Text='Fixture native point'
 Send-FreeformPostit $target
 $entry=Get-Content -Raw -LiteralPath $target.Tag.file | ConvertFrom-Json
 if(-not $entry.capture -or $entry.point.x -ne 12 -or $script:sent -ne 2){throw 'Explicit send point missing'}
 # Compile observer class without installing a global hook or starting its loop.
 $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'reply-postit.ps1'))
 $start=$source.IndexOf('# Observer only:')
 $end=$source.IndexOf('$transport=[pscustomobject]', $start)
 . ([scriptblock]::Create($source.Substring($start,$end-$start)))
 'PASS: freeform saved before transport, source reference, no capture on reply, explicit point capture, native close no send, observer compiles without activation'
} finally {
 if($dir.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $dir -Leaf) -match '^postit-input-[a-f0-9]{32}$'){Remove-Item -LiteralPath $dir -Recurse -Force}
}
