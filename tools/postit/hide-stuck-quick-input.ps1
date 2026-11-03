# Hide ONLY the verified Tauri quick-input HWND; never stop a process or daemon.
param([Parameter(Mandatory=$true)][long]$Hwnd,[Parameter(Mandatory=$true)][int]$ExpectedPid)
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class QuickInputHide {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
$handle=[IntPtr]$Hwnd; [uint32]$ownerPid=0
$null=[QuickInputHide]::GetWindowThreadProcessId($handle,[ref]$ownerPid)
if($ownerPid -ne $ExpectedPid){throw 'HWND owner changed; no action'}
$p=Get-Process -Id $ExpectedPid
if($p.ProcessName -ne 'mind-wake-desktop'){throw 'Not MIND desktop; no action'}
$title=New-Object Text.StringBuilder 256
$null=[QuickInputHide]::GetWindowText($handle,$title,256)
if($title.ToString() -notin @('Talk to Wake','Parler a Wake',"Parler $([char]0xe0) Wake")){throw 'Not quick-input title; no action'}
$null=[QuickInputHide]::ShowWindow($handle,0)
@{hwnd=$Hwnd;pid=$ExpectedPid;title=$title.ToString();hidden=(-not [QuickInputHide]::IsWindowVisible($handle));process_stopped=$false}|ConvertTo-Json -Compress
