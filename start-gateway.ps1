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

$indexJs = Join-Path $scriptDir "node_modules\openclaw\dist\index.js"
if (-not (Test-Path $indexJs)) {
    # 动态查找 NVM 目录
    $nvmRoot = "$env:USERPROFILE\AppData\Roaming\nvm"
    if (-not (Test-Path $nvmRoot)) { $nvmRoot = "$env:APPDATA\nvm" }
    # 数值排序: 将 major.minor.patch 解析为整数再排, 避免 v9 字典序高于 v24
    $nvmDir = (Get-ChildItem $nvmRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path "$($_.FullName)\node.exe" } |
        Sort-Object {
            $p = ($_.Name.TrimStart('v') -split '\.')
            [int]$p[0] * 1000000 + [int]$p[1] * 1000 + [int]$p[2]
        } -Descending | Select-Object -First 1).FullName
    if (-not $nvmDir) { $nvmDir = $nvmRoot }

    # Use nvm's node_modules
    $nvmModules = "$nvmDir\node_modules"

    $indexJs = Join-Path $nvmModules "openclaw\dist\index.js"
}

if (-not (Test-Path $indexJs)) {
    Write-Host "ERROR: openclaw not found at $indexJs" -ForegroundColor Red
    Write-Host "Please install openclaw: npm install -g openclaw" -ForegroundColor Yellow
    pause
    exit 1
}

# 释放端口 18789 (与 start-gateway.bat 一致: 启动前杀掉占用监听的进程及其子树)
Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        Write-Host "Freeing port 18789 (PID $_)..." -ForegroundColor DarkGray
        Start-Process -FilePath "taskkill" -ArgumentList "/F","/T","/PID","$_" -NoNewWindow -Wait -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 2

# 注入 patch_gateway.js / NODE_OPTIONS (与 start-gateway.bat ~72-73 保持一致)
# NODE_OPTIONS 需正斜杠路径, 否则解析器会把反斜杠当转义符
$patchJs = Join-Path $scriptDir "patch_gateway.js"
$patchFwd = ($scriptDir -replace '\\', '/') + '/patch_gateway.js'
$env:NODE_OPTIONS = "--require `"$patchFwd`" --dns-result-order=ipv4first --no-warnings"

# Direct execution
& $node --require "$patchJs" --preserve-symlinks-main $indexJs gateway run --allow-unconfigured --force

