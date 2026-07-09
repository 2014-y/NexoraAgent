Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Force DPI awareness at the START of this script.
# Screen.Bounds with PER_MONITOR_AWARE_V2 returns true physical pixels
# for each monitor, regardless of its individual scaling factor.
Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class DPI {
        [DllImport("user32.dll")]
        public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
        static DPI() {
            _PerMonitorV2 = new IntPtr(-4);
        }
        public static IntPtr _PerMonitorV2;
        public static void Enable() {
            SetProcessDpiAwarenessContext(_PerMonitorV2);
        }
    }
"@
# Suppress errors if DPI awareness was already set by a previous call
[DPI]::Enable() 2>$null | Out-Null

# Default: capture primary monitor only.
# To capture all monitors, set $env:OPENCLAW_SCREENSHOT_ALL to 1 before running.
$captureAll = [Environment]::GetEnvironmentVariable("OPENCLAW_SCREENSHOT_ALL") -eq "1"
$screens = if ($captureAll) {
    [System.Windows.Forms.Screen]::AllScreens
} else {
    [System.Windows.Forms.Screen]::PrimaryScreen
}

# Calculate bounds using Screen.Bounds (physical pixels with DPI V2)
$left = 999999
$right = -999999
$top = 999999
$bottom = -999999

foreach ($scr in $screens) {
    if ($scr.Bounds.X -lt $left) { $left = $scr.Bounds.X }
    if ($scr.Bounds.Right -gt $right) { $right = $scr.Bounds.Right }
    if ($scr.Bounds.Y -lt $top) { $top = $scr.Bounds.Y }
    if ($scr.Bounds.Bottom -gt $bottom) { $bottom = $scr.Bounds.Bottom }
}

$width = $right - $left
$height = $bottom - $top

$b = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::Black)

foreach ($scr in $screens) {
    $sx = $scr.Bounds.X - $left
    $sy = $scr.Bounds.Y - $top
    $sz = New-Object System.Drawing.Size($scr.Bounds.Width, $scr.Bounds.Height)
    $g.CopyFromScreen($scr.Bounds.X, $scr.Bounds.Y, $sx, $sy, $sz)
}

$outPath = "$env:TEMP/openclaw-screenshot.png"
$b.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$b.Dispose()

Write-Output $outPath

