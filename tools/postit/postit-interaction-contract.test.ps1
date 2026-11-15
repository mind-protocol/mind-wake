# Actual candidate controls, never shown; transport is a stub and all files temporary.
param([string]$Export='')
$ErrorActionPreference='Stop'
$candidate=$PSScriptRoot
$dir=Join-Path ([IO.Path]::GetTempPath()) ('postit-interaction-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try {
 $fixture=Join-Path $dir 'marks.json'
 @{marks=@();reply_transport=@{cli=(Join-Path $dir 'unused.mjs');data_dir=$dir;response_dir=$dir}}|ConvertTo-Json -Depth 10|Set-Content -Encoding UTF8 -LiteralPath $fixture
 $source=[IO.File]::ReadAllText((Join-Path $candidate 'postit.ps1'))
 $prefix=$source.Substring(0,$source.IndexOf('$questionIds = @(')).Replace(". (Join-Path `$PSScriptRoot 'reply-postit.ps1') -Library",'').Replace(". (Join-Path `$PSScriptRoot 'content-state.ps1')",'')
 . (Join-Path $candidate 'reply-postit.ps1') -Library
 . (Join-Path $candidate 'content-state.ps1')
 $prefix=$prefix.Replace("(Join-Path `$PSScriptRoot 'emotes.json')", "'"+(Join-Path $candidate 'emotes.json').Replace("'","''")+"'")
 . ([scriptblock]::Create($prefix)) -Marks $fixture
 $script:sent=@()
 function Start-FreeformPostitReply($state){$script:sent+=@(($state.selection|ConvertTo-Json -Depth 12 -Compress|ConvertFrom-Json))}
 function Confirm($form){
  @{schema='mind.postit.delivery.v1';status='queued';message_id=$form.Tag.selection.message_id;destination=$form.Tag.transport.destination;source_receipt=$form.Tag.selection.source_receipt}|ConvertTo-Json -Depth 12|Set-Content -Encoding UTF8 -LiteralPath ($form.Tag.file+'.delivery.json')
 }
 $mark=[pscustomobject]@{kind='sticky';x=20;y=20;text='Stable source';destination='fork:8';reply_to='review_repeat'}
 $card=New-Sticky $mark
 $transport=$card.Tag.replyButton.Tag.transport
 $reply=New-ReplyPostit $transport 'review_repeat'
 $reply.Tag.input.Text='Premiere reponse';Send-FreeformPostit $reply
 $first=$script:sent[0]
 # No ACK: original response is locked and its key/text survive a retry.
 $pending=New-ReplyPostit $transport 'review_repeat'
 if(-not $pending.Tag.input.ReadOnly -or $pending.Tag.selection.message_id -cne $first.message_id){throw 'Uncertain interaction lost identity'}
 Send-FreeformPostit $pending
 if($script:sent[1].text -cne $first.text -or $script:sent[1].message_id -cne $first.message_id){throw 'Retry changed payload/key'}
 # A new emote must not silently re-send the pending old answer.
 $before=$script:sent.Count
 $retryUi=New-PostitReactionPicker $card.Tag.emoteButton.Tag
 if(-not $retryUi.Tag.input.ReadOnly -or $retryUi.Tag.buttons -or $script:sent.Count -ne $before){throw 'Pending reaction did not show unsent retry editor'}
 $retryUi.Close()
 # Wrong ACK destination does not unlock the draft.
 Confirm $reply
 $ack=Get-Content -Raw -Encoding UTF8 -LiteralPath ($reply.Tag.file+'.delivery.json')|ConvertFrom-Json
 $ack.destination='fork:2';$ack|ConvertTo-Json -Depth 12|Set-Content -Encoding UTF8 -LiteralPath ($reply.Tag.file+'.delivery.json')
 $wrong=New-ReplyPostit $transport 'review_repeat'
 if(-not $wrong.Tag.input.ReadOnly){throw 'Wrong destination unlocked reply'};$wrong.Close()
 Confirm $reply
 # Correct ACK: cancel fresh editor without file creation or send.
 $fresh=New-ReplyPostit $transport 'review_repeat'
 if($fresh.Tag.input.ReadOnly -or $fresh.Tag.input.Text -or $fresh.Tag.file){throw 'Confirmed response did not open fresh blank editor'}
 $nextFile=$fresh.Tag.transport.reply_file
 $fresh.Close()
 if((Test-Path -LiteralPath $nextFile) -or $script:sent.Count -ne $before){throw 'Cancel created/sent new interaction'}
 # Original defect: new reaction after ACK must have new identity and selected text.
 $picker=New-PostitReactionPicker $card.Tag.emoteButton.Tag
 $button=$picker.Tag.buttons[1];$chosen=$button.Tag.label
 $click=[Windows.Forms.Button].GetMethod('OnClick',[Reflection.BindingFlags]'NonPublic,Instance')
 $click.Invoke($button,@([EventArgs]::Empty))
 $second=$script:sent[-1]
 if($second.message_id -ceq $first.message_id -or $second.text -cne "Reponse au post-it [review_repeat] :`nReaction : $chosen"){throw 'New reaction replayed old response'}
 if($second.destination -cne 'fork:8' -or $second.source_receipt.question -cne 'Stable source'){throw 'New interaction lost route/provenance'}
 # Reopen/retry new uncertain reaction still holds its exact identity.
 $reactionRetry=New-ReplyPostit $transport 'review_repeat'
 if($reactionRetry.Tag.selection.message_id -cne $second.message_id){throw 'Reaction retry lost identity'}
 Confirm $reactionRetry;$reactionRetry.Close()
 # Two concurrent editors share a deterministic successor slot; second save
 # must retain winner identity rather than enqueue a second fresh event.
 $a=New-ReplyPostit $transport 'review_repeat';$b=New-ReplyPostit $transport 'review_repeat'
 $a.Tag.input.Text='Troisieme reponse';$b.Tag.input.Text='Un double clic concurrent'
 if($a.Tag.transport.reply_file -cne $b.Tag.transport.reply_file){throw 'Concurrent drafts use distinct slots'}
 Send-FreeformPostit $a;Send-FreeformPostit $b
 if($script:sent[-1].message_id -cne $script:sent[-2].message_id -or $script:sent[-1].text -cne $script:sent[-2].text){throw 'Concurrent save duplicated interaction'}
 if($script:sent[-1].message_id -ceq $second.message_id){throw 'Text after confirmed reaction not fresh'}
 # Retry at the maximum message length must not duplicate the source prefix.
 $longTransport=New-PostitCardTransport $m.reply_transport ([pscustomobject]@{reply_to='review_long';text='Long';destination='fork:8'})
 $long=New-ReplyPostit $longTransport 'review_long'
 $prefixLength="Reponse au post-it [review_long] :`n".Length
 $long.Tag.input.Text=('x'*(4000-$prefixLength));Send-FreeformPostit $long
 $longRetry=New-ReplyPostit $longTransport 'review_long';$count=$script:sent.Count
 Send-FreeformPostit $longRetry
 if($script:sent.Count -ne $count+1 -or $script:sent[-1].text.Length -ne 4000 -or $script:sent[-1].message_id -cne $script:sent[-2].message_id){throw 'Long retry changed text or was blocked'}
 if($Export){[IO.File]::WriteAllText($Export,($script:sent|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding $false))}
 $card.Dispose();$picker.Dispose()
 'PASS: pending locked retry; pending emote never auto-sends; wrong ACK rejected; confirmed blank/cancel; new emote; new text; concurrent winner; 4000-char retry; no Show/live inbox'
} finally {
 $absolute=[IO.Path]::GetFullPath($dir)
 if($absolute.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $absolute -Leaf) -match '^postit-interaction-[a-f0-9]{32}$'){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
