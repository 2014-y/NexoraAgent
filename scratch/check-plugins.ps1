$builtinPlugins = @(
    'auto-summary','compaction-memory-guard','context-router',
    'disk-compact','dual-model-trainer','error-filter',
    'health-check','memory-rotate','remote-policy','weixin-reconnect'
)

# Check which plugin-like packages exist in node_modules
$nmPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules'
$dirs = Get-ChildItem $nmPath -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name

# Also check @openclaw scoped packages
$scopedPath = Join-Path $nmPath '@openclaw'
if (Test-Path $scopedPath) {
    $scopedDirs = Get-ChildItem $scopedPath -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    foreach ($d in $scopedDirs) {
        $dirs += "@openclaw/$d"
    }
}

# Check @tencent-weixin
$wxPath = Join-Path $nmPath '@tencent-weixin'
if (Test-Path $wxPath) {
    $wxDirs = Get-ChildItem $wxPath -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    foreach ($d in $wxDirs) {
        $dirs += "@tencent-weixin/$d"
    }
}

# Plugin names from config that need external install
$externalPlugins = @(
    'voice-call','slack','whatsapp','lobster','signal','matrix',
    'msteams','nostr','twitch','line','mattermost','nextcloud-talk',
    'tlon','zalo','zalouser','googlechat','tavily','clickclack',
    'discord','feishu','qqbot','searxng','sms','irc',
    'openclaw-weixin','long-term-memory','channel-router'
)

Write-Output "=== Builtin plugins (in plugins/ dir) ==="
$builtinPlugins | ForEach-Object { Write-Output "  [OK] $_" }

Write-Output ""
Write-Output "=== Checking external plugins in node_modules ==="
foreach ($p in $externalPlugins) {
    $found = $false
    if ($dirs -contains $p) { $found = $true }
    if ($dirs -contains "openclaw-plugin-$p") { $found = $true }
    if ($dirs -contains "@openclaw/$p") { $found = $true }
    if ($dirs -contains "@tencent-weixin/$p") { $found = $true }
    if ($dirs -contains "@tencent-weixin/openclaw-$p") { $found = $true }
    
    if ($found) {
        Write-Output "  [FOUND] $p"
    } else {
        Write-Output "  [MISSING] $p"
    }
}

Write-Output ""
Write-Output "=== Interesting node_modules dirs ==="
$dirs | Where-Object { $_ -match 'openclaw|telegram|lobster|ollama|duckduck|webhook|bonjour|workboard|memory|channel' } | ForEach-Object { Write-Output "  $_" }
