$dir = Join-Path $env:USERPROFILE '.openclaw\voice-packs'
if (-not (Test-Path $dir)) { Write-Output 'none'; exit 0 }
Get-ChildItem $dir -Directory | ForEach-Object { $_.Name }
