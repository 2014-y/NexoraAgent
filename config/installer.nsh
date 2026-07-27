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
  ; 主进程直接 taskkill（/T 连带子进程），不依赖 PowerShell 解析
  nsExec::Exec 'taskkill /F /T /IM "Nexora Agent.exe"'
  Pop $0
  ; runtime 里的 node.exe 按路径过滤后杀（同时匹配安装目录 Nexora Agent 与缓存目录 NexoraAgent）
  ; 注意：NSIS 中 $$_ 才展开为 PowerShell 管道变量 $_，写成 $$. 会展开成 $. 造成整段解析失败
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try { $$p = [string]$$_.Path; $$p -like \"*Nexora Agent*\" -or $$p -like \"*NexoraAgent*\" } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"'
  Pop $0
  ; 轮询等进程真正退出（最多 5 秒），避免解压时文件仍被占用
  StrCpy $1 0
  ${Do}
    nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Nexora Agent.exe" | find /I "Nexora Agent.exe" >nul'
    Pop $0
    ${IfThen} $0 != 0 ${|} ${ExitDo} ${|}
    Sleep 500
    IntOp $1 $1 + 1
  ${LoopUntil} $1 >= 10
  !insertmacro NexoraAgent_Log "[process] force kill finished (waited $1 rounds)"
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
    FileWrite $1 "${VERSION}:pack-e2032d2cc619"
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
  ; 注意：NSIS 中 $$_ 才展开为 PowerShell 管道变量 $_，写成 $$. 会展开成 $. 造成整段解析失败、缓存全残留
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; function Clear-NexoraCache([string]$$root) { if (-not (Test-Path -LiteralPath $$root)) { return 0 }; $$keep = @(\".openclaw\"); Get-ChildItem -LiteralPath $$root -Force | ForEach-Object { if ($$keep -contains $$_.Name) { return }; if ($$_.PSIsContainer) { cmd /c rmdir /s /q $$_.FullName } else { Remove-Item -LiteralPath $$_.FullName -Force } }; $$left = @(Get-ChildItem -LiteralPath $$root -Force -ErrorAction SilentlyContinue); if ($$left.Count -eq 0) { Remove-Item -LiteralPath $$root -Force -Recurse } }; Clear-NexoraCache \"$LOCALAPPDATA\NexoraAgent\"; Clear-NexoraCache \"$APPDATA\NexoraAgent\"; exit 0"'
  Pop $0
  DetailPrint "[uninstall] clear NexoraAgent caches (preserve .openclaw) exitCode=$0"

  ; 询问是否连用户数据一起删（微信登录、聊天记忆、openclaw.json）。静默卸载不弹窗、默认保留。
  IfSilent nexora_skip_userdata_purge
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除用户数据？$\n$\n包括：$PROFILE\.openclaw（微信登录、聊天记录、模型配置）$\n$\n选择「否」将保留这些数据，重新安装后可继续使用。" IDNO nexora_skip_userdata_purge
  RMDir /r "$PROFILE\.openclaw"
  RMDir /r "$LOCALAPPDATA\NexoraAgent"
  RMDir /r "$APPDATA\NexoraAgent"
  DetailPrint "[uninstall] user data purged (.openclaw + NexoraAgent dirs)"
nexora_skip_userdata_purge:

  ; 此后勿再用 NexoraAgent_Log：该宏会重新 CreateDirectory %LOCALAPPDATA%\NexoraAgent
!macroend
