param([string]$Preview='')
$ErrorActionPreference='Stop'
$dir=Join-Path ([IO.Path]::GetTempPath()) ('postit-other-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try {
 $fixture=Join-Path $dir 'marks.json'
 @{marks=@();reply_transport=@{cli=(Join-Path $dir 'unused-fixture.js');data_dir=$dir;response_dir=$dir}}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $fixture -Encoding UTF8
 $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'postit.ps1'))
 $prefix=$source.Substring(0,$source.IndexOf('$questionIds = @(')).Replace(". (Join-Path `$PSScriptRoot 'reply-postit.ps1') -Library",'').Replace(". (Join-Path `$PSScriptRoot 'content-state.ps1')",'')
 . (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
 . (Join-Path $PSScriptRoot 'content-state.ps1')
 . ([scriptblock]::Create($prefix)) -Marks $fixture
 $script:sends=0;$script:opens=0
 function Start-PostitReply($form){if(-not(Test-Path -LiteralPath $form.Tag.selectionFile)){throw 'Transport before save'};$script:sends++}
 function Show-QuestionOtherEditor($editor){$script:opens++} # Never show a window in this contract.
 $click=[Windows.Forms.Button].GetMethod('OnClick',[Reflection.BindingFlags]'NonPublic,Instance')
 $question=[pscustomobject]@{kind='sticky';x=20;y=20;w=340;text='Quelle direction ?';question=[pscustomobject]@{id='other-fixture';mode='yes_no'}}
 $form=New-Sticky $question
 if(-not $form.Tag.otherButton -or $form.Tag.buttons.Count -ne 3){throw 'Default Other missing on yes/no'}
 if($form.Tag.otherButton.Bottom -gt $form.Tag.status.Top){throw 'Other overlaps status'}
 if($Preview){
   $bitmap=New-Object Drawing.Bitmap $form.Width,$form.Height
   $g=[Drawing.Graphics]::FromImage($bitmap)
   try{
     $g.Clear($form.Tag.bg)
     $paint=[Windows.Forms.Control].GetMethod('OnPaint',[Reflection.BindingFlags]'NonPublic,Instance')
     $paintArgs=New-Object Windows.Forms.PaintEventArgs $g,([Drawing.Rectangle]::new(0,0,$form.Width,$form.Height))
     $paint.Invoke($form,[object[]]@($paintArgs.PSObject.BaseObject))
     foreach($control in $form.Controls){
       if($control -eq $form.Tag.retry -and -not $form.Tag.selection){continue}
       $tile=New-Object Drawing.Bitmap $control.Width,$control.Height
       try{$control.DrawToBitmap($tile,(New-Object Drawing.Rectangle 0,0,$control.Width,$control.Height));$g.DrawImageUnscaled($tile,$control.Left,$control.Top)}finally{$tile.Dispose()}
     }
     $bitmap.Save($Preview,[Drawing.Imaging.ImageFormat]::Png)
   }finally{$g.Dispose();$bitmap.Dispose()}
 }
 $click.Invoke($form.Tag.otherButton,@([EventArgs]::Empty))
 $editor=$form.Tag.editor
 if($script:opens -ne 1 -or -not $editor -or $script:sends -ne 0 -or (Test-Path $form.Tag.selectionFile)){throw 'Opening Other sent content'}
 $editor.Close()
 if($form.IsDisposed -or $script:sends -ne 0){throw 'Cancel sent or closed question'}
 $click.Invoke($form.Tag.otherButton,@([EventArgs]::Empty))
 $editor=$form.Tag.editor
 $editor.Tag.input.Text='  '
 Send-FreeformPostit $editor
 if($editor.IsDisposed -or $script:sends -ne 0 -or (Test-Path $form.Tag.selectionFile)){throw 'Empty response sent'}
 $text="Une autre voie : l'écoute, puis un essai."
 $editor.Tag.input.Text=$text
 $click.Invoke($editor.Tag.send,@([EventArgs]::Empty))
 if($script:sends -ne 1 -or -not $editor.IsDisposed -or -not $form.IsDisposed){throw 'Other did not save/send/close once'}
 $saved=Get-Content -Raw -Encoding UTF8 -LiteralPath $form.Tag.selectionFile|ConvertFrom-Json
 if($saved.schema -ne 'mind.postit.selection.v1' -or $saved.question_id -ne 'other-fixture' -or $saved.question -ne $question.text -or $saved.option_id -ne 'other' -or $saved.option -ne $text){throw 'Other context or exact text lost'}
 $again=New-Sticky $question
 if(-not $again.Tag.selection -or $again.Tag.otherButton.Enabled -or $script:sends -ne 1){throw 'Resume re-sent or lost selection'}
 $again.Dispose()
 $choice=New-Sticky ([pscustomobject]@{kind='sticky';x=20;y=20;text='Choice';question=[pscustomobject]@{id='other-choice';mode='choice';options=@(@{id='a';label='A'},@{id='b';label='B'})}})
 if(-not $choice.Tag.otherButton){throw 'Other missing on choice'}
 $choice.Dispose()
 $disabled=New-Sticky ([pscustomobject]@{kind='sticky';x=20;y=20;text='Fixed only';question=[pscustomobject]@{id='other-disabled';mode='yes_no';allow_other=$false}})
 if($disabled.Tag.otherButton -or $disabled.Tag.buttons.Count -ne 2){throw 'allow_other false ignored'}
 $disabled.Dispose()
 'PASS: default Other yes/no+choice; open/cancel/empty send nothing; exact free text+question identity; same selection slot; close/reopen without automatic resend; opt-out; no visible UI/inbox'
}finally{
 if($dir.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $dir -Leaf) -match '^postit-other-[a-f0-9]{32}$'){Remove-Item -LiteralPath $dir -Recurse -Force}
}
