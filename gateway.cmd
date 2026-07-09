@echo off
rem OpenClaw Gateway (v2026.6.11)
set "BASE_PATH=%USERPROFILE%\.openclaw"
set "TMPDIR=%TEMP%"
set "OPENCLAW_GATEWAY_PORT=18789"
set "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"
set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=1"
set "OPENCLAW_SERVICE_MARKER=openclaw"
set "OPENCLAW_SERVICE_KIND=gateway"
set "OPENCLAW_SERVICE_VERSION=2026.6.11"
"%USERPROFILE%\AppData\Roaming\nvm\v24.13.0\node.exe" "%USERPROFILE%\AppData\Roaming\nvm\v24.13.0\node_modules\openclaw\dist\index.js" gateway --port 18789
