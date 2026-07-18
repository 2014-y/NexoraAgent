; Nexora Agent NSIS 安装定制
; 全面覆盖安装：不解、不先删旧 runtime（删几万文件极慢）
; tar 直接解压到目标目录覆盖同名文件即可

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro NexoraAgent_ForceKill
  SetDetailsPrint both
  DetailPrint "正在结束旧版 Nexora Agent…"
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Stop-Process -Name \"Nexora Agent\" -Force -ErrorAction SilentlyContinue; Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try { $$.Path -like \"*Nexora Agent*\" } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"'
  Pop $0
  Sleep 200
!macroend

!macro customInit
!macroend

!macro customCheckAppRunning
  !insertmacro NexoraAgent_ForceKill
!macroend

!macro customInstall
  SetDetailsPrint both
  !insertmacro NexoraAgent_ForceKill

  DetailPrint "正在安装程序文件…"
  DetailPrint "正在覆盖安装 OpenClaw 运行时（不删旧文件，更快）…"

  CreateDirectory "$LOCALAPPDATA\NexoraAgent"
  CreateDirectory "$LOCALAPPDATA\NexoraAgent\gateway-runtime"

  ; 直接解压到目标目录：同名覆盖，跳过整树删除
  nsExec::Exec '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\gateway-runtime.tar" -C "$LOCALAPPDATA\NexoraAgent\gateway-runtime"'
  Pop $0

  ${If} $0 != 0
    DetailPrint "正在使用备用方式覆盖安装运行时…"
    nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "try { tar -xf \"$INSTDIR\resources\gateway-runtime.tar\" -C \"$LOCALAPPDATA\NexoraAgent\gateway-runtime\"; exit 0 } catch { exit 1 }"'
    Pop $0
  ${EndIf}

  ${If} $0 == 0
    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-version" w
    FileWrite $1 "${VERSION}"
    FileClose $1
    ; 与 gateway-runtime.js writeRuntimeStamp 对齐，避免首次启动再整包重解压
    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-stamp" w
    FileWrite $1 "${VERSION}:pack-81cef099f19b"
    FileClose $1
    DetailPrint "运行时覆盖安装完成"
  ${Else}
    DetailPrint "运行时将在首次启动时自动完成（可继续）"
  ${EndIf}

  DetailPrint "安装即将完成…"
!macroend

!macro customUnInstall
  SetDetailsPrint both
  DetailPrint "正在结束相关进程…"
  !insertmacro NexoraAgent_ForceKill
  DetailPrint "正在卸载程序文件…"
!macroend
