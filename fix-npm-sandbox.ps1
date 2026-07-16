# Nexora Agent npm sandbox repair script
# Right-click this file -> "Run with PowerShell" (as Administrator if needed)

$src = Join-Path $PSScriptRoot ".node-sandbox\node_modules"
$dst = "C:\Program Files\Nexora Agent\resources\app\.node-sandbox\node_modules"

Write-Host "=== Nexora Agent npm Sandbox Repair ===" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $src)) {
    Write-Host "ERROR: Source not found: $src" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

if (Test-Path $dst) {
    Write-Host "Target node_modules already exists, removing old copy..." -ForegroundColor Yellow
    Remove-Item -Path $dst -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Copying node_modules from project to Program Files..." -ForegroundColor Green
Write-Host "  From: $src" 
Write-Host "  To:   $dst"
Write-Host ""

try {
    Copy-Item -Path $src -Destination $dst -Recurse -Force -ErrorAction Stop
    Write-Host ""
    Write-Host "SUCCESS! npm node_modules has been restored." -ForegroundColor Green
    Write-Host "Please restart Nexora Agent now." -ForegroundColor Cyan
} catch {
    Write-Host ""
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "You need to run this script as Administrator." -ForegroundColor Yellow
    Write-Host "Right-click this file -> 'Run with PowerShell' from an admin account," -ForegroundColor Yellow
    Write-Host "or open PowerShell as Administrator and run:" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -ForegroundColor White
}

Write-Host ""
Read-Host "Press Enter to exit"
