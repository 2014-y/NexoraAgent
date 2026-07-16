# Check for crash/error indicators
$configDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.openclaw'

Write-Output "=== Checking main_error.log ==="
$errorLog = Join-Path $configDir 'main_error.log'
if (Test-Path $errorLog) {
    Get-Content $errorLog -Tail 30 -Encoding UTF8
} else {
    Write-Output "(not found)"
}

Write-Output ""
Write-Output "=== Checking gateway_stdout.log (full) ==="
$gwLog = Join-Path $configDir 'gateway_stdout.log'
if (Test-Path $gwLog) {
    $size = (Get-Item $gwLog).Length
    Write-Output "File size: $size bytes"
    Get-Content $gwLog -Tail 80 -Encoding UTF8
} else {
    Write-Output "(not found)"
}

Write-Output ""
Write-Output "=== Recent .log files in config dir ==="
Get-ChildItem $configDir -Filter '*.log' -ErrorAction SilentlyContinue | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object Name, Length, LastWriteTime -First 10 |
    Format-Table -AutoSize

Write-Output ""  
Write-Output "=== Check if any node/openclaw process is running ==="
Get-Process -Name 'node','openclaw' -ErrorAction SilentlyContinue | 
    Select-Object Id, Name, StartTime, CPU |
    Format-Table -AutoSize

Write-Output ""
Write-Output "=== Current Nexora Agent status ==="
# Check if Electron app is running
Get-Process | Where-Object { $_.MainWindowTitle -like '*Nexora Agent*' -or $_.Name -like '*Nexora Agent*' -or $_.Name -like '*electron*' } |
    Select-Object Id, Name, MainWindowTitle, StartTime |
    Format-Table -AutoSize
