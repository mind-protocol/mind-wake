$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../src/daemon/wake-screenshot-native.ps1') -Raw
$csharp = [regex]::Match($source, "(?s)@'\r?\n(.*?)\r?\n'@").Groups[1].Value
if (-not $csharp) { throw 'Native capture source missing' }
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition $csharp

# Synthetic bitmap only: no screen or user data is captured.
$image = New-Object System.Drawing.Bitmap(200,100)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  try { $graphics.Clear([System.Drawing.Color]::Black) } finally { $graphics.Dispose() }
  $bounds = New-Object System.Drawing.Rectangle(-400,-200,800,400)
  if (-not [WakeVisualContext]::ClickInsideBounds($bounds,'-400','-200')) { throw 'Actual negative-origin edge must remain valid' }
  if ([WakeVisualContext]::ClickInsideBounds($bounds,'400','0')) { throw 'Out-of-surface point must refuse capture' }
  if ([WakeVisualContext]::ClickInsideBounds($bounds,'0','200')) { throw 'Bottom exclusive bound must refuse capture' }
  if ([WakeVisualContext]::ClickInsideBounds($bounds,'2147483648','0')) { throw 'Overflow point must refuse capture' }
  if ([WakeVisualContext]::ClickInsideBounds($bounds,'bad','0')) { throw 'Malformed point must refuse capture' }
  if (-not [WakeVisualContext]::ClickIsFresh(1000,31000)) { throw 'Fresh-click boundary must remain valid' }
  if ([WakeVisualContext]::ClickIsFresh(1000,31001)) { throw 'Old click must refuse capture' }
  if ([WakeVisualContext]::ClickIsFresh(1001,1000)) { throw 'Future click must refuse capture' }
  [WakeVisualContext]::MarkClick($image,$bounds,0,0)
  $ring = $image.GetPixel(114,50)
  if ($ring.R -lt 220 -or $ring.G -gt 50 -or $ring.B -gt 50) { throw 'Expected red ring at scaled click position' }
  if ($image.GetPixel(100,50).ToArgb() -ne [System.Drawing.Color]::Black.ToArgb()) { throw 'Circle must leave click center visible' }
  $before = $image.GetPixel(14,0).ToArgb()
  [WakeVisualContext]::MarkClick($image,$bounds,-401,-200)
  if ($image.GetPixel(14,0).ToArgb() -ne $before) { throw 'Out-of-bounds click must not be clamped onto image' }
  [WakeVisualContext]::MarkClick($image,$bounds,-400,-200)
  if ($image.GetPixel(14,0).R -lt 220) { throw 'Edge click must be clipped without moving its center' }
  Write-Output 'PASS: scaled red circle, negative screen origin, visible center, clipped edge, out-of-surface/malformed/overflow point refuses capture.'
} finally { $image.Dispose() }
