@echo off
setlocal

:: === SCRIPT DIR ===
set "SCRIPT_DIR=%~dp0"
set "NODE_HOME=%SCRIPT_DIR%.node-sandbox"

:: === CHECK node.exe ===
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

:: === Ensure .openclaw dir exists ===
if not exist "%USERPROFILE%\.openclaw" (
    mkdir "%USERPROFILE%\.openclaw"
)

:: === Copy config template ===
set "CONFIG_FILE=%USERPROFILE%\.openclaw\openclaw.json"
if not exist "%CONFIG_FILE%" (
    if exist "%SCRIPT_DIR%config\openclaw.json.example" (
        copy /Y "%SCRIPT_DIR%config\openclaw.json.example" "%CONFIG_FILE%" >nul
    )
)

:: === Kill existing gateway process ===
for /f "tokens=*" %%a in ('netstat -ano 2^>nul ^| findstr ":18789.*LISTENING"') do (
    for /f "tokens=5" %%p in ("%%a") do (
        echo Freeing port 18789 (PID %%p)...
        taskkill /F /T /PID %%p >nul 2>&1
    )
)
timeout /t 2 /nobreak >nul

:: === Find openclaw path ===
set "OC_INDEX="

:: Try project local node_modules first
if exist "%SCRIPT_DIR%node_modules\openclaw\dist\index.js" (
    set "OC_INDEX=%SCRIPT_DIR%node_modules\openclaw\dist\index.js"
) else (
    :: Fallback to global NVM or Node.js directory (调用子过程: 按数值选最高版本)
    call :find_oc
)

if not defined OC_INDEX (
    echo ERROR: openclaw not found!
    echo Please install openclaw: npm install -g openclaw
    pause
    exit /b 1
)

:: === Propagate patch to ALL child node processes via NODE_OPTIONS ===
:: NODE_OPTIONS 需用正斜杠路径, 否则其解析器会把反斜杠当转义符吞掉 (C:\Users -> C:Users)
set "PATCH_FWD=%SCRIPT_DIR:\=/%patch_gateway.js"
set "NODE_OPTIONS=--require "%PATCH_FWD%" --dns-result-order=ipv4first --no-warnings"

:: === RUN ===
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

"%NODE_HOME%\node.exe" --require "%SCRIPT_DIR%patch_gateway.js" --preserve-symlinks-main "%OC_INDEX%" gateway run --allow-unconfigured --force

echo.
echo Gateway exited.
pause
exit /b

:: === 在 NVM 目录里按数值(而非字典序)选最高版本, 避免 v9 高于 v24 ===
:find_oc
set "NVM_DIR=%USERPROFILE%\AppData\Roaming\nvm"
set "NVM_MODS="
set "BEST_VER=0"
if exist "%NVM_DIR%" (
    for /d %%d in ("%NVM_DIR%\v*") do call :pick_nvm "%%d"
)
if not defined NVM_MODS if exist "C:\Program Files\nodejs\node_modules" set "NVM_MODS=C:\Program Files\nodejs\node_modules"
if defined NVM_MODS if exist "%NVM_MODS%\openclaw\dist\index.js" set "OC_INDEX=%NVM_MODS%\openclaw\dist\index.js"
if not defined OC_INDEX if exist "C:\Program Files\nodejs\node_modules\openclaw\dist\index.js" set "OC_INDEX=C:\Program Files\nodejs\node_modules\openclaw\dist\index.js"
goto :eof

:pick_nvm
:: 解析 major.minor.patch (set /a 把空/未定义变量当作 0), 取带 openclaw 的最高版本
set "CUR=%~nx1"
set "CUR=%CUR:v=%"
set "MAJ=0" & set "MIN=0" & set "PAT=0"
for /f "tokens=1,2,3 delims=." %%x in ("%CUR%") do (set "MAJ=%%x" & set "MIN=%%y" & set "PAT=%%z")
set /a "CURNUM=MAJ*1000000+MIN*1000+PAT" 2>nul
if %CURNUM% gtr %BEST_VER% if exist "%~1\node_modules\openclaw\dist\index.js" (
    set "BEST_VER=%CURNUM%"
    set "NVM_MODS=%~1\node_modules"
)
goto :eof