param([switch]$Library,[switch]$Listen,[string]$Cli='',[string]$DataDir='',[string]$ResponseDir='',[string]$ReadyFile='')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('ReplyPostitForm' -as [type])) { Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System; using System.Windows.Forms; using System.Drawing; using System.Drawing.Drawing2D; using System.Runtime.InteropServices;
public static class ReplyGeometry {
 public static GraphicsPath Round(Rectangle r,int radius) { var p=new GraphicsPath();int d=radius*2;p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p; }
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 public static void InitDpi(){try{SetThreadDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}}
}
public class ReplyPostitForm : Form {
 [DllImport("user32.dll")] static extern bool ReleaseCapture();
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,int m,IntPtr w,IntPtr l);
 public ReplyPostitForm(){DoubleBuffered=true;}
 protected override bool ShowWithoutActivation { get { return true; } }
 protected override CreateParams CreateParams { get { var p=base.CreateParams;p.ExStyle|=0x80;return p; } }
 public void BeginDrag(){ReleaseCapture();SendMessage(Handle,0xA1,new IntPtr(2),IntPtr.Zero);}
 protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);if(e.Button==MouseButtons.Left&&e.Y<72)BeginDrag();}
 protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);if(Width>32&&Height>32){using(var p=ReplyGeometry.Round(new Rectangle(0,0,Width,Height),16)){var old=Region;Region=new Region(p);if(old!=null)old.Dispose();}}}
 protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var p=ReplyGeometry.Round(new Rectangle(0,0,Width-1,Height-1),16))using(var pen=new Pen(Color.FromArgb(210,220,213))){e.Graphics.DrawPath(pen,p);}}
 // Human clicks can activate the TextBox; no WS_EX_NOACTIVATE.
}
public class ReplyCardPanel : Panel {
 public ReplyCardPanel(){DoubleBuffered=true;}
 protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var p=ReplyGeometry.Round(new Rectangle(0,0,Width-1,Height-1),10))using(var b=new SolidBrush(Color.White))using(var pen=new Pen(ContainsFocus?Color.FromArgb(55,119,87):Color.FromArgb(218,225,219))){e.Graphics.FillPath(b,p);e.Graphics.DrawPath(pen,p);}}
 protected override void OnEnter(EventArgs e){base.OnEnter(e);Invalidate();}
 protected override void OnLeave(EventArgs e){base.OnLeave(e);Invalidate();}
}
public class ReplyCardButton : Button {
 bool hover=false;
 public ReplyCardButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
 protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
 protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
 protected override void OnPaint(PaintEventArgs e){e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;var c=BackColor;if(hover&&Enabled)c=ControlPaint.Dark(c,0.04f);using(var p=ReplyGeometry.Round(new Rectangle(0,0,Width-1,Height-1),9))using(var b=new SolidBrush(c)){e.Graphics.FillPath(b,p);}TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Enabled?ForeColor:Color.FromArgb(125,139,130),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);if(Focused)ControlPaint.DrawFocusRectangle(e.Graphics,new Rectangle(5,5,Width-10,Height-10));}
}
public class ReplyReactionButton : Button {
 public string Symbol {get;set;}
 bool hover;
 public ReplyReactionButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
 protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
 protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
 protected override void OnPaint(PaintEventArgs e){
  float s=DeviceDpi/96f; e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
  using(var p=ReplyGeometry.Round(new Rectangle(0,0,Width-1,Height-1),12))
  using(var b=new SolidBrush(hover?Color.FromArgb(230,240,232):Color.White))
  using(var pen=new Pen(hover||Focused?Color.FromArgb(33,102,77):Color.FromArgb(214,224,217),hover||Focused?2:1)){
   e.Graphics.FillPath(b,p);e.Graphics.DrawPath(pen,p);
  }
  using(var emoji=new Font("Segoe UI Emoji",22f)){
   TextRenderer.DrawText(e.Graphics,Symbol,emoji,new Rectangle(0,(int)(8*s),Width,(int)(40*s)),ForeColor,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
  }
  TextRenderer.DrawText(e.Graphics,Text,Font,new Rectangle(0,(int)(51*s),Width,(int)(24*s)),ForeColor,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
 }
}
'@
}
[ReplyGeometry]::InitDpi()
function Resolve-ReplyPostitPosition($Point, $Area, [int]$Width, [int]$Height) {
 $x=[int]$Point.x+12; $y=[int]$Point.y+12
 if($x+$Width -gt $Area.Right){$x=[int]$Point.x-$Width-12}
 if($y+$Height -gt $Area.Bottom){$y=[int]$Point.y-$Height-12}
 return New-Object Drawing.Point ([Math]::Max($Area.Left,[Math]::Min($x,$Area.Right-$Width))),([Math]::Max($Area.Top,[Math]::Min($y,$Area.Bottom-$Height)))
}
function Start-FreeformPostitReply($state) {
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName='node'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
 $info.Arguments='"'+(Join-Path $PSScriptRoot 'postit-reply.mjs')+'" --selection "'+$state.file+'" --cli "'+$state.transport.cli+'" --data-dir "'+$state.transport.data_dir+'"'
 $null=[Diagnostics.Process]::Start($info)
}
function Send-FreeformPostit($form, [bool]$Bumpe=$false) {
 $s=$form.Tag
 if ($s.pending) { return }
 if ($s.questionForm) { Send-QuestionOther $form; return }
 $text=$s.input.Text.Trim()
 if ($Bumpe) {
   $prompt=Join-Path $s.transport.data_dir 'workspace/artifacts/prompts/bump.md'
   if (-not (Test-Path -LiteralPath $prompt)) { $s.status.Text='Prompt Bumpe absent : aucun envoi.'; return }
   $text=[IO.File]::ReadAllText($prompt).Trim()+"`n`nBumpe - targeted invitation: your human invites you to contribute based on the exact point of their right click, circled in red in the attached screenshot. Connect your suggestion or question to that point and explain its context and value to the conversation. Any text being typed in the menu remains a separate draft."
   if ($text.Length -gt 3232) { $s.status.Text='Prompt Bumpe trop long : aucun envoi.'; return }
 }
 if (-not $text) { $s.input.Focus(); return }
 if ($s.replyTo) { $text="Reponse au post-it [$($s.replyTo)] :`n"+$text }
 if ($text.Length -gt 4000) { $s.status.Text='Message trop long (4000 caracteres maximum).'; return }
 if (-not $s.file) {
   $id=if ($Bumpe) {'ui-bumpe-'+[Guid]::NewGuid().ToString()} else {'postit:'+([Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N'))}
   $s.file=Join-Path $s.transport.response_dir (($id -replace ':','-')+'.json')
   $s.selection=[ordered]@{schema='mind.postit.message.v1';message_id=$id;text=$text;capture=[bool]$s.point;point=$s.point;reply_to=$s.replyTo;clicked_at=[DateTime]::UtcNow.ToString('o')}
 }
 try {
   [void][IO.Directory]::CreateDirectory($s.transport.response_dir)
   if (-not (Test-Path -LiteralPath $s.file)) {
    $stream=New-Object IO.FileStream $s.file,([IO.FileMode]::CreateNew),([IO.FileAccess]::Write),([IO.FileShare]::None)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($s.selection | ConvertTo-Json -Compress -Depth 8)); $stream.Write($bytes,0,$bytes.Length) } finally {$stream.Dispose()}
   }
   Start-FreeformPostitReply $s
   $s.pending=$true
   $form.Close()
   if ($s.parent -and -not $s.parent.IsDisposed) { $s.parent.Close() }
 } catch { $s.status.ForeColor=[Drawing.Color]::FromArgb(162,60,44); $s.status.Text='Envoi non confirmé. Ton message est conservé ; réessaie.' }
}
function New-ReplyPostit($Transport, [string]$ReplyTo='', $Point=$null, $ParentNote=$null) {
 foreach ($p in @($Transport.cli,$Transport.data_dir,$Transport.response_dir)) {
  if (-not [IO.Path]::IsPathRooted($p) -or "$p".Contains('"')) { throw 'Transport absolu explicite requis' }
 }
 if ($ReplyTo -and $ReplyTo -notmatch '^[A-Za-z0-9_.:-]{1,120}$') { throw 'reply_to invalide' }
 $form=New-Object ReplyPostitForm
 $form.Text='Écrire à Marco'; $form.FormBorderStyle='None'; $form.TopMost=$true
 $form.ShowInTaskbar=$false; $form.StartPosition='Manual'; $form.ClientSize=New-Object Drawing.Size 460,326
 $form.AutoScaleMode=[Windows.Forms.AutoScaleMode]::Dpi
 $ivory=[Drawing.Color]::FromArgb(247,248,244)
 $ink=[Drawing.Color]::FromArgb(34,49,47)
 $muted=[Drawing.Color]::FromArgb(100,116,110)
 $green=[Drawing.Color]::FromArgb(33,102,77)
 $border=[Drawing.Color]::FromArgb(211,221,215)
 $form.BackColor=$ivory; $form.ForeColor=$ink; $form.Font=New-Object Drawing.Font 'Segoe UI',10
 $anchor=if($Point){New-Object Drawing.Point ([int]$Point.x),([int]$Point.y)}else{[Windows.Forms.Cursor]::Position}
 $area=[Windows.Forms.Screen]::FromPoint($anchor).WorkingArea
 $form.Location=Resolve-ReplyPostitPosition $anchor $area $form.Width $form.Height
 $form.Add_Shown({param($s,$e) $s.Location=Resolve-ReplyPostitPosition $s.Tag.anchor $s.Tag.area $s.Width $s.Height})
 $accent=New-Object Windows.Forms.Panel; $accent.BackColor=$green; $accent.Bounds=New-Object Drawing.Rectangle 20,18,4,25; $accent.Anchor='Top,Left,Right'
 $label=New-Object Windows.Forms.Label; $label.Text='Écrire à Marco'; $label.Font=New-Object Drawing.Font 'Segoe UI',15,([Drawing.FontStyle]::Bold); $label.Bounds=New-Object Drawing.Rectangle 32,16,355,30; $label.Tag=$form; $label.Add_MouseDown({param($s,$e) if($e.Button -eq 'Left'){$s.Tag.BeginDrag()}})
 $context=New-Object Windows.Forms.Label; $context.ForeColor=$muted; $context.Bounds=New-Object Drawing.Rectangle 21,53,418,23; $context.Tag=$form; $context.Add_MouseDown({param($s,$e) if($e.Button -eq 'Left'){$s.Tag.BeginDrag()}})
 $context.Text=if($ReplyTo){'La conversation continue ici.'}elseif($Point){'Ton message, avec le contexte de ton clic.'}else{'Une idée, une question, un retour.'}
 $input=New-Object Windows.Forms.TextBox; $input.Multiline=$true; $input.AcceptsReturn=$true; $input.MaxLength=4000; $input.ScrollBars='Vertical'; $input.Bounds=New-Object Drawing.Rectangle 12,12,394,92
 $input.BackColor=[Drawing.Color]::White; $input.ForeColor=$ink; $input.BorderStyle='None'; $input.Font=New-Object Drawing.Font 'Segoe UI',11; $input.TabIndex=0
 $inputPanel=New-Object ReplyCardPanel; $inputPanel.Bounds=New-Object Drawing.Rectangle 20,86,420,116; $inputPanel.BackColor=$ivory; $inputPanel.Controls.Add($input)
 $input.AccessibleName='Ton message'; $input.AccessibleDescription='Entrée pour envoyer. Maj+Entrée pour une nouvelle ligne.'
 $counter=New-Object Windows.Forms.Label; $counter.ForeColor=$muted; $counter.Bounds=New-Object Drawing.Rectangle 310,204,130,16; $counter.TextAlign='TopRight'; $counter.Font=New-Object Drawing.Font 'Segoe UI',8; $counter.Text='0 / 4 000'
 $send=New-Object ReplyCardButton; $send.Text='Envoyer'; $send.Bounds=New-Object Drawing.Rectangle 326,221,114,36; $send.TabIndex=1
 $close=New-Object ReplyCardButton; $close.Text='×'; $close.AccessibleName='Fermer'; $close.Font=New-Object Drawing.Font 'Segoe UI',16; $close.Bounds=New-Object Drawing.Rectangle 408,14,32,32; $close.DialogResult='Cancel'; $close.TabIndex=3
 foreach($button in @($send,$close)) {
  $button.UseVisualStyleBackColor=$false; $button.FlatStyle='Flat'; $button.FlatAppearance.BorderSize=1; $button.FlatAppearance.BorderColor=$border
  $button.BackColor=$ivory; $button.ForeColor=$ink; $button.Cursor=[Windows.Forms.Cursors]::Hand
 }
 $send.BackColor=$green; $send.ForeColor=[Drawing.Color]::White; $send.FlatAppearance.BorderColor=$green; $send.Font=New-Object Drawing.Font 'Segoe UI',10,([Drawing.FontStyle]::Bold)
 $send.FlatAppearance.MouseOverBackColor=[Drawing.Color]::FromArgb(26,84,63)
 $send.Enabled=$false
 $close.FlatAppearance.MouseOverBackColor=[Drawing.Color]::FromArgb(233,239,233)
 $status=New-Object Windows.Forms.Label; $status.ForeColor=$muted; $status.Bounds=New-Object Drawing.Rectangle 20,270,420,42; $status.Font=New-Object Drawing.Font 'Segoe UI',9
 $status.Text=if($Point){"Capture de l’écran jointe · point du clic cerclé"+"`n"+'Entrée : envoyer · Maj+Entrée : ligne · Échap : fermer'}else{'Aucune capture jointe'+"`n"+'Entrée : envoyer · Maj+Entrée : ligne · Échap : fermer'}
 $form.Controls.AddRange(@($accent,$label,$context,$inputPanel,$counter,$send,$close,$status)); $form.CancelButton=$close
 $tips=New-Object Windows.Forms.ToolTip; $tips.SetToolTip($send,'Envoyer et fermer le formulaire'); $tips.SetToolTip($close,'Fermer sans envoyer (Échap)')
 $form.Tag=@{input=$input;status=$status;counter=$counter;send=$send;tips=$tips;transport=$Transport;replyTo=$ReplyTo;point=$Point;file=$null;pending=$false;parent=$ParentNote;anchor=$anchor;area=$area}
 $input.Add_TextChanged({param($s,$e) $state=$s.Tag.Tag; $state.counter.Text=('{0:N0} / 4 000' -f $s.Text.Length); $state.send.Enabled=(-not $state.pending -and $s.Text.Trim().Length -gt 0)})
 $send.Tag=$form; $send.Add_Click({param($s,$e) Send-FreeformPostit $s.Tag})
 $close.Tag=$form; $close.Add_Click({param($s,$e) $s.Tag.Close()})
 $input.Tag=$form; $input.Add_KeyDown({param($s,$e) if($e.KeyCode -eq 'Enter' -and -not $e.Shift) {$e.SuppressKeyPress=$true; Send-FreeformPostit $s.Tag}})
 $form.Add_FormClosed({param($s,$e) $s.Tag.tips.Dispose()})
 if ($Point) {
  $bump=New-Object ReplyCardButton; $bump.Text='Bumpe'; $bump.Bounds=New-Object Drawing.Rectangle 20,221,100,36; $bump.TabIndex=2; $bump.UseVisualStyleBackColor=$false; $bump.FlatStyle='Flat'; $bump.FlatAppearance.BorderColor=$border; $bump.BackColor=[Drawing.Color]::FromArgb(232,240,233); $bump.ForeColor=$green; $bump.Cursor=[Windows.Forms.Cursors]::Hand
  $bump.Tag=$form; $bump.Add_Click({param($s,$e) Send-FreeformPostit $s.Tag $true}); $form.Controls.Add($bump)
  $tips.SetToolTip($bump,'Inviter Marco à réagir au point du clic, sans envoyer ton brouillon')
 }
 return $form
}
if ($Library) { return }
if (-not $Listen) { throw 'Use -Library or -Listen with explicit CLI/data/response paths.' }
# Observer only: never consumes mouse events and never captures the screen.
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System; using System.Runtime.InteropServices; using System.Collections.Concurrent; using System.Diagnostics; using System.Windows.Forms;
public static class PostitRightClick {
 public struct Click { public int X,Y; public long At; public string Root; }
 [StructLayout(LayoutKind.Sequential)] struct P {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] struct M {public P pt; public uint data,flags,time; public UIntPtr extra;}
 delegate IntPtr Hook(int n,IntPtr w,IntPtr l);
 static Hook callback=OnMouse; static IntPtr hook;
 public static ConcurrentQueue<Click> Clicks=new ConcurrentQueue<Click>();
 [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,Hook cb,IntPtr mod,uint thread);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h,int n,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(P p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string s);
 static IntPtr OnMouse(int n,IntPtr w,IntPtr l) {
  if(n>=0 && w.ToInt64()==0x205) {
   M m=(M)Marshal.PtrToStructure(l,typeof(M));
   IntPtr root=GetAncestor(WindowFromPoint(m.pt),2); uint pid; GetWindowThreadProcessId(root,out pid);
   if((m.flags&1)==0 && pid!=(uint)Process.GetCurrentProcess().Id) Clicks.Enqueue(new Click{X=m.pt.X,Y=m.pt.Y,At=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Root=root.ToInt64().ToString()});
  }
  return CallNextHookEx(hook,n,w,l);
 }
 public static void Start(){hook=SetWindowsHookEx(14,callback,GetModuleHandle(null),0); if(hook==IntPtr.Zero)throw new Exception("Mouse observer unavailable");}
 public static void Stop(){if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);}
 public static object Next(){Click c;return Clicks.TryDequeue(out c)?(object)c:null;}
}
'@
$transport=[pscustomobject]@{cli=$Cli;data_dir=$DataDir;response_dir=$ResponseDir}
$probe=New-ReplyPostit $transport; $probe.Dispose()
$mutex=New-Object Threading.Mutex($false,('Local\MindWakePostit-'+([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($DataDir)) -replace '[^A-Za-z0-9]','')))
if (-not $mutex.WaitOne(0)) { throw 'Post-it observer already running for this instance' }
$context=New-Object Windows.Forms.ApplicationContext
$script:activeReply=$null
$tray=New-Object Windows.Forms.NotifyIcon; $tray.Icon=[Drawing.SystemIcons]::Information; $tray.Text='Marco - clic droit post-it'; $tray.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip
$exit=$menu.Items.Add('Arreter le clic droit post-it'); $exit.Add_Click({[Windows.Forms.Application]::ExitThread()}); $tray.ContextMenuStrip=$menu
$timer=New-Object Windows.Forms.Timer; $timer.Interval=100
$timer.Add_Tick({
 $c=[PostitRightClick]::Next()
 if (-not $c) {return}
 while ($next=[PostitRightClick]::Next()) {$c=$next}
 if ($script:activeReply -and -not $script:activeReply.IsDisposed) {return}
 $point=[pscustomobject]@{x=$c.X;y=$c.Y;at_ms=$c.At;root_window=$c.Root}
 $script:activeReply=New-ReplyPostit $transport '' $point
 $script:activeReply.Show()
})
try {
 [PostitRightClick]::Start(); $timer.Start()
 if($ReadyFile){[IO.File]::WriteAllText($ReadyFile,('{"status":"listening","pid":'+$PID+'}'))}
 [Windows.Forms.Application]::Run($context)
}
finally { $timer.Stop(); [PostitRightClick]::Stop(); if($script:activeReply){$script:activeReply.Dispose()};$tray.Dispose();$context.Dispose();$mutex.ReleaseMutex();$mutex.Dispose() }
