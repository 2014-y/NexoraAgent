$ErrorActionPreference = 'Continue'
try {
    Write-Output '---procs---'
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -like '*Nexora Agent*' -or
            $_.CommandLine -like '*openclaw*' -or
            $_.ExecutablePath -like '*.node-sandbox*'
        }
    if ($procs) {
        foreach ($p in @($procs)) {
            $cmd = [string]$p.CommandLine
            $short = if ($cmd.Length -gt 140) { $cmd.Substring(0, 140) + '...' } else { $cmd }
            Write-Output ("PROC pid=" + $p.ProcessId)
            Write-Output ("EXE_HAS_SANDBOX=" + ([string]$p.ExecutablePath -like '*.node-sandbox*'))
            Write-Output ("CMD_HAS_GATEWAY=" + ($cmd -like '*gateway*'))
            Write-Output ("CMD_PREFIX=" + $short)
            Write-Output '---'
        }
    } else {
        Write-Output 'NO_SANDBOX_NODE_PROCESS'
    }

    Write-Output '---port---'
    $c = @(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue)
    if ($c.Count -gt 0) {
        foreach ($x in $c) {
            Write-Output ("LISTEN " + $x.LocalAddress + ":" + $x.LocalPort + " pid=" + $x.OwningProcess)
        }
    } else {
        Write-Output 'PORT_18789_NOT_LISTENING'
    }

    Write-Output '---http---'
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18789/acp/' -UseBasicParsing -TimeoutSec 3
        Write-Output ("HTTP_ACP=" + $r.StatusCode + " len=" + $r.Content.Length)
    } catch {
        Write-Output ("HTTP_ACP_FAIL=" + $_.Exception.Message)
    }
    try {
        $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:18789/' -UseBasicParsing -TimeoutSec 3
        Write-Output ("HTTP_ROOT=" + $r2.StatusCode)
    } catch {
        Write-Output ("HTTP_ROOT_FAIL=" + $_.Exception.Message)
    }

    Write-Output '---config---'
    $cf = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
    if (Test-Path $cf) {
        $j = Get-Content $cf -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Output ("port=" + $j.gateway.port)
        Write-Output ("auth.mode=" + $j.gateway.auth.mode)
        $tok = [string]$j.gateway.auth.token
        Write-Output ("token_len=" + $tok.Length)
        Write-Output ("token_is_default_dev=" + ($tok -eq 'openclaw-dev-token-998877'))
        Write-Output ("basePath=" + $j.gateway.controlUi.basePath)
        Write-Output ("bind=" + $j.gateway.bind)
    } else {
        Write-Output 'NO_CONFIG'
    }

    Write-Output '---log---'
    $log = Join-Path $env:USERPROFILE '.openclaw\gateway_stdout.log'
    if (Test-Path $log) {
        Get-Content $log -Tail 40 -Encoding UTF8 | ForEach-Object {
            $line = $_
            $line = $line -replace 'token=[^&\s\"]+', 'token=***'
            $line = $line -replace 'openclaw-dev-token-\d+', '***'
            $line = $line -replace '[a-fA-F0-9]{32}', '***'
            $line
        }
    } else {
        Write-Output 'NO_LOG'
    }
} catch {
    Write-Output $_.Exception.Message
}
exit 0
