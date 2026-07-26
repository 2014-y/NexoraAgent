# AI-v24.13.0 Setup Script
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host "  AI-v24.13.0 Setup" -ForegroundColor DarkGray
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sandboxDir = Join-Path $scriptDir ".node-sandbox"

# Clean up old sandbox (killing active sandbox node processes to prevent file lock errors)
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\.node-sandbox\node.exe" } | Stop-Process -Force
if (Test-Path $sandboxDir) {
    Write-Host "Cleaning up old node-sandbox..." -ForegroundColor Yellow
    Remove-Item $sandboxDir -Recurse -Force
}

# Find Node.js
Write-Host "[1/3] Looking for Node.js..." -ForegroundColor Cyan
$src = $null

$nvmPath = "$env:USERPROFILE\AppData\Roaming\nvm"
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

# Ensure npm node_modules is also copied for full sandbox functionality (fixes empty command or missing npm-cli.js issue)
if (Test-Path "$src\node_modules") {
    Copy-Item "$src\node_modules" "$sandboxDir\node_modules" -Recurse -Force -ErrorAction SilentlyContinue
}

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

    # Clean any unrecognized keys that may have been injected by openclaw doctor/wizard
    Write-Host "  Cleaning unrecognized config keys..." -ForegroundColor Gray
    $cleanFile = Join-Path $sandboxDir "_clean_config.js"
    $cleanJs = @"
const fs = require('fs');
const cfgPath = process.argv[2];
const originalBytes = fs.statSync(cfgPath).size;
let fileContent = fs.readFileSync(cfgPath, 'utf8');
fileContent = fileContent.replace(/^\uFEFF/, '');
const cfg = JSON.parse(fileContent);

// 1. 清理 defaults 废键
const knownKeys = new Set(["model","models","contextPruning","compaction","maxConcurrent","systemPrompt","tools","permissions","skills"]);
if (cfg.agents && cfg.agents.defaults) {
    for (const key of Object.keys(cfg.agents.defaults)) {
        if (!knownKeys.has(key)) {
            console.log('  Removing unrecognized key: agents.defaults.' + key);
            delete cfg.agents.defaults[key];
        }
    }
}

// 2. 禁用/移除未安装插件以防 warnings
const uninstalledPlugins = ['signal', 'mattermost', 'tavily', 'clickclack', 'searxng', 'sms', 'irc', 'weixin-reconnect', 'auto-summary', 'tlon'];
if (cfg.plugins && cfg.plugins.entries) {
    for (const p of uninstalledPlugins) {
        delete cfg.plugins.entries[p];
    }
}

// 3. 配置 plugins.allow 信任白名单以防 empty 警告
if (cfg.plugins) {
    cfg.plugins.allow = [
        "slack", "googlechat", "line", "lobster", "matrix", 
        "msteams", "nextcloud-talk", "openclaw-weixin", "telegram", 
        "whatsapp", "zalo", "zalouser", "imessage", "feishu", "discord",
        "dual-model-trainer"
    ];
}

// 4. 配置默认 gateway 认证以防 auth missing 警告
if (cfg.gateway) {
    cfg.gateway.auth = {
        mode: 'token',
        token: ''
    };
}

// 5. 禁用 emotion-state 默认 hook 以防 handler 警告
if (cfg.hooks && cfg.hooks.internal) {
    cfg.hooks.internal.enabled = false;
    if (cfg.hooks.internal.entries && cfg.hooks.internal.entries['emotion-state']) {
        cfg.hooks.internal.entries['emotion-state'].enabled = false;
    }
}

// 6. 用 2 空格缩进写回
let newJson = JSON.stringify(cfg, null, 2);

// 7. 防尺寸缩水自愈回滚的填充算法
const newBytes = Buffer.byteLength(newJson, 'utf8');
if (newBytes < originalBytes) {
    const padSize = originalBytes - newBytes;
    newJson = newJson + '\n' + ' '.repeat(padSize - 1);
}

fs.writeFileSync(cfgPath, newJson, 'utf8');
console.log('  Config cleaned.');
"@
    $cleanJs | Out-File -Encoding utf8 -NoNewline $cleanFile
    & "$sandboxDir\node.exe" $cleanFile $configFile
    Remove-Item $cleanFile -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "  IMPORTANT: Edit $configFile" -ForegroundColor Yellow
    Write-Host "  Replace YOUR_*_API_KEY_HERE with your actual API Keys." -ForegroundColor Yellow
    Write-Host "  Get Agnes key from: https://agnes-ai.com/zh-Hans/docs/agnes-video-v20" -ForegroundColor Yellow

    # Fix OpenClaw media failure warning
        $fixScript = Join-Path $scriptDir "fix-media-warning.js"
    if (Test-Path $fixScript) {
        $nvmExe = Join-Path $sandboxDir "node.exe"
        if (Test-Path $nvmExe) {
            & $nvmExe $fixScript 2>&1 | Out-Null
        }
    }

    # Create workspace files from templates
    $workspaceDir = Join-Path $configDir "workspace"
    if (-not (Test-Path $workspaceDir)) {
        New-Item -ItemType Directory -Path $workspaceDir -Force | Out-Null
    }
    $soulSrc = Join-Path $scriptDir "SOUL-template.md"
    $identitySrc = Join-Path $scriptDir "IDENTITY-template.md"
    if (Test-Path $soulSrc) {
        $soulDest = Join-Path $workspaceDir "SOUL.md"
        if (-not (Test-Path $soulDest)) {
            Copy-Item $soulSrc $soulDest -Force
            Write-Host "  Created custom SOUL.md in workspace." -ForegroundColor Green
        }
    }
    if (Test-Path $identitySrc) {
        $identityDest = Join-Path $workspaceDir "IDENTITY.md"
        if (-not (Test-Path $identityDest)) {
            Copy-Item $identitySrc $identityDest -Force
            Write-Host "  Created custom IDENTITY.md in workspace." -ForegroundColor Green
        }
    }
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


