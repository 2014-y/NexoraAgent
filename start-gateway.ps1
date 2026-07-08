# OpenClaw Gateway Launcher
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeHome = Join-Path $scriptDir ".node-sandbox"
$node = Join-Path $nodeHome "node.exe"

# Check node exists
if (-not (Test-Path $node)) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Red
    Write-Host '  ERROR: Node not found!' -ForegroundColor Red
    Write-Host '========================================' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Please run init.bat first.' -ForegroundColor Yellow
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

# Use nvm's node_modules
$nvmModules = "$env:USERPROFILE\AppData\Roaming\nvm\v24.13.0\node_modules"
if (-not (Test-Path $nvmModules)) {
    $nvmModules = "$env:APPDATA\nvm\v24.13.0\node_modules"
}

$indexJs = Join-Path $nvmModules "openclaw\dist\index.js"
if (-not (Test-Path $indexJs)) {
    Write-Host "ERROR: openclaw not found at $indexJs" -ForegroundColor Red
    Write-Host "Please install openclaw: npm install -g openclaw" -ForegroundColor Yellow
    pause
    exit 1
}

# Direct execution
& $node --preserve-symlinks-main $indexJs gateway run --allow-unconfigured --force
