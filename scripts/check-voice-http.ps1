try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18791/voice/state' -UseBasicParsing -TimeoutSec 2
  Write-Output $r.Content
} catch {
  Write-Output ('HTTP_FAIL: ' + $_.Exception.Message)
}
