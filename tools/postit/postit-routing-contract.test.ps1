# Offline fixture only: instantiate actual controls, never Show/click the desktop or send.
$ErrorActionPreference='Stop'
$dir=Join-Path ([IO.Path]::GetTempPath()) ('postit-route-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try{
 $fixture=Join-Path $dir 'marks.json'
 @{marks=@();reply_transport=@{cli=(Join-Path $dir 'unused.mjs');data_dir=$dir;response_dir=$dir}}|ConvertTo-Json -Depth 10|Set-Content -Encoding UTF8 -LiteralPath $fixture
 $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'postit.ps1'))
 $prefix=$source.Substring(0,$source.IndexOf('$questionIds = @(')).Replace(". (Join-Path `$PSScriptRoot 'reply-postit.ps1') -Library",'').Replace(". (Join-Path `$PSScriptRoot 'content-state.ps1')",'')
 . (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
 . (Join-Path $PSScriptRoot 'content-state.ps1')
 $prefix=$prefix.Replace("(Join-Path `$PSScriptRoot 'emotes.json')", "'"+(Join-Path $PSScriptRoot 'emotes.json').Replace("'","''")+"'")
 . ([scriptblock]::Create($prefix)) -Marks $fixture
 $script:sends=0
 function Start-PostitReply($form){$script:sends++;if(-not(Test-Path -LiteralPath $form.Tag.selectionFile)){throw 'Save before send'}}
 function Start-FreeformPostitReply($state){$script:sends++;if(-not(Test-Path -LiteralPath $state.file)){throw 'Save before send'}}
 function Show-QuestionOtherEditor($editor){} # invisible fixture
 $mark=[pscustomobject]@{kind='sticky';x=20;y=20;text="Question exacte ?";destination='fork:8';question=[pscustomobject]@{id='route-question';mode='yes_no'}}
 $form=New-Sticky $mark
 if($script:sends -ne 0 -or (Test-Path $form.Tag.selectionFile)){throw 'Display sent a response'}
 # Mutating caller state / tab after card creation cannot retarget this card.
 $mark.destination='fork:2';$script:currentTab='principal'
 Open-QuestionOtherEditor $form
 $editor=$form.Tag.editor;$editor.Close()
 if($script:sends -ne 0){throw 'Cancel sent a message'}
 Open-QuestionOtherEditor $form;$editor=$form.Tag.editor;$editor.Tag.input.Text='Une autre voie.'
 Send-FreeformPostit $editor
 $saved=Get-Content -Raw -Encoding UTF8 -LiteralPath $form.Tag.selectionFile|ConvertFrom-Json
 if($saved.destination -cne 'fork:8' -or $saved.source_receipt.destination -cne 'fork:8' -or $saved.option_id -ne 'other' -or $saved.option -ne 'Une autre voie.' -or $saved.question -cne $mark.text){throw 'Frozen route / Other / question lost'}
 $mark.destination='fork:8';$again=New-Sticky $mark
 if($script:sends -ne 1 -or $again.Tag.selection.message_id -cne $saved.message_id){throw 'Resume sent or changed identity'}
 Start-PostitReply $again
 Send-QuestionChoice $again 'yes' 'Oui'
 if($script:sends -ne 2 -or $again.Tag.selection.option_id -ne 'other'){throw 'Double click changed selection'}
 $again.Dispose();$mark.destination='fork:2';$refused=$false
 try{$bad=New-Sticky $mark;$bad.Dispose()}catch{$refused=$true}
 if(-not $refused){throw 'Same question silently retargeted'}
 $conversation=New-Sticky ([pscustomobject]@{kind='sticky';x=20;y=20;text='Texte source exact';destination='fork:8';reply_to='own_route'})
 $transport=$conversation.Tag.replyButton.Tag.transport
 $reply=New-ReplyPostit $transport 'own_route';$reply.Tag.input.Text='Reaction : Merci';Send-FreeformPostit $reply
 $first=Get-Content -Raw -Encoding UTF8 -LiteralPath $reply.Tag.file|ConvertFrom-Json
 $retry=New-ReplyPostit $transport 'own_route'
 if($retry.Tag.selection.message_id -cne $first.message_id -or -not $retry.Tag.input.ReadOnly){throw 'Reaction retry created new identity'}
 if($retry.Tag.selection.source_receipt.question -cne 'Texte source exact' -or $retry.Tag.selection.destination -cne 'fork:8'){throw 'Reference provenance lost'}
 $before=$script:sends;$retry.Close();$conversation.Dispose()
 if($script:sends -ne $before){throw 'Closing retried automatically'}
 foreach($shape in @('note','arrondi','bulle')){
  $plain=New-Sticky ([pscustomobject]@{kind='sticky';shape=$shape;x=20;y=20;text=('Plain '+$shape);destination='fork:8'})
  if(-not $plain.Tag.replyButton -or -not $plain.Tag.emoteButton){throw 'Plain sticky actions missing'}
  $plain.Dispose()
 }
 foreach($kind in @('box','text')){
  $annotation=New-Annotation ([pscustomobject]@{kind=$kind;note=('Source '+$kind);find='needle';destination='fork:8'}) 100 100 80 40
  if(-not $annotation.Tag.replyButton -or -not $annotation.Tag.emoteButton -or $annotation.Tag.replyButton.Top -le $annotation.Tag.H){throw 'Annotation actions missing or inside transparent frame'}
  if($annotation.TransparencyKey -ne [Drawing.Color]::Magenta){throw 'Annotation click-through changed'}
  $palette=New-PostitReactionPicker $annotation.Tag.emoteButton.Tag;$palette.Close();$annotation.Dispose()
 }
 'PASS: frozen card route; Other/cancel; retry same identity; double-click; route conflict; reference reaction; no real UI/inbox'
}finally{
 if($dir.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $dir -Leaf) -match '^postit-route-[a-f0-9]{32}$'){Remove-Item -LiteralPath $dir -Recurse -Force}
}
