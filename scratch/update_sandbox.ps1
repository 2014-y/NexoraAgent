$scriptDir = Split-Path -Parent $PSScriptRoot
$sandboxDir = Join-Path $scriptDir ".node-sandbox"
$tempZip = Join-Path $scriptDir "node-v24.15.0.zip"
$tempExtract = Join-Path $scriptDir "node-v24.15.0-temp"

Write-Host "正在停止所有沙箱 Node 进程..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\.node-sandbox\node.exe" } | Stop-Process -Force

Write-Host "正在下载真正的 Node.js v24.15.0 绿色版 (从国内镜像)..." -ForegroundColor Cyan
$downloadUrl = "https://npmmirror.com/mirrors/node/v24.15.0/node-v24.15.0-win-x64.zip"
$success = $false
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -TimeoutSec 120
    $success = $true
} catch {
    Write-Host "从国内镜像下载失败，正在尝试官方镜像..." -ForegroundColor Yellow
}

if (-not $success) {
    try {
        $downloadUrl = "https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip"
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -TimeoutSec 120
        $success = $true
    } catch {
        Write-Host "下载失败！请检查您的网络连接。" -ForegroundColor Red
        exit 1
    }
}

Write-Host "正在解压文件..." -ForegroundColor Cyan
if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

$extractedDir = Join-Path $tempExtract "node-v24.15.0-win-x64"

Write-Host "正在替换沙箱中的文件..." -ForegroundColor Cyan
if (-not (Test-Path $sandboxDir)) { mkdir $sandboxDir | Out-Null }

# 替换核心的 node.exe 和 npm 脚本
Copy-Item "$extractedDir\node.exe" "$sandboxDir\node.exe" -Force
Copy-Item "$extractedDir\npm" "$sandboxDir\npm" -Force -ErrorAction SilentlyContinue
Copy-Item "$extractedDir\npm.cmd" "$sandboxDir\npm.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$extractedDir\npx" "$sandboxDir\npx" -Force -ErrorAction SilentlyContinue
Copy-Item "$extractedDir\npx.cmd" "$sandboxDir\npx.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$extractedDir\corepack" "$sandboxDir\corepack" -Force -ErrorAction SilentlyContinue
Copy-Item "$extractedDir\corepack.cmd" "$sandboxDir\corepack.cmd" -Force -ErrorAction SilentlyContinue

# 替换 npm 自带 of node_modules
if (Test-Path "$sandboxDir\node_modules") { Remove-Item "$sandboxDir\node_modules" -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item "$extractedDir\node_modules" "$sandboxDir\node_modules" -Recurse -Force

Write-Host "正在清理临时下载文件..." -ForegroundColor Yellow
Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "========================================" -ForegroundColor Green
Write-Host "沙箱 Node.js 成功联动升级至真正的 v24.15.0！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
exit 0
