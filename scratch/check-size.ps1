$root = Split-Path -Parent $PSScriptRoot
$size = (Get-ChildItem (Join-Path $root '.node-sandbox\node_modules') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Output "npm sandbox node_modules size: $([math]::Round($size / 1MB, 2)) MB"
