; PearCircle Seeder - Windows installer
;
; Compiled by scripts/windows-remote-build.ps1 on the build VM. Expects:
;   - the install payload pre-staged in  payload\  beside this script
;   - the version passed as  makensis /DVERSION=<x.y.z>
;
; Lays the payload flat under the install directory, registers the host
; as a Windows service through the bundled nssm.exe (LocalSystem,
; auto-start, restart-on-failure), and adds a Start Menu shortcut to the
; localhost dashboard.

Unicode true
ManifestDPIAware true

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

!define APP_NAME   "PearCircle Seeder"
!define SVC_NAME   "PearCircleSeeder"
!define PUBLISHER  "PeerLoom LLC"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SVC_NAME}"

Name "${APP_NAME}"
OutFile "PearCircleSeeder-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
; One-click auto-update runs this installer silently (`/S`): the host's Windows
; applier (updateApply.js) launches it detached, and `/S` suppresses every UI
; page including the finish-page browser launch, so an unattended update is
; silent. Read the prior install location so a silent upgrade lands exactly
; where the first install did rather than the default. Proposal slice 3c.
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"

!define MUI_ICON   "payload\AppIcon.ico"
!define MUI_UNICON "payload\AppIcon.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

Function LaunchDashboard
  ; Finish-page action. A custom function is used rather than
  ; MUI_FINISHPAGE_RUN_PARAMETERS because the latter emits an Exec with
  ; the program and parameters as separate tokens, which Exec rejects.
  Exec 'wscript.exe "$INSTDIR\open-ui.vbs"'
FunctionEnd

!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "Open the PearCircle Seeder dashboard"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchDashboard"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------

!macro StopSeederService
  ; Best-effort stop + remove. nssm.exe may be absent on a first install;
  ; the sc.exe calls then dismantle anything a prior version left behind.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SVC_NAME}'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SVC_NAME} confirm'
  nsExec::ExecToLog 'sc.exe stop ${SVC_NAME}'
  nsExec::ExecToLog 'sc.exe delete ${SVC_NAME}'
  Sleep 2000
!macroend

Section "PearCircle Seeder" SecMain
  SetRegView 64

  ; Upgrade path: stop and drop any existing service so its executables
  ; are not locked while we overwrite them.
  DetailPrint "Stopping any existing ${APP_NAME} service..."
  !insertmacro StopSeederService

  ; Lay the payload down flat under the install directory.
  SetOutPath "$INSTDIR"
  File /r "payload\*"

  ; Register the host as an auto-start Windows service via NSSM. The host
  ; runs under LocalSystem; its data dir (identity, enrollments, logs)
  ; resolves to %ProgramData%\PearCircle Seeder (see host/dataDir.js).
  DetailPrint "Registering the ${APP_NAME} service..."
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" install ${SVC_NAME} "$INSTDIR\node.exe"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppParameters "\"$INSTDIR\host-bundled.js\" --no-open"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppDirectory "$INSTDIR"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} DisplayName "${APP_NAME}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} Description "Runs the PearCircle blind-seeder worklet and its localhost dashboard."'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} Start SERVICE_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} ObjectName LocalSystem'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppStdout "$INSTDIR\service.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppStderr "$INSTDIR\service.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppRotateBytes 1048576'
  nsExec::ExecToLog 'sc.exe failure ${SVC_NAME} reset= 86400 actions= restart/60000/restart/60000/restart/60000'

  ; Start Menu shortcut to the dashboard launcher.
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "wscript.exe" '"$INSTDIR\open-ui.vbs"' "$INSTDIR\AppIcon.ico"

  ; Add/Remove Programs entry.
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\AppIcon.ico"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Start the service now so the dashboard is reachable immediately.
  DetailPrint "Starting the ${APP_NAME} service..."
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" start ${SVC_NAME}'
SectionEnd

Section "Uninstall"
  SetRegView 64

  ; Stop + remove the service before deleting files so nothing is locked.
  !insertmacro StopSeederService

  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  DeleteRegKey HKLM "${UNINST_KEY}"

  ; Remove the installed program files. The data directory at
  ; %ProgramData%\PearCircle Seeder is left intact so a reinstall keeps
  ; the seeder identity and circle enrollments; see installer README.
  RMDir /r "$INSTDIR"
SectionEnd
