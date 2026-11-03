# Isolated contract: constructs controls without showing any window. No real inbox.
$ErrorActionPreference = 'Stop'
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('postit-ui-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testDir)
try {
  $fixture = Join-Path $testDir 'marks.json'
  @{ marks=@(); reply_transport=@{cli=(Join-Path $testDir 'fixture.js'); data_dir=$testDir; response_dir=$testDir} } |
    ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $fixture -Encoding UTF8
  $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'postit.ps1'))
  $prefix = $source.Substring(0,$source.IndexOf('$questionIds = @(')).Replace(". (Join-Path `$PSScriptRoot 'reply-postit.ps1') -Library", '').Replace(". (Join-Path `$PSScriptRoot 'content-state.ps1')", '')
  . (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
  . (Join-Path $PSScriptRoot 'content-state.ps1')
  . ([scriptblock]::Create($prefix)) -Marks $fixture
  $script:stubCalls = 0
  function Start-PostitReply($form) {
    if (-not (Test-Path -LiteralPath $form.Tag.selectionFile)) { throw 'Transport before save' }
    $script:stubCalls++
  }
  $mark = [pscustomobject]@{kind='sticky'; x=20;y=20;text='Question fixture'; question=[pscustomobject]@{id='fixture-question';mode='yes_no'}}
  $first = New-Sticky $mark
  $other = New-Sticky ([pscustomobject]@{kind='sticky';x=20;y=20;text='Other sticky'})
  if ($first.Tag.buttons[0].BackColor.ToArgb() -eq [Drawing.Color]::Magenta.ToArgb()) { throw 'Transparent button' }
  # Raise this fixture control's event directly; never click or expose a real UI.
  $onClick = [System.Windows.Forms.Button].GetMethod('OnClick',[Reflection.BindingFlags]'NonPublic,Instance')
  $onClick.Invoke($first.Tag.buttons[0],@([EventArgs]::Empty))
  if (-not $first.IsDisposed) { throw 'Answered question did not close' }
  if ($other.IsDisposed) { throw 'Unrelated sticky closed' }
  if ($script:stubCalls -ne 1) { throw 'Transport not started exactly once' }
  $reopened = New-Sticky $mark
  if ($reopened.Tag.selection.option_id -ne 'yes' -or $reopened.Tag.buttons[0].Enabled) { throw 'Selection not resumable' }
  if ($script:stubCalls -ne 1) { throw 'Reopen transmitted automatically' }
  $reopened.Dispose(); $other.Dispose()
  $script:freeformCalls=0
  function Start-FreeformPostitReply($state) {
    if(-not (Test-Path -LiteralPath $state.file)){throw 'Reaction transport before save'}
    $script:freeformCalls++
  }
  $conversation=New-Sticky ([pscustomobject]@{kind='sticky';x=20;y=20;text='Conversation fixture';reply_to='own_fixture'})
  if(-not $conversation.Tag.replyButton -or -not $conversation.Tag.emoteButton){throw 'Missing conversation controls'}
  $emotes=New-PostitEmoteMenu $conversation.Tag.emoteButton.Tag
  if($emotes.Items.Count -ne 4){throw 'Missing emote options'}
  # Invoke an unshown fixture item, no real screen input and no inbox.
  $emotes.Items[1].PerformClick()
  if(-not $conversation.IsDisposed -or $script:freeformCalls -ne 1){throw 'Reaction did not save/send/close once'}
  $reaction=@(Get-ChildItem -LiteralPath $testDir -Filter 'postit-*.json' | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json })
  if($reaction.Count -ne 1 -or $reaction[0].capture -or $reaction[0].reply_to -ne 'own_fixture' -or $reaction[0].text -notmatch 'adore'){throw 'Reaction source or capture incorrect'}
  $emotes.Dispose()
  'PASS: opaque buttons, save then transport, immediate close, other note preserved, retry retains choice, no automatic resend'
} finally {
  # This directory is the GUID temporary fixture created above, never a workspace.
  if ($testDir.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $testDir -Leaf) -match '^postit-ui-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $testDir -Recurse -Force
  }
}
