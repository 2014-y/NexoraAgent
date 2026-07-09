param([string[]]$Args)

# If someone calls wmic, redirect to our system-info.cmd
$exe = $Args[0]
$rest = $Args | Select-Object -Skip 1

if ($exe -eq 'wmic' -or $exe -eq 'WMIC') {
    # Try to parse wmic command and convert to system-info
    $cmdLine = ($Args -join ' ').ToLower()
    
    if ($cmdLine -match 'cpu') {
        cmd /c "%USERPROFILE%/.openclaw/system-info.cmd cpu"
        exit $LASTEXITCODE
    }
    if ($cmdLine -match 'videocontroller|graphics|display') {
        cmd /c "%USERPROFILE%/.openclaw/system-info.cmd gpu"
        exit $LASTEXITCODE
    }
    if ($cmdLine -match 'memory|ram') {
        cmd /c "%USERPROFILE%/.openclaw/system-info.cmd memory"
        exit $LASTEXITCODE
    }
    if ($cmdLine -match 'disk|drive') {
        cmd /c "%USERPROFILE%/.openclaw/system-info.cmd disk"
        exit $LASTEXITCODE
    }
    if ($cmdLine -match 'nic|network') {
        cmd /c "%USERPROFILE%/.openclaw/system-info.cmd network"
        exit $LASTEXITCODE
    }
    
    # Default: try to get what wmic would have returned
    cmd /c "%USERPROFILE%/.openclaw/system-info.cmd"
    exit $LASTEXITCODE
}

# If not wmic, just run the original command
cmd /c "$exe $rest"
exit $LASTEXITCODE

