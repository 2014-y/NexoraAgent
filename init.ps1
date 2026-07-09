# AI-v24.13.0 Setup Script
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host "  AI-v24.13.0 Setup" -ForegroundColor DarkGray
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sandboxDir = Join-Path $scriptDir ".node-sandbox"

# Clean up old sandbox
if (Test-Path $sandboxDir) {
    Write-Host "Cleaning up old node-sandbox..." -ForegroundColor Yellow
    Remove-Item $sandboxDir -Recurse -Force
}

# Find Node.js
Write-Host "[1/3] Looking for Node.js..." -ForegroundColor Cyan
$src = $null

$nvmPath = "$env:USERPROFILE\AppData\Roaming\nvm\v24.13.0"
if (Test-Path "$nvmPath\node.exe") { $src = $nvmPath }

if (-not $src) {
    $nvmRoot = "$env:USERPROFILE\AppData\Roaming\nvm"
    if (Test-Path $nvmRoot) {
        $latest = Get-ChildItem $nvmRoot -Directory | Where-Object { $_.Name -match '^v\d' } | Sort-Object Name -Descending | Select-Object -First 1
        if ($latest -and (Test-Path "$($latest.FullName)\node.exe")) {
            $src = $latest.FullName
        }
    }
}

if (-not $src) {
    if (Test-Path "C:\Program Files\nodejs\node.exe") { $src = "C:\Program Files\nodejs" }
}
if (-not $src) {
    if (Test-Path "C:\Program Files (x86)\nodejs\node.exe") { $src = "C:\Program Files (x86)\nodejs" }
}

if (-not $src) {
    Write-Host ""
    Write-Host "[ERROR] No Node.js found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js v24.x first:" -ForegroundColor Yellow
    Write-Host "  Option 1: nvm-windows (recommended)" -ForegroundColor White
    Write-Host "    https://github.com/coreybutler/nvm-windows" -ForegroundColor White
    Write-Host "    Then run: nvm install 24 (or latest v24.x)" -ForegroundColor White
    Write-Host ""
    Write-Host "  Option 2: Official installer" -ForegroundColor White
    Write-Host "    https://nodejs.org" -ForegroundColor White
    Write-Host ""
    pause
    exit 1
}

Write-Host "  Found: $src" -ForegroundColor Green

# Copy node
Write-Host "[2/3] Setting up .node-sandbox..." -ForegroundColor Cyan
mkdir $sandboxDir | Out-Null
Copy-Item "$src\node.exe" "$sandboxDir\node.exe" -Force
Copy-Item "$src\npm" "$sandboxDir\npm" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\npm.cmd" "$sandboxDir\npm.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\npx" "$sandboxDir\npx" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\npx.cmd" "$sandboxDir\npx.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\corepack" "$sandboxDir\corepack" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\corepack.cmd" "$sandboxDir\corepack.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\nodevars.bat" "$sandboxDir\nodevars.bat" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\README.md" "$sandboxDir\README.md" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\LICENSE" "$sandboxDir\LICENSE" -Force -ErrorAction SilentlyContinue

if (-not (Test-Path "$sandboxDir\node.exe")) {
    Write-Host "  [ERROR] Failed to create .node-sandbox!" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "  Created .node-sandbox with node.exe" -ForegroundColor Green

# Setup config - ALWAYS regenerate from template
Write-Host "[3/3] Setting up configuration..." -ForegroundColor Cyan
$configDir = Join-Path $env:USERPROFILE ".openclaw"
$configFile = Join-Path $configDir "openclaw.json"
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$examplePath = Join-Path $scriptDir "config\openclaw.json.example"
if (Test-Path $examplePath) {
    Copy-Item $examplePath $configFile -Force
    Write-Host "  Created openclaw.json from template." -ForegroundColor Green
    Write-Host ""
    Write-Host "  IMPORTANT: Edit $configFile" -ForegroundColor Yellow
    Write-Host "  Replace YOUR_*_API_KEY_HERE with your actual API Keys." -ForegroundColor Yellow
    Write-Host "  Get Agnes key from: https://agnes-ai.com/zh-Hans/docs/agnes-video-v20" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "  [ERROR] Template not found at $examplePath" -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Next: Edit openclaw.json, then double-click start-gateway.bat" -ForegroundColor Cyan
Write-Host ""
pause

