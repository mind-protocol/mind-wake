$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing,System.Windows.Forms
  Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public static class WakeVisualContext {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int n, StringBuilder s, int length, out int needed);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static bool Locked() {
    IntPtr d=OpenInputDesktop(0,false,1); if(d==IntPtr.Zero) return true;
    try { int needed; var name=new StringBuilder(256);
      return !GetUserObjectInformation(d,2,name,512,out needed) || name.ToString()!="Default";
    } finally { CloseDesktop(d); }
  }
  public static Bitmap Grab(bool primary, string executable) {
    if(Locked()) return null;
    SetProcessDPIAware();
    if(primary) {
      var b=Screen.PrimaryScreen.Bounds;
      if(b.Width<=0 || b.Height<=0 || (long)b.Width*b.Height>40000000) return null;
      var bitmap=new Bitmap(b.Width,b.Height);
      try { using(var g=Graphics.FromImage(bitmap)) g.CopyFromScreen(b.Left,b.Top,0,0,b.Size); }
      catch { bitmap.Dispose(); throw; }
      if(Locked()) { bitmap.Dispose(); return null; } return bitmap;
    }
    foreach(var process in Process.GetProcessesByName("mind-wake-desktop")) {
      using(process) { try {
        if(!String.Equals(process.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase)) continue;
        var h=process.MainWindowHandle; Rect r;
        if(h==IntPtr.Zero || IsIconic(h) || !IsWindowVisible(h) || !GetWindowRect(h,out r)) continue;
        int w=r.Right-r.Left, height=r.Bottom-r.Top;
        if(w<=0 || height<=0 || (long)w*height>40000000) return null;
        var bitmap=new Bitmap(w,height); bool ok;
        try { using(var g=Graphics.FromImage(bitmap)) { var dc=g.GetHdc(); try { ok=PrintWindow(h,dc,2); } finally { g.ReleaseHdc(dc); } } }
        catch { bitmap.Dispose(); throw; }
        if(!ok || Locked()) { bitmap.Dispose(); return null; } return bitmap;
      } catch { continue; } }
    }
    return null;
  }
}
'@
  $original = [WakeVisualContext]::Grab(($env:MIND_WAKE_CAPTURE_SURFACE -eq 'primary'), $env:MIND_WAKE_CAPTURE_DESKTOP)
  if ($null -eq $original) { [Console]::Out.WriteLine('{"skipped":true}'); exit 0 }
  $capturedAt = [DateTime]::UtcNow.ToString('o')
  try {
    $scale = [Math]::Min(1.0, 1280.0 / [Math]::Max($original.Width,$original.Height))
    $width = [Math]::Max(1,[int][Math]::Floor($original.Width*$scale))
    $height = [Math]::Max(1,[int][Math]::Floor($original.Height*$scale))
    $small = New-Object System.Drawing.Bitmap($width,$height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($small)
      try { $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $graphics.DrawImage($original,0,0,$width,$height) } finally { $graphics.Dispose() }
      $stream = New-Object System.IO.MemoryStream
      $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
      try {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
        $small.Save($stream,$codec,$parameters)
        if ($stream.Length -gt 1048576 -or [WakeVisualContext]::Locked()) { [Console]::Out.WriteLine('{"skipped":true}'); exit 0 }
        $result = @{ mediaType='image/jpeg'; base64=[Convert]::ToBase64String($stream.ToArray()); capturedAt=$capturedAt; width=$width; height=$height; surface=$env:MIND_WAKE_CAPTURE_SURFACE }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
      } finally { $parameters.Dispose(); $stream.Dispose() }
    } finally { $small.Dispose() }
  } finally { $original.Dispose() }
} catch { [Console]::Out.WriteLine('{"skipped":true}') }
