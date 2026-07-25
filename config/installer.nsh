; Nexora Agent NSIS 安装定制
;
; 安装/升级：只重建 gateway-runtime（清旧 runtime 缓存，避免旧文件导致启动报错）
;            不动 %USERPROFILE%\.openclaw、Electron AppData 等用户配置
; 卸载：清 %LOCALAPPDATA%\NexoraAgent / %APPDATA%\NexoraAgent 应用缓存（保留其中的 .openclaw）
;       仍默认保留 %USERPROFILE%\.openclaw；Electron AppData 由勾选框决定

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro NexoraAgent_Log MESSAGE
  CreateDirectory "$LOCALAPPDATA\NexoraAgent"
  FileOpen $8 "$LOCALAPPDATA\NexoraAgent\install.log" a
  FileWrite $8 "${MESSAGE}\r\n"
  FileClose $8
  DetailPrint "${MESSAGE}"
!macroend

!macro NexoraAgent_ForceKill
  SetDetailsPrint both
  !insertmacro NexoraAgent_Log "[process] stopping existing Nexora Agent processes"
  ; 同时匹配安装目录（Nexora Agent）与 runtime 缓存目录（NexoraAgent，无空格）
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Stop-Process -Name \"Nexora Agent\" -Force -ErrorAction SilentlyContinue; Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try { $$p = [string]$$.Path; $$p -like \"*Nexora Agent*\" -or $$p -like \"*NexoraAgent*\" } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"'
  Pop $0
  Sleep 800
!macroend

!macro customInit
!macroend

!macro customCheckAppRunning
  !insertmacro NexoraAgent_ForceKill
!macroend

!macro customInstall
  SetDetailsPrint both
  !insertmacro NexoraAgent_ForceKill

  !insertmacro NexoraAgent_Log "[install] begin custom install stage"
  !insertmacro NexoraAgent_Log "[install] INSTDIR=$INSTDIR"
  !insertmacro NexoraAgent_Log "[install] LOCALAPPDATA=$LOCALAPPDATA"
  !insertmacro NexoraAgent_Log "[install] resources=$INSTDIR\resources"
  !insertmacro NexoraAgent_Log "[install] installing application files"

  CreateDirectory "$LOCALAPPDATA\NexoraAgent"

  ; 升级/重装：先清旧 gateway-runtime，再解压新包。
  ; 只删 runtime 目录，保留同级其它数据；绝不碰 %USERPROFILE%\.openclaw。
  !insertmacro NexoraAgent_Log "[runtime] removing stale gateway-runtime cache before extract"
  nsExec::Exec 'cmd /c if exist "$LOCALAPPDATA\NexoraAgent\gateway-runtime" rmdir /s /q "$LOCALAPPDATA\NexoraAgent\gateway-runtime"'
  Pop $0
  !insertmacro NexoraAgent_Log "[runtime] remove stale gateway-runtime exitCode=$0"

  CreateDirectory "$LOCALAPPDATA\NexoraAgent\gateway-runtime"

  !insertmacro NexoraAgent_Log "[runtime] primary tar=$SYSDIR\tar.exe"
  !insertmacro NexoraAgent_Log "[runtime] archive=$INSTDIR\resources\gateway-runtime.tar"
  !insertmacro NexoraAgent_Log "[runtime] target=$LOCALAPPDATA\NexoraAgent\gateway-runtime"
  nsExec::Exec '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\gateway-runtime.tar" -C "$LOCALAPPDATA\NexoraAgent\gateway-runtime"'
  Pop $0
  !insertmacro NexoraAgent_Log "[runtime] primary tar exitCode=$0"

  ${If} $0 != 0
    !insertmacro NexoraAgent_Log "[runtime] primary tar failed, trying PowerShell tar fallback"
    ; 必须把 tar 的真实退出码传出；勿写 exit 0 掩盖失败，否则会盖上假 stamp
    nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"Stop\"; try { & tar -xf \"$INSTDIR\resources\gateway-runtime.tar\" -C \"$LOCALAPPDATA\NexoraAgent\gateway-runtime\"; if ($$LASTEXITCODE -ne $$null -and $$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }; exit 0 } catch { exit 1 }"'
    Pop $0
    !insertmacro NexoraAgent_Log "[runtime] fallback tar exitCode=$0"
  ${EndIf}

  ${If} $0 == 0
    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-version" w
    FileWrite $1 "${VERSION}"
    FileClose $1
    ; 与 gateway-runtime.js writeRuntimeStamp 对齐，避免首次启动再整包重解压

    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-stamp" w
    FileWrite $1 "${VERSION}:pack-98c815ddf069"
    FileClose $1
    !insertmacro NexoraAgent_Log "[runtime] fresh runtime install completed"
  ${Else}
    !insertmacro NexoraAgent_Log "[runtime] extract failed or skipped; first app launch will complete runtime preparation"
  ${EndIf}

  !insertmacro NexoraAgent_Log "[install] custom install stage finished"
!macroend

!macro customUnInstall
  SetDetailsPrint both
  !insertmacro NexoraAgent_Log "[uninstall] stopping related processes"
  !insertmacro NexoraAgent_ForceKill
  !insertmacro NexoraAgent_Log "[uninstall] removing LOCALAPPDATA and APPDATA NexoraAgent caches"

  ; 卸载：必清 gateway-runtime 等应用缓存；若目录内有 .openclaw（云电脑回退 home）则保留。
  ; 不删除 %USERPROFILE%\.openclaw；Electron AppData 由 deleteAppDataOnUninstall 勾选框处理。
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; function Clear-NexoraCache([string]$$root) { if (-not (Test-Path -LiteralPath $$root)) { return 0 }; $$keep = @(\".openclaw\"); Get-ChildItem -LiteralPath $$root -Force | ForEach-Object { if ($$keep -contains $$.Name) { return }; if ($$.PSIsContainer) { cmd /c rmdir /s /q $$.FullName } else { Remove-Item -LiteralPath $$.FullName -Force } }; $$left = @(Get-ChildItem -LiteralPath $$root -Force -ErrorAction SilentlyContinue); if ($$left.Count -eq 0) { Remove-Item -LiteralPath $$root -Force -Recurse } }; Clear-NexoraCache \"$LOCALAPPDATA\NexoraAgent\"; Clear-NexoraCache \"$APPDATA\NexoraAgent\"; exit 0"'
  Pop $0
  DetailPrint "[uninstall] clear NexoraAgent caches (preserve .openclaw) exitCode=$0"

  ; 此后勿再用 NexoraAgent_Log：该宏会重新 CreateDirectory %LOCALAPPDATA%\NexoraAgent
!macroend
