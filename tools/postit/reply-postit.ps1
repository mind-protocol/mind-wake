param([switch]$Library,[switch]$Listen,[string]$Cli='',[string]$DataDir='',[string]$ResponseDir='',[string]$ReadyFile='')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('ReplyPostitForm' -as [type])) { Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System; using System.Windows.Forms; using System.Drawing;
public class ReplyPostitForm : Form {
 protected override bool ShowWithoutActivation { get { return true; } }
 protected override CreateParams CreateParams { get { var p=base.CreateParams; p.ExStyle |= 0x80; return p; } }
 // Human clicks can activate the TextBox; no WS_EX_NOACTIVATE.
}
'@
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
 } catch { $s.status.Text='Envoi non confirme ; texte conserve. Reessaie.' }
}
function New-ReplyPostit($Transport, [string]$ReplyTo='', $Point=$null, $ParentNote=$null) {
 foreach ($p in @($Transport.cli,$Transport.data_dir,$Transport.response_dir)) {
  if (-not [IO.Path]::IsPathRooted($p) -or "$p".Contains('"')) { throw 'Transport absolu explicite requis' }
 }
 if ($ReplyTo -and $ReplyTo -notmatch '^[A-Za-z0-9_.:-]{1,120}$') { throw 'reply_to invalide' }
 $form=New-Object ReplyPostitForm
 $form.Text='Marco - Repondre'; $form.FormBorderStyle='FixedToolWindow'; $form.TopMost=$true
 $form.ShowInTaskbar=$false; $form.StartPosition='Manual'; $form.ClientSize=New-Object Drawing.Size 440,258
 $form.BackColor=[Drawing.Color]::FromArgb(240,250,215); $form.Font=New-Object Drawing.Font 'Segoe UI',10
 $area=[Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea
 # Keep the clicked application's native context menu clear. The target remains
 # the original physical click, independently of this editor's position.
 $pos=if($Point) {
  $px=if([int]$Point.x -lt ($area.Left+$area.Width/2)) {$area.Right-456} else {$area.Left+12}
  New-Object Drawing.Point $px,([int]$Point.y+16)
 } else {[Windows.Forms.Cursor]::Position}
 $form.Location=New-Object Drawing.Point ([Math]::Max($area.Left,[Math]::Min($pos.X,$area.Right-456))),([Math]::Max($area.Top,[Math]::Min($pos.Y,$area.Bottom-292)))
 $label=New-Object Windows.Forms.Label; $label.Text=if($ReplyTo){'Repondre au post-it : '+$ReplyTo}else{'Parler a Marco'}; $label.Bounds=New-Object Drawing.Rectangle 12,10,410,27
 $input=New-Object Windows.Forms.TextBox; $input.Multiline=$true; $input.AcceptsReturn=$true; $input.MaxLength=4000; $input.ScrollBars='Vertical'; $input.Bounds=New-Object Drawing.Rectangle 12,40,414,128
 $send=New-Object Windows.Forms.Button; $send.Text='Envoyer'; $send.Bounds=New-Object Drawing.Rectangle 320,178,106,32
 $close=New-Object Windows.Forms.Button; $close.Text='Fermer'; $close.Bounds=New-Object Drawing.Rectangle 204,178,106,32; $close.DialogResult='Cancel'
 $status=New-Object Windows.Forms.Label; $status.Bounds=New-Object Drawing.Rectangle 12,216,414,38
 $status.Text=if($Point){'Envoyer ou Bumpe : une capture et le point du clic joints.'}else{'Entree : envoyer ; Maj+Entree : ligne ; Echap : fermer.'}
 $form.Controls.AddRange(@($label,$input,$send,$close,$status)); $form.CancelButton=$close
 $form.Tag=@{input=$input;status=$status;transport=$Transport;replyTo=$ReplyTo;point=$Point;file=$null;pending=$false;parent=$ParentNote}
 $send.Tag=$form; $send.Add_Click({param($s,$e) Send-FreeformPostit $s.Tag})
 $close.Tag=$form; $close.Add_Click({param($s,$e) $s.Tag.Close()})
 $input.Tag=$form; $input.Add_KeyDown({param($s,$e) if($e.KeyCode -eq 'Enter' -and -not $e.Shift) {$e.SuppressKeyPress=$true; Send-FreeformPostit $s.Tag}})
 if ($Point) {
  $bump=New-Object Windows.Forms.Button; $bump.Text='Bumpe'; $bump.Bounds=New-Object Drawing.Rectangle 12,178,100,32
  $bump.Tag=$form; $bump.Add_Click({param($s,$e) Send-FreeformPostit $s.Tag $true}); $form.Controls.Add($bump)
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
