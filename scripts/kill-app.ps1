try {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*NexoraAgent*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
Write-Output 'killed'
