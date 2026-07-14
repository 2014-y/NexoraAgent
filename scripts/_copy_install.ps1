$ErrorActionPreference = "Continue"
$src = "C:\Users\Yuan\Desktop\ClawAI\ClawAI"
$dst = "C:\Program Files\ClawAI\resources\app"
$files = @("index.html","renderer.js","index.css","plugin-catalog.js","preload.js","main.js","locales.js","latency-tune.js","token-usage-parse.js","home-resolve.js")
Write-Output "=== STOP ==="
try { Get-Process -Name "ClawAI" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Write-Output "stop-done"
Write-Output "=== COPY ==="
$fail = $false
foreach ($f in $files) {
  try {
    Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force -ErrorAction Stop
    Write-Output ("Copied " + $f)
  } catch {
    Write-Output ("FAIL " + $f + " : " + $_.Exception.Message)
    $fail = $true
  }
}
if ($fail) {
  Write-Output "Need elevation"
  $elev = @"
`$src='$src'; `$dst='$dst'
`$files=@('index.html','renderer.js','index.css','plugin-catalog.js','preload.js','main.js','locales.js','latency-tune.js','token-usage-parse.js','home-resolve.js')
foreach(`$f in `$files){ Copy-Item -LiteralPath (Join-Path `$src `$f) -Destination (Join-Path `$dst `$f) -Force }
"@
  $ep = Join-Path $env:TEMP "clawai-elev-copy.ps1"
  Set-Content -Path $ep -Value $elev -Encoding UTF8
  Start-Process powershell -Verb RunAs -Wait -ArgumentList "-ExecutionPolicy Bypass -NoProfile -File `"$ep`""
  Write-Output "elev-finished"
}
Write-Output "=== VERIFY ==="
python "C:\Users\Yuan\Desktop\ClawAI\ClawAI\scripts\_verify_ids.py"
