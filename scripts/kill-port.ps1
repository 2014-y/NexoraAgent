param([int]$Port = 18789)
try {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $procId = $c.OwningProcess
    if ($procId) {
      Write-Output ("kill pid=" + $procId + " port=" + $Port)
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
Write-Output 'done'
