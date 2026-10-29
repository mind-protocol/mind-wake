# Visible, user-controlled text-field observer. No low-level keyboard hook.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Text;
public static class WakeInputWindow {
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int max);
  [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window,int index);
  public static bool PlainNativeEdit(int handle) {
    if(handle==0) return false;
    IntPtr window=new IntPtr(handle);var name=new StringBuilder(256);
    if(GetClassName(window,name,256)==0) return false;
    var cls=name.ToString();
    if(!String.Equals(cls,"Edit",StringComparison.OrdinalIgnoreCase) && !cls.StartsWith("WindowsForms10.EDIT.",StringComparison.OrdinalIgnoreCase)) return false;
    return (GetWindowLong(window,-16) & (0x20|0x800))==0;
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendText(IntPtr window,uint message,IntPtr count,StringBuilder buffer,uint flags,uint timeout,out UIntPtr result);
  public static string ReadPlainEdit(int handle) {
    if(!PlainNativeEdit(handle)) return null;
    var text=new StringBuilder(32769);UIntPtr result;
    if(SendText(new IntPtr(handle),0xD,new IntPtr(32769),text,2,100,out result)==IntPtr.Zero || result.ToUInt64()>=32768 || !PlainNativeEdit(handle)) return null;
    return text.ToString();
  }
  public static Task<string> ReadCommand() { return Task.Run(() => Console.In.ReadLine()); }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
$script:paused = $false
$script:stop = $false
$script:lastId = ''
$script:lastValue = ''
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)) }
function Reset-Baseline { $script:lastId=''; $script:lastValue=''; $script:text=''; $script:old=''; $script:inserted='' }
$icon = New-Object System.Windows.Forms.NotifyIcon
$bitmap = New-Object System.Drawing.Bitmap(32,32)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.FillEllipse([System.Drawing.Brushes]::DarkRed,0,0,31,31)
$font = New-Object System.Drawing.Font('Arial',18,[System.Drawing.FontStyle]::Bold)
$graphics.DrawString('T',$font,[System.Drawing.Brushes]::White,5,1)
$handle = $bitmap.GetHicon()
$icon.Icon = [System.Drawing.Icon]::FromHandle($handle)
$icon.Text = 'MIND Wake - partage du texte ACTIF'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$pauseItem = $menu.Items.Add('Mettre le partage du texte en pause')
$pauseItem.add_Click({
  $script:paused = -not $script:paused
  Reset-Baseline
  $icon.Text = $(if($script:paused){'MIND Wake - partage du texte EN PAUSE'}else{'MIND Wake - partage du texte ACTIF'})
  $pauseItem.Text = $(if($script:paused){'Reprendre le partage du texte'}else{'Mettre le partage du texte en pause'})
  Emit @{type='status';state=$(if($script:paused){'paused'}else{'active'})}
})
$stopItem = $menu.Items.Add('Arreter le partage du texte')
$stopItem.add_Click({ Emit @{type='status';state='stopped'}; $script:stop=$true })
$icon.ContextMenuStrip=$menu
$icon.Visible=$true
Emit @{type='status';state='active'}
$command=[WakeInputWindow]::ReadCommand()
$heartbeat=[DateTime]::UtcNow
try {
  while(-not $script:stop) {
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.Application]::DoEvents()
    if($command.IsCompleted) {
      $value=$command.GetAwaiter().GetResult()
      if($null -eq $value -or $value -eq 'stop'){break}
      $command=[WakeInputWindow]::ReadCommand()
    }
    if(([DateTime]::UtcNow-$heartbeat).TotalSeconds -ge 1){Emit @{type='heartbeat'};$heartbeat=[DateTime]::UtcNow}
    if($script:paused){Start-Sleep -Milliseconds 200;continue}
    try {
      $window=[WakeInputWindow]::GetForegroundWindow()
      [uint32]$processId=0
      [void][WakeInputWindow]::GetWindowThreadProcessId($window,[ref]$processId)
      if($processId -eq 0){Reset-Baseline;continue}
      $process=[System.Diagnostics.Process]::GetProcessById($processId)
      try {$app=$process.ProcessName} finally {$process.Dispose()}
      if($app -match '(?i)^(1password|bitwarden|keepass.*|dashlane|keeper|lastpass|CredentialUIBroker|LogonUI|LockApp|consent)$'){Reset-Baseline;continue}
      $element=[System.Windows.Automation.AutomationElement]::FocusedElement
      if($null -eq $element -or $element.Current.ProcessId -ne $processId -or $element.Current.IsOffscreen){Reset-Baseline;continue}
      $legacy=$null
      $legacyEditable=$false
      $legacyType="System.Windows.Automation.LegacyIAccessiblePattern" -as [type]
      if($null -ne $legacyType -and $element.TryGetCurrentPattern(($legacyType::Pattern),[ref]$legacy)){
        $legacyState=[uint32]$legacy.Current.State
        $legacyEditable=($legacy.Current.Role -eq 42 -and ($legacyState -band 0x20000040) -eq 0)
      }
      $protected=$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty,$true)
      if($protected -eq [System.Windows.Automation.AutomationElement]::NotSupported){
        if(-not $legacyEditable -and -not [WakeInputWindow]::PlainNativeEdit($element.Current.NativeWindowHandle)){Reset-Baseline;continue}
      }elseif($protected -ne $false){Reset-Baseline;continue}
      $type=$element.Current.ControlType
      $nativeEdit=[WakeInputWindow]::PlainNativeEdit($element.Current.NativeWindowHandle)
      if(-not $nativeEdit -and -not $legacyEditable -and $type -ne [System.Windows.Automation.ControlType]::Edit -and $type -ne [System.Windows.Automation.ControlType]::Document){Reset-Baseline;continue}
      if($element.Current.Name -match '(?i)password|mot.?de.?passe|one.?time|verification|v.rification|security.?code|pin.?code|api.?key|token|secret|seed.?phrase|recovery'){Reset-Baseline;continue}
      $pattern=$null
      if($nativeEdit){
        $text=[WakeInputWindow]::ReadPlainEdit($element.Current.NativeWindowHandle)
      }elseif($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){
        if($pattern.Current.IsReadOnly){Reset-Baseline;continue}
        $text=$pattern.Current.Value
      }elseif($legacyEditable){
        $text=$legacy.Current.Value
      }else{
        $pattern=$null
        if(-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){Reset-Baseline;continue}
        $readOnly=$pattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
        if($readOnly -ne $false){Reset-Baseline;continue}
        $text=$pattern.DocumentRange.GetText(32769)
      }
      if($null -eq $text -or $text.Length -gt 32768){Reset-Baseline;continue}
      if($text -match '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]') { Emit @{type='redact'};Reset-Baseline;continue }
      $id=[string]$processId+':'+[string]::Join(',',$element.GetRuntimeId())
      if($script:lastId -eq $id -and $script:lastValue -ne $text){
        $old=$script:lastValue
        $prefix=0
        while($prefix -lt $old.Length -and $prefix -lt $text.Length -and $old[$prefix] -eq $text[$prefix]){$prefix++}
        $suffix=0
        while($suffix -lt ($old.Length-$prefix) -and $suffix -lt ($text.Length-$prefix) -and $old[$old.Length-1-$suffix] -eq $text[$text.Length-1-$suffix]){$suffix++}
        $inserted=$text.Substring($prefix,$text.Length-$prefix-$suffix)
        if($inserted.Length -gt 0){Emit @{type='text';app=$app;text=$inserted;at=[DateTime]::UtcNow.ToString('o');protected=$false;editable=$true}}
      }
      $script:lastId=$id;$script:lastValue=$text
    }catch{Reset-Baseline}
  }
}finally{
  Reset-Baseline
  $icon.Visible=$false
  $icon.Dispose();$menu.Dispose();$font.Dispose();$graphics.Dispose();$bitmap.Dispose()
  [void][WakeInputWindow]::DestroyIcon($handle)
}
