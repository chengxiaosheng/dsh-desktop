; Custom NSIS running-app check for DSH Desktop.
;
; electron-builder's built-in CHECK_APP_RUNNING is replaced via the
; customCheckAppRunning macro (nsis.include default installer.nsh). The built-in
; check matches processes by PATH PREFIX against the install directory
; (PowerShell Get-CimInstance Path.StartsWith($INSTDIR)), which false-positives
; on machines where an unrelated process path starts with that directory; the
; installer then loops forever ("app is running" -> cannot kill -> retry).
;
; This macro matches the process by exact image name only (tasklist IMAGENAME +
; findstr, the electron-builder PR #9784 approach). dsh-desktop.exe is unique to
; this product, so an exact match can only ever be the real app: clean installs
; never trip it, and a genuinely running instance is still offered to be closed.

!ifndef CUSTOM_CHECK_APP_RUNNING_NSH
!define CUSTOM_CHECK_APP_RUNNING_NSH

!include "LogicLib.nsh"

!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $0
  ${if} $0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
    Quit
    doStopProcess:
    DetailPrint "$(appClosing)"
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /F /FI "PID ne $pid"`
    Pop $0
    Sleep 500
  ${endIf}
!macroend

!endif
