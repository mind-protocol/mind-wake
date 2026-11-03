# Post-its d'agent pour Windows (PowerShell 5.1). Lit un fichier marks.json et affiche par-dessus l'écran :
#  - sticky : post-it dans sa propre petite fenêtre, cliquable (croix ✕ pour fermer), sans voler le focus ;
#  - box / text : repères déplaçables, intérieur transparent laissant passer les clics.
# Glisser avec le bouton gauche ; double-cliquer pour supprimer un élément.
# Tout s'efface après ttl_seconds. Ne tape rien, ne clique rien. Voir README.md et marks.schema.json.
param(
  [string]$Marks = (Join-Path $PSScriptRoot '..\..\overlay\marks.json'),
  [string]$Log = '',
  [string]$ContentStateFile = '',
  [string]$DataDir = $env:MIND_WAKE_DATA_DIR
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
. (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
. (Join-Path $PSScriptRoot 'content-state.ps1')
Add-Type @'
using System; using System.Runtime.InteropServices;
using System.Drawing; using System.Windows.Forms;
public class PostitForm : Form {
  private bool pressed, dragging;
  private Point anchor, origin;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; }
  }
  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    if (e.Button != MouseButtons.Left) return;
    anchor = PointToScreen(e.Location); origin = Location;
    pressed = true; dragging = false; Capture = true;
  }
  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    if (!pressed) return;
    Point now = PointToScreen(e.Location);
    int dx = now.X - anchor.X, dy = now.Y - anchor.Y;
    if (!dragging && (Math.Abs(dx) >= SystemInformation.DragSize.Width / 2 ||
                     Math.Abs(dy) >= SystemInformation.DragSize.Height / 2)) dragging = true;
    if (dragging) Location = new Point(origin.X + dx, origin.Y + dy);
  }
  protected override void OnMouseUp(MouseEventArgs e) {
    if (e.Button == MouseButtons.Left) { pressed = false; Capture = false; }
    base.OnMouseUp(e);
  }
  protected override void OnMouseCaptureChanged(EventArgs e) {
    if (!Capture) { pressed = false; dragging = false; }
    base.OnMouseCaptureChanged(e);
  }
  protected override void OnMouseDoubleClick(MouseEventArgs e) {
    base.OnMouseDoubleClick(e);
    if (e.Button == MouseButtons.Left) Close();
  }
}
public static class PostitW { [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h,int i,int v); }
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing
if (-not $Log) { $Log = Join-Path (Split-Path $Marks) 'overlay.log' }
function Write-Log($msg) { "$(Get-Date -f o) $msg" | Add-Content -Encoding UTF8 $Log }
try { $m = Get-Content -Raw -Encoding UTF8 $Marks | ConvertFrom-Json }
catch { Write-Log "marks.json invalide ($Marks): $_"; exit 1 }
if (-not $DataDir -and $m.reply_transport.data_dir) { $DataDir = $m.reply_transport.data_dir }
$ContentStateFile = Resolve-PostitContentState $ContentStateFile $DataDir $PSScriptRoot
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$sx = $scr.Width / 1280.0; $sy = $scr.Height / 720.0   # repère de coordonnées : 1280x720

# --- Marques 'text' : OCR Windows sur l'écran capturé en mémoire (rien n'est écrit sur disque) ---
function Find-OnScreen([string[]]$needles) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$t) { $k = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $k.Wait(); $k.Result }
  $bmp = New-Object System.Drawing.Bitmap $scr.Width, $scr.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($scr.Location, [System.Drawing.Point]::Empty, $scr.Size)
  $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms))) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages().RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $ms.Dispose()
  $out = @{}
  foreach ($n in $needles) {
    $nw = @($n.ToLower() -split '\s+' | ? { $_ }); $hits = @()
    foreach ($l in $res.Lines) { $ws = @($l.Words)
      for ($i = 0; $i -le $ws.Count - $nw.Count; $i++) {
        $ok = $true; for ($j = 0; $j -lt $nw.Count; $j++) { if ($ws[$i+$j].Text.ToLower() -notlike "*$($nw[$j])*") { $ok = $false; break } }
        if ($ok) { $a = $ws[$i].BoundingRect; $b = $ws[$i+$nw.Count-1].BoundingRect
          $hits += ,@([int]$a.X, [int][Math]::Min($a.Y,$b.Y), [int]($b.X+$b.Width-$a.X), [int][Math]::Max($a.Height,$b.Height)) } } }
    $out[$n] = $hits }
  $out }
$needles = @($m.marks | ? { $_.kind -eq 'text' -and $_.find } | % { $_.find })
$found = @{}
if ($needles.Count) { try { $found = Find-OnScreen $needles } catch { Write-Log "OCR échoué: $_" } }

$ttl = if ($m.ttl_seconds) { [int]$m.ttl_seconds } else { 60 }
function Is-Visible($k, $el) { $a = [double]$k.at; ($el -ge $a) -and -not ($k.for -and $el -ge $a + [double]$k.for) }

# --- Calque plein écran (box / text) : transparent, au-dessus, clics traversants ---
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.ShowInTaskbar = $false
$f.StartPosition = 'Manual'; $f.Bounds = $scr
$f.BackColor = [System.Drawing.Color]::Magenta; $f.TransparencyKey = $f.BackColor
# WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
$f.Add_Shown({ param($s,$e) $h=$s.Handle; $ex=[PostitW]::GetWindowLong($h,-20)
  [void][PostitW]::SetWindowLong($h,-20,$ex -bor 0x80000 -bor 0x20 -bor 0x08000000 -bor 0x80) })
# Chaque repère possède sa fenêtre : seuls ses pixels peints interceptent la souris.
function New-Annotation($k, $rx, $ry, $rw, $rh) {
  $af = New-Object PostitForm
  $af.FormBorderStyle='None'; $af.TopMost=$true; $af.ShowInTaskbar=$false; $af.StartPosition='Manual'
  $af.BackColor=[System.Drawing.Color]::Magenta; $af.TransparencyKey=$af.BackColor
  $color = if ($k.kind -eq 'text') { [System.Drawing.Color]::DarkOrange } else { [System.Drawing.Color]::Firebrick }
  $label = if ($k.note) { "agent : $($k.note)" } else { '' }
  $font = New-Object System.Drawing.Font 'Segoe UI',11,([System.Drawing.FontStyle]::Bold)
  $size = [System.Windows.Forms.TextRenderer]::MeasureText($label,$font)
  $af.Bounds = New-Object System.Drawing.Rectangle ($scr.X+$rx-6),($scr.Y+$ry-6),([Math]::Max($rw+14,$size.Width+12)),($rh+24+$size.Height)
  $af.Tag = @{ W=$rw; H=$rh; color=$color; label=$label; font=$font; kind=$k.kind }
  $af.Cursor=[System.Windows.Forms.Cursors]::SizeAll
  $af.Add_Paint({ param($s,$e) $d=$s.Tag; $g=$e.Graphics
    $pen=New-Object System.Drawing.Pen $d.color,4
    $brush=New-Object System.Drawing.SolidBrush $d.color
    try {
      $g.DrawRectangle($pen,6,6,$d.W,$d.H)
      if ($d.kind -eq 'text') { $g.FillRectangle($brush,6,($d.H+12),$d.W,4) }
      if ($d.label) { $g.DrawString($d.label,$d.font,$brush,6,($d.H+18)) }
    } finally { $pen.Dispose(); $brush.Dispose() }
  })
  $af.Add_Disposed({ param($s,$e) $s.Tag.font.Dispose() })
  return $af
}

# --- Post-its : une petite fenêtre par sticky. Données par fenêtre dans $form.Tag (pas de closures). ---
$PAL = @{ jaune='255,236,120'; rose='255,182,213'; bleu='170,215,255'; vert='185,240,170'; orange='255,200,130'; violet='215,190,255' }
function Get-StickyColor($c) {
  if ($c -and "$c" -match '^#[0-9a-fA-F]{6}$') { return [System.Drawing.ColorTranslator]::FromHtml($c) }
  $v = $(if ($c -and $PAL.ContainsKey("$c")) { $PAL["$c"] } else { $PAL.jaune }) -split ','
  [System.Drawing.Color]::FromArgb(255,[int]$v[0],[int]$v[1],[int]$v[2]) }
function New-RoundPath($x,$y,$w,$h,$r) { $p=New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x,$y,2*$r,2*$r,180,90); $p.AddArc($x+$w-2*$r,$y,2*$r,2*$r,270,90)
  $p.AddArc($x+$w-2*$r,$y+$h-2*$r,2*$r,2*$r,0,90); $p.AddArc($x,$y+$h-2*$r,2*$r,2*$r,90,90); $p.CloseFigure(); $p }
# Texte via TextRenderer (GDI) : la liaison de polices de Windows bascule sur Segoe UI Emoji pour les emoji (rendu monochrome).
$TF = [System.Windows.Forms.TextFormatFlags]'WordBreak, NoPrefix, NoPadding'
$fontN = New-Object System.Drawing.Font 'Segoe UI',12
$fontB = New-Object System.Drawing.Font 'Segoe UI',12,([System.Drawing.FontStyle]::Bold)
$fontT = New-Object System.Drawing.Font 'Segoe UI',14,([System.Drawing.FontStyle]::Bold)
$fontX = New-Object System.Drawing.Font 'Segoe UI Symbol',12,([System.Drawing.FontStyle]::Bold)
$fontF = New-Object System.Drawing.Font 'Segoe UI',9,([System.Drawing.FontStyle]::Italic)

function New-Sticky($k) {
  $W = [int]($(if ($k.w) { [double]$k.w } else { 300 }) * $sx)
  $shape = if ($k.shape -in 'note','arrondi','bulle') { "$($k.shape)" } else { 'note' }
  $pad = 14; $close = 30; $tail = if ($shape -eq 'bulle') { 22 } else { 0 }
  $lines = New-Object System.Collections.ArrayList; $H = $pad
  foreach ($l in ("$($k.text)" -replace "`r",'' -split "`n")) {
    $font = $fontN; $t = $l
    if ($l -match '^\s*#\s+(.*)$') { $font = $fontT; $t = $Matches[1] }
    elseif ($l -match '^\s*\*\*(.+)\*\*\s*$') { $font = $fontB; $t = $Matches[1] }
    if (-not $t) { $t = ' ' }
    $tw = $W - 2*$pad - $(if ($lines.Count -eq 0) { $close } else { 0 })
    $lh = [System.Windows.Forms.TextRenderer]::MeasureText($t, $font, (New-Object System.Drawing.Size $tw, 0), $TF).Height
    [void]$lines.Add(@($t, $font, $H, $tw, $lh)); $H += $lh + 2 }   # $lh (et non $h) : PowerShell confond $h et $H
  $questionY = $H
  $question = $k.question
  $options = @()
  if ($question) {
    if ("$($question.id)" -notmatch '^[A-Za-z0-9_.:-]{1,80}$') { throw 'question.id invalide' }
    if ($question.mode -eq 'yes_no') { $options = @([pscustomobject]@{id='yes';label='Oui'},[pscustomobject]@{id='no';label='Non'}) }
    elseif ($question.mode -eq 'choice') { $options = @($question.options) }
    else { throw 'question.mode invalide' }
    if ($options.Count -lt 2 -or $options.Count -gt 8) { throw '2 à 8 options requises' }
    foreach ($option in $options) {
      if ("$($option.id)" -notmatch '^[A-Za-z0-9_.:-]{1,80}$' -or -not $option.label -or "$($option.label)".Length -gt 100) { throw 'option invalide' }
    }
    if (@($options.id | Select-Object -Unique).Count -ne $options.Count) { throw 'option.id dupliqué' }
    if (-not $m.reply_transport.cli -or -not $m.reply_transport.data_dir -or -not $m.reply_transport.response_dir) { throw 'reply_transport explicite requis' }
    foreach ($p in @($m.reply_transport.cli,$m.reply_transport.data_dir,$m.reply_transport.response_dir)) {
      if (-not [IO.Path]::IsPathRooted($p) -or "$p".Contains('"')) { throw 'Chemin transport absolu requis, sans guillemet' }
    }
    $H += ($options.Count * 38) + 58
  }
  $H += 26   # pied de page
  if ($k.reply_to) {
    if ("$($k.reply_to)" -notmatch '^[A-Za-z0-9_.:-]{1,120}$' -or -not $m.reply_transport) { throw 'reply_to et reply_transport explicites requis' }
    $H += 40
  }
  $sf = New-Object PostitForm
  $sf.FormBorderStyle='None'; $sf.TopMost=$true; $sf.ShowInTaskbar=$false; $sf.StartPosition='Manual'
  $sf.Bounds = New-Object System.Drawing.Rectangle ([int]($scr.X+$k.x*$sx)),([int]($scr.Y+$k.y*$sy)),($W+6),($H+6+$tail)
  $sf.BackColor=[System.Drawing.Color]::Magenta; $sf.TransparencyKey=$sf.BackColor
  $sf.Tag = @{ W=$W; H=$H; tail=$tail; shape=$shape; bg=(Get-StickyColor $k.color); lines=$lines; pad=$pad; close=$close }
  if ($question) { Add-QuestionControls $sf $k $options $questionY }
  if ($k.reply_to) { Add-ConversationControls $sf $k ($H-64) }
  # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW : cliquable mais ne prend jamais le focus
  $sf.Add_Shown({ param($s,$e) $h=$s.Handle; $ex=[PostitW]::GetWindowLong($h,-20)
    [void][PostitW]::SetWindowLong($h,-20,$ex -bor 0x08000000 -bor 0x80) })
  $sf.Add_Paint({ param($s,$e) try { $d=$s.Tag; $g=$e.Graphics; $g.SmoothingMode='AntiAlias'
    $W=$d.W; $H=$d.H
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,90,90,90))
    $fill = New-Object System.Drawing.SolidBrush $d.bg
    if ($d.shape -eq 'note') { $g.FillRectangle($shadow,5,5,$W,$H); $g.FillRectangle($fill,0,0,$W,$H) }
    else {
      $g.FillPath($shadow,(New-RoundPath 4 4 $W $H 16)); $g.FillPath($fill,(New-RoundPath 0 0 $W $H 16))
      if ($d.shape -eq 'bulle') {
        $pts = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 28,($H-3)),(New-Object System.Drawing.Point 64,($H-3)),(New-Object System.Drawing.Point 18,($H+$d.tail)))
        $g.FillPolygon($fill,$pts) } }
    foreach ($L in $d.lines) {
      [System.Windows.Forms.TextRenderer]::DrawText($g, $L[0], $L[1], (New-Object System.Drawing.Rectangle $d.pad,$L[2],$L[3],($L[4]+4)), [System.Drawing.Color]::Black, $d.bg, $TF) }
    [System.Windows.Forms.TextRenderer]::DrawText($g, [string][char]0x2715, $fontX, (New-Object System.Drawing.Point ($W-26),6), [System.Drawing.Color]::DimGray, $d.bg)
    [System.Windows.Forms.TextRenderer]::DrawText($g, "— agent · s'efface seul", $fontF, (New-Object System.Drawing.Point $d.pad,($H-22)), [System.Drawing.Color]::DimGray, $d.bg) } catch { Write-Log "erreur dessin post-it: $_" } })
  $sf.Add_MouseMove({ param($s,$e) $d=$s.Tag
    $s.Cursor = if ($e.X -ge $d.W-$d.close-4 -and $e.Y -le $d.close+4) { [System.Windows.Forms.Cursors]::Hand } else { [System.Windows.Forms.Cursors]::SizeAll } })
  $sf.Add_MouseClick({ param($s,$e) $d=$s.Tag
    if ($e.X -ge $d.W-$d.close-4 -and $e.Y -le $d.close+4) { Write-Log 'post-it fermé par la croix'; $s.Close() } })
  $sf }

# Buttons are child controls: their clicks never start a drag or dismiss the note.
function Add-ConversationControls($form, $mark, $top) {
  $reply=New-Object Windows.Forms.Button; $reply.Text='Répondre'; $reply.TabStop=$false
  $reply.Bounds=New-Object Drawing.Rectangle 14,$top,110,32; $reply.BackColor=[Drawing.Color]::White
  $reply.Tag=@{form=$form;id="$($mark.reply_to)";transport=$m.reply_transport}
  $reply.Add_Click({param($s,$e)
    $d=$s.Tag
    if ($d.form.Tag.editor -and -not $d.form.Tag.editor.IsDisposed) { return }
    $d.form.Tag.editor=New-ReplyPostit $d.transport $d.id $null $d.form
    $d.form.Tag.editor.Show()
  })
  $emote=New-Object Windows.Forms.Button; $emote.Text='Émote'; $emote.TabStop=$false
  $emote.Bounds=New-Object Drawing.Rectangle 132,$top,100,32; $emote.BackColor=[Drawing.Color]::White
  $emote.Tag=$reply.Tag
  $emote.Add_Click({param($s,$e)
    $menu=New-PostitEmoteMenu $s.Tag
    $menu.Show($s,0,$s.Height)
  })
  $form.Controls.AddRange(@($reply,$emote)); $form.Tag.replyButton=$reply; $form.Tag.emoteButton=$emote
}
function New-PostitEmoteMenu($route) {
    $menu=New-Object Windows.Forms.ContextMenuStrip
    foreach ($label in @("👍 J'aime", "❤️ J'adore", '😂 Drôle', '🤔 À creuser')) {
      $item=$menu.Items.Add($label); $item.Tag=@{route=$route;label=$label}
      $item.Add_Click({param($i,$event)
        $d=$i.Tag.route
        $f=New-ReplyPostit $d.transport $d.id $null $d.form
        $f.Tag.input.Text='Reaction : '+$i.Tag.label
        Send-FreeformPostit $f
        if (-not $f.IsDisposed) { $f.Show() }
      })
    }
    return $menu
}
function Add-QuestionControls($form, $mark, $options, $top) {
  $d = $form.Tag
  $form.Text = 'Marco - ' + $mark.question.id
  $form.AccessibleName = "$($mark.text)"
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes("$($mark.question.id)")))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
  [void][IO.Directory]::CreateDirectory($m.reply_transport.response_dir)
  $d.selectionFile = Join-Path $m.reply_transport.response_dir ($key + '.json')
  $d.question = $mark.question; $d.questionText = "$($mark.text)"; $d.buttons = @(); $d.transport = $m.reply_transport
  $d.selection = $null; $d.process = $null
  if (Test-Path -LiteralPath $d.selectionFile) {
    $d.selection = Get-Content -Raw -Encoding UTF8 -LiteralPath $d.selectionFile | ConvertFrom-Json
    if ($d.selection.question_id -ne $mark.question.id -or $d.selection.question -ne $d.questionText) { throw 'question.id déjà utilisé pour une autre question' }
  }
  foreach ($option in $options) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = "$($option.label)"; $button.Font = $fontN
    $button.BackColor = [Drawing.Color]::White; $button.ForeColor = [Drawing.Color]::Black
    $button.UseVisualStyleBackColor = $false; $button.FlatStyle = 'Flat'
    $button.Bounds = New-Object Drawing.Rectangle 14,$top,($d.W-28),34
    $button.Tag = @{ form=$form; id="$($option.id)"; label="$($option.label)" }; $button.TabStop = $false
    $button.Add_Click({ param($s,$e)
      $state = $s.Tag.form.Tag
      if ($state.selection) { return }
      $state.selection = [pscustomobject]@{ schema='mind.postit.selection.v1'; question_id="$($state.question.id)"; question=$state.questionText; option_id=$s.Tag.id; option=$s.Tag.label; message_id=('postit:' + [IO.Path]::GetFileNameWithoutExtension($state.selectionFile)); clicked_at=[DateTime]::UtcNow.ToString('o') }
      try {
        # CreateNew keeps the first selection across two simultaneous overlays.
        $stream = New-Object IO.FileStream $state.selectionFile,([IO.FileMode]::CreateNew),([IO.FileAccess]::Write),([IO.FileShare]::None)
        try { $bytes = [Text.Encoding]::UTF8.GetBytes(($state.selection | ConvertTo-Json -Compress)); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
      } catch {
        try { $state.selection = Get-Content -Raw -Encoding UTF8 -LiteralPath $state.selectionFile | ConvertFrom-Json }
        catch { $state.selection = $null; $state.status.Text = 'Sauvegarde impossible. Réessaie.'; return }
      }
      foreach ($b in $state.buttons) { $b.Enabled = $false }
      Start-PostitReply $s.Tag.form
      # The human has answered: dismiss only this question. Its bounded transport
      # process finishes independently and persists the delivery receipt.
      $s.Tag.form.Close()
    })
    $form.Controls.Add($button); $d.buttons += $button; $top += 38
  }
  $status = New-Object System.Windows.Forms.Label; $status.Font = $fontF
  $status.Bounds = New-Object Drawing.Rectangle 14,$top,($d.W-28),28
  $status.Text = 'Clique pour répondre à Marco.'; $status.BackColor = $d.bg; $d.status=$status; $form.Controls.Add($status)
  $retry = New-Object System.Windows.Forms.Button; $retry.Text = "Réessayer l'envoi"; $retry.TabStop=$false
  $retry.BackColor = [Drawing.Color]::White; $retry.ForeColor = [Drawing.Color]::Black
  $retry.UseVisualStyleBackColor = $false; $retry.FlatStyle = 'Flat'
  $retry.Bounds = New-Object Drawing.Rectangle 14,($top+28),($d.W-28),28
  $retry.Tag=$form; $retry.Visible=$false; $retry.Add_Click({param($s,$e) Start-PostitReply $s.Tag})
  $d.retry=$retry; $form.Controls.Add($retry)
  if ($d.selection) {
    foreach ($b in $d.buttons) { $b.Enabled = $false }
    $status.Text = 'Choix conservé : ' + $d.selection.option; $retry.Visible = $true
  }
}
function Start-PostitReply($form) {
  $d=$form.Tag
  if ($d.process -and -not $d.process.HasExited) { return }
  $d.retry.Visible=$false; $d.status.Text='Choix : ' + $d.selection.option + ' · envoi…'
  try {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName='node'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.Arguments='"' + (Join-Path $PSScriptRoot 'postit-reply.mjs') + '" --selection "' + $d.selectionFile + '" --cli "' + $d.transport.cli + '" --data-dir "' + $d.transport.data_dir + '"'
    $d.process=[Diagnostics.Process]::Start($info)
  } catch { $d.status.Text='Conservé localement ; envoi non confirmé.'; $d.retry.Visible=$true; Write-Log 'Transport post-it indisponible' }
}

$questionIds = @($m.marks | Where-Object { $_.question } | ForEach-Object { $_.question.id })
if (@($questionIds | Select-Object -Unique).Count -ne $questionIds.Count) { throw 'question.id doit etre unique dans marks.json' }
$stickies = New-Object System.Collections.ArrayList
foreach ($k in @($m.marks | ? { $_.kind -eq 'sticky' })) {
  try { [void]$stickies.Add([pscustomobject]@{ k=$k; form=(New-Sticky $k); state=0 }) }
  catch { Write-Log "sticky ignoré: $_" } }

# Les occurrences OCR sont manipulables indépendamment les unes des autres.
foreach ($k in @($m.marks | ? { $_.kind -in 'box','text' })) {
  $rects = @()
  if ($k.kind -eq 'box') { $rects = @(,@([int]($k.x*$sx),[int]($k.y*$sy),[int]($k.w*$sx),[int]($k.h*$sy))) }
  else {
    $max = if ($k.max) { [int]$k.max } else { 3 }
    $rects = @($found[$k.find] | Select-Object -First $max)
  }
  foreach ($rect in $rects) {
    if (-not $rect) { continue }
    try { [void]$stickies.Add([pscustomobject]@{ k=$k; form=(New-Annotation $k $rect[0] $rect[1] $rect[2] $rect[3]); state=0 }) }
    catch { Write-Log "repère ignoré: $_" }
  }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew(); $script:last = ''
$r = New-Object System.Windows.Forms.Timer; $r.Interval = 250
$r.Add_Tick({ $el = $sw.Elapsed.TotalSeconds
  try {
    $vis = ($m.marks | ? { $_.kind -ne 'sticky' } | % { [int](Is-Visible $_ $el) }) -join ''
    if ($vis -ne $script:last) { $script:last = $vis; $f.Invalidate() }
    $published = $false
    foreach ($st in $stickies) { $a = [double]$st.k.at
      if (-not $st.form.IsDisposed -and $st.form.Tag.process -and $st.form.Tag.process.HasExited) {
        $d=$st.form.Tag
        try {
          $receipt=Get-Content -Raw -Encoding UTF8 -LiteralPath ($d.selectionFile+'.delivery.json') | ConvertFrom-Json
          if ($receipt.status -eq 'queued' -and $receipt.message_id -eq $d.selection.message_id) { $d.status.Text='Transmis à Marco : ' + $d.selection.option; $d.retry.Visible=$false }
          else { $d.status.Text='Conservé localement ; envoi non confirmé.'; $d.retry.Visible=$true }
        } catch { $d.status.Text='Conservé localement ; envoi non confirmé.'; $d.retry.Visible=$true }
        $d.process.Dispose(); $d.process=$null
      }
      if ($st.state -eq 0 -and $el -ge $a) { $st.state = 1; if (-not $st.form.IsDisposed) { $st.form.Show($f); $published = $true } }
      if ($st.state -eq 1 -and $st.k.for -and $el -ge $a + [double]$st.k.for -and -not ($st.form.Tag.editor -and -not $st.form.Tag.editor.IsDisposed)) { $st.state = 2; if (-not $st.form.IsDisposed) { $st.form.Close() } } }
    if ($published) {
      try { Write-PostitContentState $ContentStateFile @($stickies | Where-Object { $_.state -eq 1 -and -not $_.form.IsDisposed } | ForEach-Object { $_.k }) }
      catch { Write-Log "marqueur contenu indisponible: $_" }
    }
  } catch { Write-Log "erreur minuterie: $_" } }); $r.Start()
$t = New-Object System.Windows.Forms.Timer; $t.Interval = $ttl*1000; $t.Add_Tick({
  # A human writing a reply keeps this conversation alive until they send/close.
  $editing=@($stickies | Where-Object { -not $_.form.IsDisposed -and $_.form.Tag.editor -and -not $_.form.Tag.editor.IsDisposed })
  if ($editing.Count -eq 0) { $f.Close() }
}); $t.Start()
Write-Log "affiché $(@($m.marks).Count) marque(s) dont $(@($m.marks | ? { $_.kind -eq 'sticky' }).Count) post-it(s), ttl $ttl s, OCR: $(($needles | % { "'$_'=$(@($found[$_]).Count)" }) -join ' ')"
try { [System.Windows.Forms.Application]::Run($f) } catch { Write-Log "erreur: $_" }
Write-Log 'fermé'
