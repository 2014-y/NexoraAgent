# Hard sandbox - completely isolate node
$env:PATH = "C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\"

$node = 'C:\Users\Yuan\AppData\Roaming\nvm\v24.13.0\node.exe'
$modDir = 'C:\Users\Yuan\AppData\Roaming\nvm\v24.13.0\node_modules'
$indexJs = Join-Path $modDir 'openclaw\dist\index.js'

Write-Host '========================================' -ForegroundColor DarkGray
Write-Host ' OpenClaw Gateway (Hard Sandbox)' -ForegroundColor DarkGray
Write-Host ' Node: v24.13.0 (absolute path only)' -ForegroundColor DarkGray
Write-Host ' PATH: cleared (no global node)' -ForegroundColor DarkGray
Write-Host '========================================' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $node)) {
    Write-Host 'ERROR: Node.js v24.13.0 not found!' -ForegroundColor Red
    pause
    exit 1
}

Write-Host 'Node version: ' -NoNewline -ForegroundColor Gray
& $node --version
Write-Host ''
Write-Host 'Starting Gateway...' -ForegroundColor Gray
Write-Host ''

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$indexJs`" gateway run"
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$proc = [System.Diagnostics.Process]::Start($psi)

while (-not $proc.StandardOutput.EndOfStream) {
    $line = $proc.StandardOutput.ReadLine()
    if ($line) { Write-Host $line }
}
while (-not $proc.StandardError.EndOfStream) {
    $line = $proc.StandardError.ReadLine()
    if ($line) { Write-Host $line }
}

$proc.WaitForExit()
