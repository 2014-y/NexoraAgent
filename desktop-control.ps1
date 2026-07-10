param()

# === WIN32 API IMPORTS ===
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@

# === APPLICATION MAP ===
$APP_MAP = @{
    "NeteaseMusic" = "C:\Program Files\Netease\CloudMusic\cloudmusic.exe"
    "cloudmusic" = "C:\Program Files\Netease\CloudMusic\cloudmusic.exe"
    "NeteaseCloudMusic" = "C:\Program Files\Netease\CloudMusic\cloudmusic.exe"
    "QQMusic" = "C:\Program Files (x86)\Tencent\QQMusic\QQMusic.exe"
    "Spotify" = "spotify"
    "Chrome" = "chrome"
    "Edge" = "msedge"
    "Notepad" = "notepad"
    "Calculator" = "calc"
}

function Resolve-AppName {
    param([string]$name)
    if ($APP_MAP.ContainsKey($name)) { return $APP_MAP[$name] }
    return $name
}

function Find-ProcessByName {
    param([string]$name)
    $resolved = Resolve-AppName $name
    $procName = Split-Path $resolved -Leaf -ErrorAction SilentlyContinue
    if (-not $procName) { $procName = $resolved }
    $procName = $procName -replace '\.exe$', ''
    Get-Process | Where-Object {
        ($_.ProcessName -eq $procName -or $_.ProcessName -eq $resolved -or $_.MainWindowTitle -like "*" + $name + "*")
    }
}

function Get-MainWindowProcess {
    param([string]$name)
    $procs = Find-ProcessByName -name $name
    if (-not $procs -or $procs.Count -eq 0) { return $null }
    $main = $procs | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero -and $_.MainWindowTitle -ne "" } | Select-Object -First 1
    if ($main) { return $main }
    $main = $procs | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } | Select-Object -First 1
    if ($main) { return $main }
    return $procs[0]
}

function Activate-WindowByHandle {
    param([System.IntPtr]$hWnd)
    if ($hWnd -eq [System.IntPtr]::Zero) { return $false }
    try {
        # Method 1: AttachThreadInput (most reliable for Electron apps)
        $fgHwnd = [WinApi]::GetForegroundWindow()
        $fgPid = 0
        [WinApi]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid) | Out-Null
        $targetPid = 0
        [WinApi]::GetWindowThreadProcessId($hWnd, [ref]$targetPid) | Out-Null
        
        if ($fgPid -ne 0 -and $targetPid -ne 0) {
            [WinApi]::AttachThreadInput($fgPid, $targetPid, $true) | Out-Null
            $result = [WinApi]::SetForegroundWindow($hWnd)
            [WinApi]::AttachThreadInput($fgPid, $targetPid, $false) | Out-Null
            if ($result) { return $true }
        }
        
        # Method 2: BringWindowToTop
        if ([WinApi]::BringWindowToTop($hWnd)) { return $true }
        
        # Method 3: Restore if minimized, then SetForegroundWindow
        if ([WinApi]::IsIconic($hWnd)) {
            [WinApi]::ShowWindow($hWnd, 9) | Out-Null
        }
        if ([WinApi]::SetForegroundWindow($hWnd)) { return $true }
        
        return $false
    } catch {
        return $false
    }
}

function Cmd-AppStart {
    param([string]$target)
    try {
        $resolved = Resolve-AppName $target
        Start-Process $resolved -ErrorAction Stop
        Write-Output "Started: $target"
    } catch {
        Write-Error ("Failed to start " + $target + " : " + $_.Exception.Message)
        exit 1
    }
}

function Cmd-AppClose {
    param([string]$name)
    $proc = Get-MainWindowProcess -name $name
    if (-not $proc) { Write-Output "NOT_FOUND"; exit 1 }
    try {
        $proc.CloseMainWindow() | Out-Null
        Start-Sleep -Milliseconds 500
        if (-not $proc.HasExited) { $proc.Kill() }
        Write-Output "Closed: $($proc.ProcessName) (PID $($proc.Id))"
    } catch {
        $proc.Kill()
        Write-Output "Killed: $($proc.ProcessName) (PID $($proc.Id))"
    }
}

function Cmd-AppFocus {
    param([string]$name)
    $proc = Get-MainWindowProcess -name $name
    if (-not $proc) { Write-Output "NOT_FOUND"; exit 1 }
    $activated = Activate-WindowByHandle -hWnd $proc.MainWindowHandle
    if ($activated) {
        Write-Output "Activated: $($proc.ProcessName) (PID $($proc.Id), HWND $($proc.MainWindowHandle))"
    } else {
        Write-Output "Found but could not activate: $($proc.ProcessName) (PID $($proc.Id))"
    }
}

function Cmd-AppList {
    param([bool]$running = $false)
    if ($running) {
        $procs = Get-Process | Where-Object {
            $_.MainWindowHandle -ne [System.IntPtr]::Zero -and $_.MainWindowTitle -ne ""
        } | Sort-Object MainWindowTitle
    } else {
        $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } | Sort-Object ProcessName
    }
    foreach ($p in $procs) {
        $title = $p.MainWindowTitle.Substring(0, [Math]::Min(50, $p.MainWindowTitle.Length))
        Write-Output "$($p.ProcessName) | PID=$($p.Id) | HWND=$($p.MainWindowHandle) | Title=`"$title`""
    }
}

function Cmd-KeyboardShortcut {
    param([string]$name, [string]$shortcut)
    $proc = Get-MainWindowProcess -name $name
    if (-not $proc) { Write-Output "NOT_FOUND"; exit 1 }
    
    # CRITICAL: Activate the window FIRST before sending keys
    $activated = Activate-WindowByHandle -hWnd $proc.MainWindowHandle
    if (-not $activated) {
        Write-Output "WARNING: Could not activate window, keys may go to wrong app"
    }
    
    # Give the OS time to switch focus
    Start-Sleep -Milliseconds 500
    
    try {
        $normalized = $shortcut
        if ($normalized -eq "{SPACE}") { $normalized = " " }
        [System.Windows.Forms.SendKeys]::SendWait($normalized)
        Write-Output "Sent '$shortcut' to $($proc.ProcessName) (HWND $($proc.MainWindowHandle))"
    } catch {
        Write-Error ("Failed to send shortcut " + $shortcut + " : " + $_.Exception.Message)
        exit 1
    }
}

# === MAIN DISPATCHER ===
if ($args.Count -eq 0) {
    Write-Output "Usage: desktop-control.ps1 <command> [args]"
    Write-Output "  app-start <name>              Start an application"
    Write-Output "  app-close <name>              Close an application"
    Write-Output "  app-focus <name>              Bring to foreground"
    Write-Output "  app-list [--running]          List all/running windows"
    Write-Output "  keyboard-shortcut <name> <key>  Send keyboard shortcut"
    exit 0
}

$command = $args[0]
$rest = $args | Select-Object -Skip 1

switch ($command) {
    "app-start"         { Cmd-AppStart -target ($rest -join " ") }
    "app-close"         { Cmd-AppClose -name ($rest -join " ") }
    "app-focus"         { Cmd-AppFocus -name ($rest -join " ") }
    "app-list"          {
        $running = $rest -contains "--running"
        Cmd-AppList -running:$running
    }
    "keyboard-shortcut" { Cmd-KeyboardShortcut -name ($rest[0]) -shortcut ($rest[1]) }
    default             { Write-Error ("Unknown command: " + $command); exit 1 }
}
