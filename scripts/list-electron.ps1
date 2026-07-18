try {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*NexoraAgent*' -or $_.CommandLine -like '*ai-assistant*' -or $_.CommandLine -like '*electron\.exe*' } |
    ForEach-Object {
      $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(220, $_.CommandLine.Length)) } else { '' }
      Write-Output ("PID=" + $_.ProcessId + " CMD=" + $cmd)
    }
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
