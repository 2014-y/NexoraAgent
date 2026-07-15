; ClawAI NSIS 安装定制
; 全面覆盖安装：不解、不先删旧 runtime（删几万文件极慢）
; tar 直接解压到目标目录覆盖同名文件即可

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro ClawAI_ForceKill
  SetDetailsPrint both
  DetailPrint "正在结束旧版 ClawAI…"
  nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Stop-Process -Name ClawAI -Force -ErrorAction SilentlyContinue; Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try { $$.Path -like \"*ClawAI*\" } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"'
  Pop $0
  Sleep 200
!macroend

!macro customInit
!macroend

!macro customCheckAppRunning
  !insertmacro ClawAI_ForceKill
!macroend

!macro customInstall
  SetDetailsPrint both
  !insertmacro ClawAI_ForceKill

  DetailPrint "正在安装程序文件…"
  DetailPrint "正在覆盖安装 OpenClaw 运行时（不删旧文件，更快）…"

  CreateDirectory "$LOCALAPPDATA\ClawAI"
  CreateDirectory "$LOCALAPPDATA\ClawAI\gateway-runtime"

  ; 直接解压到目标目录：同名覆盖，跳过整树删除
  nsExec::Exec '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\gateway-runtime.zip" -C "$LOCALAPPDATA\ClawAI\gateway-runtime"'
  Pop $0

  ${If} $0 != 0
    DetailPrint "正在使用备用方式覆盖安装运行时…"
    nsExec::Exec 'powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath \"$INSTDIR\resources\gateway-runtime.zip\" -DestinationPath \"$LOCALAPPDATA\ClawAI\gateway-runtime\" -Force; exit 0 } catch { exit 1 }"'
    Pop $0
  ${EndIf}

  ${If} $0 == 0
    FileOpen $1 "$LOCALAPPDATA\ClawAI\gateway-runtime\.runtime-version" w
    FileWrite $1 "${VERSION}"
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
  !insertmacro ClawAI_ForceKill
  DetailPrint "正在卸载程序文件…"
!macroend
