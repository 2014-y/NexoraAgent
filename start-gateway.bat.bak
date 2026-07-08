@echo off
setlocal EnableDelayedExpansion
set BASE_PATH=%USERPROFILE%\.openclaw
set PATH=%BASE_PATH%;%PATH%
for /f "tokens=*" %%a in ('netstat -ano 2^>nul ^| findstr ":18789.*LISTENING"') do (
    set "line=%%a"
    for /f "tokens=5" %%p in ("!line!") do (
        set "PID=%%p"
        goto :FOUND_RUNNING
    )
)
goto :START_GATEWAY
:FOUND_RUNNING
echo [INFO] Gateway already running. Stopping...
taskkill /F /PID !PID! >nul 2>&1
timeout /t 3 /nobreak >nul
:START_GATEWAY
set NVM_HOME=C:\Users\Yuan\AppData\Roaming\nvm
set NVM_ARCH=64
set PATH=%NVM_HOME%;%NVM_HOME%\%NVM_ARCH%;%PATH%
call nvm use v24.13.0 >nul 2>&1
if errorlevel 1 (
    set NODE_HOME=C:\Users\Yuan\AppData\Roaming\nvm\v24.13.0
) else (
    for /f "tokens=*" %%i in ('where node') do set NODE_DIR=%%~dpi
    set NODE_HOME=!NODE_DIR!
    if "!NODE_HOME!"=="" set NODE_HOME=C:\Users\Yuan\AppData\Roaming\nvm\v24.13.0
)
cd /d "%USERPROFILE%\.openclaw"
echo ========================================
echo  OpenClaw Gateway Launcher (v24.13.0)
echo ========================================
echo.
if not exist "%NODE_HOME%\node.exe" (
    echo ERROR: Node.js v24.13.0 not found
    pause
    exit /b 1
)
echo Starting Gateway...
echo.
"%NODE_HOME%\node.exe" "%NODE_HOME%\node_modules\openclaw\dist\index.js" gateway run --force