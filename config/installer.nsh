!macro SetDetailsPrint_override PARAM
  !if "${PARAM}" == "none"
    SetDetailsPrint both
  !else
    SetDetailsPrint "${PARAM}"
  !endif
!macroend
!define SetDetailsPrint "!insertmacro SetDetailsPrint_override"

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend
