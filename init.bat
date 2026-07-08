@echo off
setlocal
chcp 65001 >nul 2>&1

echo ========================================
echo  AI-v24.13.0 ?????
echo ========================================
echo.

:: ?? node-sandbox ?????
if exist "%~dp0\.node-sandbox\node.exe" (
    echo [OK] Node sandbox already installed.
    echo.
    echo You can now start the gateway:
    echo   Double-click start-gateway.bat
    echo.
    pause
    exit /b 0
)

echo [1/3] Checking for nvm-windows Node.js v24.13.0...

:: ??? nvm ??
set "NVM_SRC=C:\Users\%USERNAME%\AppData\Roaming\nvm\v24.13.0"
if not exist "%NVM_SRC%\node.exe" (
    set "NVM_SRC=%APPDATA%\nvm\v24.13.0"
)
if not exist "%NVM_SRC%\node.exe" (
    set "NVM_SRC=C:\Program Files\nodejs"
)

if exist "%NVM_SRC%\node.exe" (
    echo Found node at: %NVM_SRC%
    echo Creating .node-sandbox...
    robocopy "%NVM_SRC%" "%~dp0\.node-sandbox" /E /XF nul /XD nul /NP /NFL /NDL /NJH /NJS /MT:4
    if errorlevel 8 (
        echo [WARN] Some files may not have copied.
    ) else if errorlevel 1 (
        echo [OK] Node sandbox created.
    ) else (
        echo [OK] Node sandbox created.
    )
) else (
    echo [!] No node installation found.
    echo.
    echo Please install Node.js v24.x first, then run this script again.
    echo Or install nvm-windows: https://github.com/coreybutler/nvm-windows
    echo.
    pause
    exit /b 1
)

:: ??
if not exist "%~dp0\.node-sandbox\node.exe" (
    echo [ERROR] Failed to create node sandbox.
    pause
    exit /b 1
)

echo.
echo [OK] Verifying node...
"%~dp0\.node-sandbox\node.exe" --version
echo.
echo ========================================
echo  Setup complete!
echo ========================================
echo.
echo Next steps:
echo   1. Double-click start-gateway.bat to start
echo   2. Or run: npm install (if you need to add dependencies)
echo.
pause
