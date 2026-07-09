@echo off
setlocal

:: === 项目目录 ===
set "SCRIPT_DIR=%~dp0"
set "NODE_HOME=%SCRIPT_DIR%.node-sandbox"

:: === 检测 node.exe ===
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

:: === 确保 .openclaw 目录存在 ===
if not exist "%USERPROFILE%\.openclaw" (
    mkdir "%USERPROFILE%\.openclaw"
)

:: === 自动修复旧配置（含硬编码路径） ===
set "CONFIG_FILE=%USERPROFILE%\.openclaw\openclaw.json"
if exist "%CONFIG_FILE%" (
    powershell -NoProfile -Command "if (Select-String -Path '%CONFIG_FILE%' -Pattern 'C:\\\\Users\\\\Yuan' -Quiet) { exit 1 } else { exit 0 }"
    if errorlevel 1 (
        echo WARNING: Detected old config with hardcoded paths.
        echo Auto-fixing from template...
        if exist "%SCRIPT_DIR%config\openclaw.json.example" (
            copy /Y "%SCRIPT_DIR%config\openclaw.json.example" "%CONFIG_FILE%" >nul
            echo Config restored.
        ) else (
            echo WARNING: Template not found, continuing with old config.
        )
        echo.
    )
)

:: === 杀掉旧 gateway 进程 ===
for /f "tokens=*" %%a in ('netstat -ano 2^>nul ^| findstr ":18789.*LISTENING"') do (
    for /f "tokens=5" %%p in ("%%a") do (
        taskkill /F /PID %%p >nul 2>&1
    )
)
timeout /t 2 /nobreak >nul

:: === 动态查找 NVM 目录 ===
set "NVM_DIR=%USERPROFILE%\AppData\Roaming\nvm\latest"
if not exist "%NVM_DIR%" set "NVM_DIR=%APPDATA%\nvm\latest"
if not exist "%NVM_DIR%" set "NVM_DIR=C:\Program Files\nodejs"

:: === 查找 openclaw 模块 ===
set "NVM_MODS=%NVM_DIR%\node_modules"
if not exist "%NVM_MODS%\openclaw\dist\index.js" set "NVM_MODS=%APPDATA%\nvm\latest\node_modules"
if not exist "%NVM_MODS%\openclaw\dist\index.js" set "NVM_MODS=C:\Program Files\nodejs\node_modules"
if not exist "%NVM_MODS%\openclaw\dist\index.js" set "NVM_MODS=%USERPROFILE%\AppData\Roaming\nvm\latest\node_modules"
if not exist "%NVM_MODS%\openclaw\dist\index.js" (
    echo ERROR: openclaw not found!
    echo Please install openclaw: npm install -g openclaw
    pause
    exit /b 1
)

:: === 启动 ===
cd /d "%USERPROFILE%\.openclaw"
echo ========================================
echo  OpenClaw Gateway Launcher
echo ========================================
echo.
echo Node: %NODE_HOME%\node.exe
echo Modules: %NVM_MODS%
echo.
echo Starting...
echo.

"%NODE_HOME%\node.exe" --preserve-symlinks-main "%NVM_MODS%\openclaw\dist\index.js" gateway run --allow-unconfigured --force

echo.
echo Gateway exited.
pause
