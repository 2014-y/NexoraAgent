# Fix: Re-sync ~/.openclaw/openclaw.json plugin entries from the project repo config
# This resolves the "plugins not loading on new machine" issue.

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoConfig = Join-Path $repoRoot 'openclaw.json'
$runtimeConfig = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.openclaw\openclaw.json'

if (-not (Test-Path $runtimeConfig)) {
    Write-Output "Runtime config not found: $runtimeConfig"
    exit 1
}

# Backup first
$backup = "$runtimeConfig.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $runtimeConfig $backup
Write-Output "Backup: $backup"

# Read runtime config as raw text, fix encoding issues
$raw = [System.IO.File]::ReadAllText($runtimeConfig, [System.Text.Encoding]::UTF8)
# Remove trailing whitespace/nulls that might cause parse errors
$raw = $raw.TrimEnd("`0", " ", "`r", "`n")

# Use Node.js to do the JSON manipulation since PowerShell's JSON handling is unreliable with large files
$nodeScript = @"
const fs = require('fs');
const path = require('path');

const runtimePath = process.argv[2];
const raw = fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/, '').replace(/\0+$/, '').trim();
const config = JSON.parse(raw);

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.allow) config.plugins.allow = [];
if (!config.plugins.load) config.plugins.load = {};
if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
if (!config.plugins.installs) config.plugins.installs = {};

// 1. Force-enable all custom/bundled plugins
const MUST_ENABLE = [
    'error-filter', 'weixin-reconnect', 'auto-summary', 'dual-model-trainer',
    'memory-rotate', 'disk-compact', 'compaction-memory-guard', 'context-router',
    'health-check', 'remote-policy', 'long-term-memory',
    'openclaw-weixin', 'duckduckgo', 'webhooks', 'bonjour', 'workboard'
];

for (const id of MUST_ENABLE) {
    if (!config.plugins.entries[id]) config.plugins.entries[id] = {};
    config.plugins.entries[id].enabled = true;
}

// 2. Ensure all enabled plugins are in allow list (except UI-only IDs)
const UI_ONLY = ['long-term-memory'];
for (const [id, entry] of Object.entries(config.plugins.entries)) {
    if (entry && entry.enabled === true && !UI_ONLY.includes(id)) {
        if (!config.plugins.allow.includes(id)) {
            config.plugins.allow.push(id);
        }
    }
}

// 3. Fix load.paths: remove stale Program Files paths if running from Desktop dev copy
const desktopAppRoot = process.argv[3] || path.resolve(__dirname, '..');
const cleanPaths = config.plugins.load.paths.filter(p => {
    // Keep paths that exist
    try { return fs.existsSync(p); } catch { return false; }
});

// Ensure weixin load path is present (it uses viaLoadPaths: true)
const wxPath = path.join(desktopAppRoot, 'node_modules', '@tencent-weixin', 'openclaw-weixin');
if (fs.existsSync(wxPath) && !cleanPaths.includes(wxPath)) {
    cleanPaths.push(wxPath);
}

config.plugins.load.paths = cleanPaths;

// 4. Ensure extensions load.paths are included
const extRoot = path.join(process.env.USERPROFILE || '', '.openclaw', 'extensions');
if (fs.existsSync(extRoot)) {
    for (const name of fs.readdirSync(extRoot)) {
        const extDir = path.join(extRoot, name);
        try {
            if (!fs.statSync(extDir).isDirectory()) continue;
            const resolvedPath = path.resolve(extDir);
            // Only add if not already present and the plugin is enabled
            if (!cleanPaths.some(p => path.resolve(p) === resolvedPath)) {
                const entry = config.plugins.entries[name];
                if (entry && entry.enabled === true) {
                    config.plugins.load.paths.push(extDir);
                }
            }
        } catch (e) {}
    }
}

// 5. Fix logging level (fatal/silent prevents seeing plugin load messages)
if (!config.logging) config.logging = {};
if (config.logging.level === 'fatal' || config.logging.level === 'silent') {
    config.logging.level = 'info';
}

// Write back
fs.writeFileSync(runtimePath, JSON.stringify(config, null, 2), 'utf8');
console.log('Done! Runtime config updated successfully.');
console.log('Enabled plugins:', Object.entries(config.plugins.entries).filter(([k,v]) => v && v.enabled).map(([k]) => k).join(', '));
console.log('Allow list:', config.plugins.allow.join(', '));
console.log('Load paths:', config.plugins.load.paths.join('\n  '));
"@

# Write the node script to a temp file and run it
$scriptPath = Join-Path $PSScriptRoot 'fix_runtime_plugins.js'
Set-Content -Path $scriptPath -Value $nodeScript -Encoding UTF8
node $scriptPath $runtimeConfig $repoRoot
Remove-Item $scriptPath -ErrorAction SilentlyContinue
