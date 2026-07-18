try {
  $st = Invoke-WebRequest -Uri 'http://127.0.0.1:18791/voice/status' -UseBasicParsing -TimeoutSec 2
  Write-Output ('STATUS: ' + $st.Content)
} catch {
  Write-Output ('STATUS_FAIL: ' + $_.Exception.Message)
}
try {
  $body = [System.Text.Encoding]::UTF8.GetBytes('{"text":"这是渠道回复朗读链路测试。","source":"channel"}')
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18791/voice/speak' -Method POST -ContentType 'application/json; charset=utf-8' -Body $body -UseBasicParsing -TimeoutSec 5
  Write-Output ('SPEAK: ' + $r.Content)
} catch {
  Write-Output ('SPEAK_FAIL: ' + $_.Exception.Message)
}
