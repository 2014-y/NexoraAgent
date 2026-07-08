# OpenClaw Gateway Launcher
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeHome = Join-Path $scriptDir ".node-sandbox"
$node = Join-Path $nodeHome "node.exe"
$modDir = Join-Path $nodeHome "node_modules"
$indexJs = Join-Path $modDir "openclaw\dist\index.js"

# Check node-sandbox exists
if (-not (Test-Path $node)) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Red
    Write-Host '  ERROR: Node sandbox not found!' -ForegroundColor Red
    Write-Host '========================================' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Please run init.bat first to set up the project.' -ForegroundColor Yellow
    Write-Host ''
    pause
    exit 1
}

# Check openclaw module
if (-not (Test-Path $indexJs)) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Red
    Write-Host '  ERROR: openclaw module not found!' -ForegroundColor Red
    Write-Host '========================================' -ForegroundColor Red
    Write-Host ''
    Write-Host 'The .node-sandbox is incomplete.' -ForegroundColor Yellow
    Write-Host 'Please run init.bat again.' -ForegroundColor Yellow
    Write-Host ''
    pause
    exit 1
}

# Ensure .openclaw dir exists
if (-not (Test-Path "$env:USERPROFILE\.openclaw")) {
    New-Item -ItemType Directory -Path "$env:USERPROFILE\.openclaw" -Force | Out-Null
}

Write-Host '========================================' -ForegroundColor DarkGray
Write-Host ' OpenClaw Gateway Launcher' -ForegroundColor DarkGray
Write-Host " Node: $nodeHome\node.exe" -ForegroundColor DarkGray
Write-Host '========================================' -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Node version: ' -NoNewline -ForegroundColor Gray
& $node --version
Write-Host ''
Write-Host 'Starting...' -ForegroundColor Gray
Write-Host ''

# Direct execution with --allow-unconfigured
& $node $indexJs gateway run --allow-unconfigured --force
