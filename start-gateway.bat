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

:: === ????? openclaw.json ===
set "CONFIG_FILE=%USERPROFILE%\.openclaw\openclaw.json"
if exist "%CONFIG_FILE%" (
    findstr /i "C:\\Users\\Yuan" "%CONFIG_FILE%" >nul 2>&1
    if not errorlevel 1 (
        echo WARNING: Detected old config with hardcoded paths.
        echo Restoring from template...
        if exist "%SCRIPT_DIR%config\openclaw.json.example" (
            copy /Y "%SCRIPT_DIR%config\openclaw.json.example" "%CONFIG_FILE%" >nul
            echo Config restored. Please edit %CONFIG_FILE% and fill in your API keys.
        ) else (
            echo ERROR: Template not found!
        )
        echo.
        pause
        exit /b 1
    )
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

"%NODE_HOME%\node.exe" "%NODE_HOME%\node_modules\openclaw\dist\index.js" gateway run --allow-unconfigured --force

echo.
echo Gateway exited.
pause
