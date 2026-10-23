# Bench driver for the PACKAGED POS (no CDP, RT-164). Runbook §13 rules:
#  - selects exactly ONE "POS Pulse.exe" main process whose command line has the expected --user-data-dir;
#  - refuses if zero/several, minimized, or not foreground after SetForegroundWindow;
#  - input via SendInput, capture via PrintWindow(PW_RENDERFULLCONTENT) cropped to the client area.
# Usage: pos.ps1 <info|shot FILE|click X Y|key VK...|type TEXT|scan DIGITS|size W H> [-Profile D:\rtb-userdata]
param([Parameter(Position=0)][string]$Cmd, [Parameter(Position=1, ValueFromRemainingArguments=$true)][string[]]$Rest, [string]$Profile = 'D:\rtb-userdata')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  public static IntPtr Find(uint pid) { IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; } return true; }, IntPtr.Zero);
    return found; }
  public static void Key(ushort vk, bool up) { var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.vk = vk; i[0].u.ki.flags = up ? 2u : 0u; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void Uni(char c) { var i = new INPUT[2]; for (int k = 0; k < 2; k++) { i[k].type = 1; i[k].u.ki.scan = c; i[k].u.ki.flags = 4u | (k == 1 ? 2u : 0u); } SendInput(2, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void Click() { var i = new INPUT[2]; i[0].type = 0; i[0].u.mi.flags = 2; i[1].type = 0; i[1].u.mi.flags = 4; SendInput(2, i, Marshal.SizeOf(typeof(INPUT))); }
}
'@
[void][W]::SetProcessDpiAwarenessContext([IntPtr]-4)  # per-monitor v2: physical pixels

$procs = @(Get-CimInstance Win32_Process -Filter "Name='POS Pulse.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match [regex]::Escape("--user-data-dir=$Profile") })
if ($procs.Count -ne 1) { throw "REFUSE: expected exactly 1 POS main process for profile $Profile, found $($procs.Count)" }
$procId = [uint32]$procs[0].ProcessId
$h = [W]::Find($procId)
if ($h -eq [IntPtr]::Zero) { throw "REFUSE: no visible window for pid $procId" }
if ([W]::IsIconic($h)) { throw "REFUSE: POS window is minimized" }

function Front { if ([W]::GetForegroundWindow() -ne $h) { [W]::Key(0x12, $false); [W]::Key(0x12, $true); [void][W]::SetForegroundWindow($h); Start-Sleep -Milliseconds 250 }
  if ([W]::GetForegroundWindow() -ne $h) { throw "REFUSE: POS window is not foreground (owner using the PC?)" } }
function ClientOrigin { $p = New-Object W+POINT; [void][W]::ClientToScreen($h, [ref]$p); $p }
$cr = New-Object W+RECT; [void][W]::GetClientRect($h, [ref]$cr)

switch ($Cmd) {
  'front' { Front; "foreground ok" }
  'info' { $o = ClientOrigin; "pid=$procId profile=$Profile hwnd=$h client=$($cr.R)x$($cr.B) origin=$($o.X),$($o.Y) dpi=$([W]::GetDpiForWindow($h)) fg=$([W]::GetForegroundWindow() -eq $h)" }
  'shot' { $wr = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$wr); $o = ClientOrigin
    $bmp = New-Object System.Drawing.Bitmap ($wr.R - $wr.L), ($wr.B - $wr.T); $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc(); [void][W]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
    $crop = New-Object System.Drawing.Rectangle ($o.X - $wr.L), ($o.Y - $wr.T), $cr.R, $cr.B
    $c = $bmp.Clone($crop, $bmp.PixelFormat); $c.Save($Rest[0], [System.Drawing.Imaging.ImageFormat]::Png); $c.Dispose(); $bmp.Dispose()
    "saved $($Rest[0]) $($cr.R)x$($cr.B)" }
  'click' { Front; $o = ClientOrigin; [void][W]::SetCursorPos($o.X + [int]$Rest[0], $o.Y + [int]$Rest[1]); Start-Sleep -Milliseconds 60; [W]::Click(); "clicked $($Rest[0]),$($Rest[1])" }
  'key' { Front; foreach ($k in $Rest) { $mods = @(); $parts = $k -split '\+'
      foreach ($m in $parts[0..($parts.Count-2)]) { if ($parts.Count -gt 1) { $mods += @{ctrl=0x11;shift=0x10;alt=0x12}[$m] } }
      $vk = [uint16]([int]("0x" + $parts[-1]))
      foreach ($m in $mods) { [W]::Key($m, $false) }; [W]::Key($vk, $false); [W]::Key($vk, $true); foreach ($m in $mods) { [W]::Key($m, $true) }
      Start-Sleep -Milliseconds 80 }; "keys $($Rest -join ' ')" }
  'type' { Front; foreach ($ch in ($Rest -join ' ').ToCharArray()) { [W]::Uni($ch); Start-Sleep -Milliseconds 25 }; "typed $(($Rest -join ' ').Length) chars" }
  'scan' { Front; foreach ($ch in $Rest[0].ToCharArray()) { $vk = [uint16]([int][char]$ch); [W]::Key($vk, $false); [W]::Key($vk, $true); Start-Sleep -Milliseconds 5 }
    [W]::Key(0x0D, $false); [W]::Key(0x0D, $true); "scan burst $($Rest[0]) + Enter" }
  'max' { [void][W]::ShowWindow($h, 3); Start-Sleep -Milliseconds 300; [void][W]::GetClientRect($h, [ref]$cr); "client now $($cr.R)x$($cr.B)" }
  'size' { [void][W]::ShowWindow($h, 9); Start-Sleep -Milliseconds 300; $wr = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$wr)
    [void][W]::GetClientRect($h, [ref]$cr); $dw = ($wr.R - $wr.L) - $cr.R; $dh = ($wr.B - $wr.T) - $cr.B
    [void][W]::SetWindowPos($h, [IntPtr]::Zero, $wr.L, $wr.T, [int]$Rest[0] + $dw, [int]$Rest[1] + $dh, 0x14)
    Start-Sleep -Milliseconds 300; [void][W]::GetClientRect($h, [ref]$cr); "client now $($cr.R)x$($cr.B)" }
  default { throw "unknown command $Cmd" }
}
