
$ErrorActionPreference='SilentlyContinue'
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $_.ExecutablePath -like '*Nexora Agent*' -or
      $_.CommandLine -like '*openclaw*' -or
      $_.ExecutablePath -like '*.node-sandbox*'
    }
  if (-not $procs) { 'NO_SANDBOX_NODE_PROCESS'; exit 0 }
  foreach ($p in @($procs)) {
    'PROC pid=' + $p.ProcessId
    'EXE_HAS_SANDBOX=' + ([string]$p.ExecutablePath -like '*.node-sandbox*')
    'CMD_HAS_GATEWAY=' + (([string]$p.CommandLine) -like '*gateway*')
  }
} catch { 'PROC_CHECK_FAIL' }
exit 0
