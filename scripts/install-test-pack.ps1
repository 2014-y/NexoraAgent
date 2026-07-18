$src = Join-Path $PSScriptRoot '..\.tmp-voice-test\piper-zh-chaowen'
$dst = Join-Path $env:USERPROFILE '.openclaw\voice-packs\piper-zh-chaowen'
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
Copy-Item -Recurse -Force $src $dst
@'
{
  "id": "piper-zh-chaowen",
  "name": "超文 chaowen",
  "downloadedAt": "e2e"
}
'@ | Set-Content -Path (Join-Path $dst 'pack.json') -Encoding UTF8
Write-Output ("installed to " + $dst)
Get-ChildItem $dst -Recurse -Filter *.onnx | ForEach-Object { $_.FullName }
