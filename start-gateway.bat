@echo off
setlocal

:: === ????????? ===
set "SCRIPT_DIR=%~dp0"
set "NODE_HOME=%SCRIPT_DIR%.node-sandbox"

:: === ?? node.exe ???? ===
if not exist "%NODE_HOME%\node.exe" (
    echo.
    echo ========================================
    echo  ERROR: Node not found!
    echo ========================================
    echo.
    echo Please run init.bat first.
    echo.
    pause
    exit /b 1
)

:: === ?? .openclaw ???? ===
if not exist "%USERPROFILE%\.openclaw" (
    mkdir "%USERPROFILE%\.openclaw"
)

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
echo  OpenClaw Gateway Launcher
echo ========================================
echo.
echo Starting...
echo.

:: ? node-sandbox ? node?? MODULES_PATH ?? nvm ? node_modules
set "NVM_MODULES=%USERPROFILE%\AppData\Roaming\nvm\v24.13.0\node_modules"
if not exist "%NVM_MODULES%" (
    set "NVM_MODULES=%APPDATA%\nvm\v24.13.0\node_modules"
)
set "NODE_PATH=%NVM_MODULES%"

"%NODE_HOME%\node.exe" --preserve-symlinks-main "%NVM_MODULES%\openclaw\dist\index.js" gateway run --allow-unconfigured --force

echo.
echo Gateway exited.
pause
