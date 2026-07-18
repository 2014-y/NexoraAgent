try {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match 'node|openclaw' -and
      $_.CommandLine -and
      ($_.CommandLine -like '*openclaw*' -or $_.CommandLine -like '*gateway*') -and
      ($_.CommandLine -like '*18789*' -or $_.CommandLine -like '*openclaw*gateway*' -or $_.CommandLine -like '*dist\index.js*gateway*' -or $_.CommandLine -like '*openclaw.mjs*')
    } |
    ForEach-Object {
      Write-Output ("kill " + $_.ProcessId)
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}
Write-Output 'done'
