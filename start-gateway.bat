@echo off
setlocal

:: === ????????? ===
set "SCRIPT_DIR=%~dp0"
set "NODE_HOME=%SCRIPT_DIR%.node-sandbox"

:: === ?? node-sandbox ???? ===
if not exist "%NODE_HOME%\node.exe" (
    echo ERROR: Node sandbox not found!
    echo.
    echo Please run init.bat first to set up the project.
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
echo  Node: %NODE_HOME%\node.exe
echo ========================================
echo.
start "" /b "%NODE_HOME%\node.exe" "%NODE_HOME%\node_modules\openclaw\dist\index.js" gateway run --force
echo.
echo Gateway started in background.
echo.
pause
