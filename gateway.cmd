@echo off
rem OpenClaw Gateway (v2026.7.1-2)
set "BASE_PATH=%USERPROFILE%\.openclaw"
set "TMPDIR=%TEMP%"
set "OPENCLAW_GATEWAY_PORT=18789"
set "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"
set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=1"
set "OPENCLAW_SERVICE_MARKER=openclaw"
set "OPENCLAW_SERVICE_KIND=gateway"
set "OPENCLAW_SERVICE_VERSION=2026.7.1-2"

rem === 动态查找 NVM Node.js ===
set "NVM_DIR=%USERPROFILE%\AppData\Roaming\nvm"
set "NVM_EXE="
set "BEST_NODE=0"

if exist "%NVM_DIR%" (
    for /d %%d in ("%NVM_DIR%\v*") do call :pick_node "%%d"
)
if not defined NVM_EXE if exist "C:\Program Files\nodejs\node.exe" set "NVM_EXE=C:\Program Files\nodejs\node.exe"
rem 若 NVM / Program Files 都没有, 用 PATH 上的 node (where 解析真实路径, 而非测试字面量 "node")
if not defined NVM_EXE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NVM_EXE set "NVM_EXE=%%n"

if not defined NVM_EXE (
    echo ERROR: Node.js not found. Please install Node.js v24+.
    pause
    exit /b 1
)

rem === 动态查找 openclaw dist/index.js (按数值选最高版本) ===
set "OC_INDEX="
set "BEST_OC=0"
if exist "%NVM_DIR%" (
    for /d %%d in ("%NVM_DIR%\v*") do call :pick_oc "%%d"
)
if not defined OC_INDEX if exist "C:\Program Files\nodejs\node_modules\openclaw\dist\index.js" set "OC_INDEX=C:\Program Files\nodejs\node_modules\openclaw\dist\index.js"

if not defined OC_INDEX (
    echo ERROR: openclaw not found. Run: npm install -g openclaw
    pause
    exit /b 1
)

rem === Propagate patch to ALL child node processes via NODE_OPTIONS ===
rem NODE_OPTIONS 需用正斜杠路径, 否则其解析器会把反斜杠当转义符吞掉 (C:\Users -> C:Users)
set "SCRIPT_FWD=%~dp0"
set "SCRIPT_FWD=%SCRIPT_FWD:\=/%"
set "NODE_OPTIONS=--require "%SCRIPT_FWD%patch_gateway.js" --dns-result-order=ipv4first --no-warnings"

"%NVM_EXE%" --require "%~dp0patch_gateway.js" "%OC_INDEX%" gateway --port 18789
exit /b %errorlevel%

:: === 数值比较 node 版本, 取最高 (避免 v9 字典序高于 v24; set /a 把空变量当 0) ===
:pick_node
set "CUR=%~nx1"
set "CUR=%CUR:v=%"
set "MAJ=0" & set "MIN=0" & set "PAT=0"
for /f "tokens=1,2,3 delims=." %%x in ("%CUR%") do (set "MAJ=%%x" & set "MIN=%%y" & set "PAT=%%z")
set /a "CURNUM=MAJ*1000000+MIN*1000+PAT" 2>nul
if %CURNUM% gtr %BEST_NODE% if exist "%~1\node.exe" (
    set "BEST_NODE=%CURNUM%"
    set "NVM_EXE=%~1\node.exe"
)
goto :eof

:pick_oc
set "CUR=%~nx1"
set "CUR=%CUR:v=%"
set "MAJ=0" & set "MIN=0" & set "PAT=0"
for /f "tokens=1,2,3 delims=." %%x in ("%CUR%") do (set "MAJ=%%x" & set "MIN=%%y" & set "PAT=%%z")
set /a "CURNUM=MAJ*1000000+MIN*1000+PAT" 2>nul
if %CURNUM% gtr %BEST_OC% if exist "%~1\node_modules\openclaw\dist\index.js" (
    set "BEST_OC=%CURNUM%"
    set "OC_INDEX=%~1\node_modules\openclaw\dist\index.js"
)
goto :eof
