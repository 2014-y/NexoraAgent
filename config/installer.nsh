; Nexora Agent NSIS 安装定制
; 全面覆盖安装：不解、不先删旧 runtime（删几万文件极慢）
; tar 直接解压到目标目录覆盖同名文件即可

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

  !insertmacro NexoraAgent_Log "[install] begin custom install stage"
  !insertmacro NexoraAgent_Log "[install] INSTDIR=$INSTDIR"
  !insertmacro NexoraAgent_Log "[install] LOCALAPPDATA=$LOCALAPPDATA"
  !insertmacro NexoraAgent_Log "[install] resources=$INSTDIR\resources"
  !insertmacro NexoraAgent_Log "[install] installing application files"
  !insertmacro NexoraAgent_Log "[runtime] overlay extract OpenClaw runtime without deleting old files"

  CreateDirectory "$LOCALAPPDATA\NexoraAgent"
  CreateDirectory "$LOCALAPPDATA\NexoraAgent\gateway-runtime"

  ; 直接解压到目标目录：同名覆盖，跳过整树删除

  !insertmacro NexoraAgent_Log "[runtime] primary tar=$SYSDIR\tar.exe"
  !insertmacro NexoraAgent_Log "[runtime] archive=$INSTDIR\resources\gateway-runtime.tar"
  !insertmacro NexoraAgent_Log "[runtime] target=$LOCALAPPDATA\NexoraAgent\gateway-runtime"
  nsExec::Exec '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\gateway-runtime.tar" -C "$LOCALAPPDATA\NexoraAgent\gateway-runtime"'
  Pop $0
  !insertmacro NexoraAgent_Log "[runtime] primary tar exitCode=$0"

  ${If} $0 != 0
    !insertmacro NexoraAgent_Log "[runtime] primary tar failed, trying PowerShell tar fallback"
    nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "try { tar -xf \"$INSTDIR\resources\gateway-runtime.tar\" -C \"$LOCALAPPDATA\NexoraAgent\gateway-runtime\"; exit 0 } catch { exit 1 }"'
    Pop $0
    !insertmacro NexoraAgent_Log "[runtime] fallback tar exitCode=$0"
  ${EndIf}

  ${If} $0 == 0
    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-version" w
    FileWrite $1 "${VERSION}"
    FileClose $1
    ; 与 gateway-runtime.js writeRuntimeStamp 对齐，避免首次启动再整包重解压

    FileOpen $1 "$LOCALAPPDATA\NexoraAgent\gateway-runtime\.runtime-stamp" w
    FileWrite $1 "${VERSION}:pack-01f112cb6f12"
    FileClose $1
    !insertmacro NexoraAgent_Log "[runtime] overlay install completed"
  ${Else}
    !insertmacro NexoraAgent_Log "[runtime] extract failed or skipped; first app launch will complete runtime preparation"
  ${EndIf}

  !insertmacro NexoraAgent_Log "[install] custom install stage finished"
!macroend

!macro customUnInstall
  SetDetailsPrint both
  !insertmacro NexoraAgent_Log "[uninstall] stopping related processes"
  !insertmacro NexoraAgent_ForceKill
  !insertmacro NexoraAgent_Log "[uninstall] removing application files"
!macroend
