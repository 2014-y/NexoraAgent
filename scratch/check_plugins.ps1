$up = [Environment]::GetFolderPath('UserProfile')
$d = Join-Path $up '.openclaw'
Write-Output "USERPROFILE: $up"
Write-Output "ConfigDir: $d"
Write-Output "ConfigDirExists: $(Test-Path $d)"

$cf = Join-Path $d 'openclaw.json'
Write-Output "ConfigFileExists: $(Test-Path $cf)"

$ext = Join-Path $d 'extensions'
Write-Output "ExtensionsExists: $(Test-Path $ext)"
if (Test-Path $ext) {
    Write-Output "--- Extensions content: ---"
    Get-ChildItem $ext -Name -Directory
}

$np = Join-Path $d 'npm'
Write-Output "NpmDirExists: $(Test-Path $np)"
if (Test-Path $np) {
    $proj = Join-Path $np 'projects'
    if (Test-Path $proj) {
        Write-Output "--- npm/projects: ---"
        Get-ChildItem $proj -Name -Directory
    }
}

# Check node_modules for bundled channel plugins
$nodeModules = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules'
Write-Output ""
Write-Output "=== Bundled npm channel plugins ==="
$plugins = @(
    '@tencent-weixin\openclaw-weixin',
    '@openclaw\feishu',
    '@openclaw\qqbot',
    '@openclaw\slack',
    '@openclaw\voice-call',
    '@openclaw\whatsapp',
    '@openclaw\matrix'
)
foreach ($p in $plugins) {
    $full = Join-Path $nodeModules $p
    $exists = Test-Path $full
    Write-Output "${p}: $exists"
}
