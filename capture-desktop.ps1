# Full-desktop / active-monitor screenshot with DPI-safe metrics.
# Compatible with home PCs, Wuying/cloud desktops, multi-monitor, 125%/150%/200% scaling.
#
# Default Scope=Active: capture the monitor with the focused window (sharpest for chat preview).
# Scope=Primary: primary monitor only.
# Scope=All: entire virtual desktop (all monitors) — often looks soft when shown small in chat.
param(
    [string]$OutPath = "",
    [ValidateSet('Active', 'Primary', 'All')]
    [string]$Scope = 'Active'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScreenCapNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDC(string lpszDriver, string lpszDevice, string lpszOutput, IntPtr lpInitData);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern int BitBlt(IntPtr hDestDC, int x, int y, int nWidth, int nHeight, IntPtr hSrcDC, int xSrc, int ySrc, int dwRop);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);

    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const int SRCCOPY = 0x00CC0020;
    public const int CAPTUREBLT = 0x40000000;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
}
"@

# DPI awareness: Prefer PerMonitorV2 so Bounds/GetSystemMetrics are physical pixels.
$dpiOk = $false
try {
    if ([ScreenCapNative]::SetProcessDpiAwarenessContext([IntPtr]-4)) { $dpiOk = $true }
} catch {}
if (-not $dpiOk) {
    try { if ([ScreenCapNative]::SetProcessDpiAwareness(2) -eq 0) { $dpiOk = $true } } catch {}
}
if (-not $dpiOk) {
    try { if ([ScreenCapNative]::SetProcessDPIAware()) { $dpiOk = $true } } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-VirtualDesktopRect {
    $x = [ScreenCapNative]::GetSystemMetrics(76)
    $y = [ScreenCapNative]::GetSystemMetrics(77)
    $w = [ScreenCapNative]::GetSystemMetrics(78)
    $h = [ScreenCapNative]::GetSystemMetrics(79)
    if ($w -gt 0 -and $h -gt 0) {
        return @{ X = $x; Y = $y; Width = $w; Height = $h; Source = 'GetSystemMetrics-Virtual' }
    }

    try {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        if ($vs.Width -gt 0 -and $vs.Height -gt 0) {
            return @{ X = $vs.X; Y = $vs.Y; Width = $vs.Width; Height = $vs.Height; Source = 'SystemInformation.VirtualScreen' }
        }
    } catch {}

    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return @{ X = $b.X; Y = $b.Y; Width = $b.Width; Height = $b.Height; Source = 'PrimaryScreen.Bounds' }
}

function Get-PrimaryMonitorRect {
    $cx = [ScreenCapNative]::GetSystemMetrics(0)
    $cy = [ScreenCapNative]::GetSystemMetrics(1)
    if ($cx -gt 0 -and $cy -gt 0) {
        return @{ X = 0; Y = 0; Width = $cx; Height = $cy; Source = 'SM_CXSCREEN' }
    }
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return @{ X = $b.X; Y = $b.Y; Width = $b.Width; Height = $b.Height; Source = 'PrimaryScreen.Bounds' }
}

function Get-ActiveMonitorRect {
    $hwnd = [ScreenCapNative]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return $null }
    $mon = [ScreenCapNative]::MonitorFromWindow($hwnd, 2)
    if ($mon -eq [IntPtr]::Zero) { return $null }
    $mi = New-Object ScreenCapNative+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    if (-not [ScreenCapNative]::GetMonitorInfo($mon, [ref]$mi)) { return $null }
    $r = $mi.rcMonitor
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $null }
    return @{ X = $r.Left; Y = $r.Top; Width = $w; Height = $h; Source = 'MonitorFromWindow' }
}

# Resolve capture rect by scope. Prefer single-monitor for sharpness in chat/WeChat.
$rect = $null
if ($Scope -eq 'All') {
    $rect = Get-VirtualDesktopRect
} elseif ($Scope -eq 'Primary') {
    $rect = Get-PrimaryMonitorRect
} else {
    $rect = Get-ActiveMonitorRect
    if (-not $rect) { $rect = Get-PrimaryMonitorRect }
}

# Sanity: if chosen rect is absurdly small vs primary physical screen, rebuild.
$cx = [ScreenCapNative]::GetSystemMetrics(0)
$cy = [ScreenCapNative]::GetSystemMetrics(1)
if ($cx -gt 0 -and $cy -gt 0 -and $rect) {
    if ($rect.Width -lt [Math]::Floor($cx * 0.5) -or $rect.Height -lt [Math]::Floor($cy * 0.5)) {
        $active = Get-ActiveMonitorRect
        $candidates = @(
            (Get-PrimaryMonitorRect),
            $rect
        )
        if ($active) { $candidates += $active }
        if ($Scope -eq 'All') {
            try {
                $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
                $candidates += @{ X = $vs.X; Y = $vs.Y; Width = $vs.Width; Height = $vs.Height; Source = 'VirtualScreen-retry' }
            } catch {}
        }
        $rect = $candidates | Sort-Object { $_.Width * $_.Height } -Descending | Select-Object -First 1
    }
}

if (-not $rect -or $rect.Width -lt 64 -or $rect.Height -lt 64) {
    throw "Invalid capture rect: $($rect.Width)x$($rect.Height) via $($rect.Source)"
}

# Use 32bpp ARGB + BitBlt(CAPTUREBLT) for sharper layered-window capture on some desktops.
$bitmap = New-Object System.Drawing.Bitmap([int]$rect.Width, [int]$rect.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.Clear([System.Drawing.Color]::Black)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::None

    $copied = $false
    try {
        $hdcDest = $graphics.GetHdc()
        $hdcSrc = [ScreenCapNative]::CreateDC('DISPLAY', $null, $null, [IntPtr]::Zero)
        if ($hdcSrc -ne [IntPtr]::Zero) {
            $rop = [ScreenCapNative]::SRCCOPY -bor [ScreenCapNative]::CAPTUREBLT
            $ok = [ScreenCapNative]::BitBlt(
                $hdcDest, 0, 0, [int]$rect.Width, [int]$rect.Height,
                $hdcSrc, [int]$rect.X, [int]$rect.Y, $rop
            )
            [ScreenCapNative]::DeleteDC($hdcSrc) | Out-Null
            if ($ok) { $copied = $true }
        }
        $graphics.ReleaseHdc($hdcDest)
    } catch {
        try { $graphics.ReleaseHdc($hdcDest) } catch {}
    }

    if (-not $copied) {
        $size = New-Object System.Drawing.Size([int]$rect.Width, [int]$rect.Height)
        $graphics.CopyFromScreen(
            [int]$rect.X, [int]$rect.Y, 0, 0, $size,
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )
    }

    if ([string]::IsNullOrWhiteSpace($OutPath)) {
        $OutPath = Join-Path $env:TEMP 'openclaw-screenshot.png'
    }
    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # PNG is lossless — keep full physical resolution
    $bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $OutPath
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
