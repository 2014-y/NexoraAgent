@echo off
setlocal

:: === ?????? node/nvm ???? ===
set "PATH="

:: === ??????????? ===
set "PATH=C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\;C:\WINDOWS\System32\OpenSSH\"

:: === ?????????????? node/nvm? ===
set "PATH=%PATH%;%USERPROFILE%\.openclaw"

:: === ?????? node ===
set "NODE_HOME=C:\Users\Yuan\AppData\Roaming\nvm\v24.13.0"

:: === ???? gateway ===
for /f "tokens=*" %%a in ('netstat -ano 2^>nul ^| findstr ":18789.*LISTENING"') do (
    for /f "tokens=5" %%p in ("%%a") do (
        taskkill /F /PID %%p >nul 2>&1
    )
)
timeout /t 2 /nobreak >nul

:: === ?? ===
cd /d "%USERPROFILE%\.openclaw"
echo ========================================
echo  OpenClaw Gateway (Hard Sandbox)
echo  Node: %NODE_HOME%\node.exe
echo  PATH: (system only, no global node)
echo ========================================
echo.
if not exist "%NODE_HOME%\node.exe" (
    echo ERROR: Node not found at %NODE_HOME%
    pause
    exit /b 1
)
"%NODE_HOME%\node.exe" "%NODE_HOME%\node_modules\openclaw\dist\index.js" gateway run --force
