; Quillwarren's installer, for building on Linux without wine (nsis.script in
; scripts/build.sh). electron-builder's own NSIS template makes its
; uninstaller by running a generated program at build time, which needs wine
; on Linux; this script writes the uninstaller at install time instead
; (NSIS's WriteUninstaller), so makensis alone builds it. It uses
; electron-builder's defines (PRODUCT_NAME, VERSION, APP_64 = the app as a
; 7z archive, APP_ID, APP_GUID, MUI_ICON…), its plugins (Nsis7z, nsProcess,
; WinShell) and its language strings (addLangs).
;
; - per user, no admin rights: %LOCALAPPDATA%\Programs\Quillwarren by default, any folder on request
; - Start menu and desktop shortcuts, with Quillwarren's icon
; - listed in Windows' installed apps, with an uninstaller
; - uninstalling keeps the maps (%APPDATA%\Quillwarren) and models (%LOCALAPPDATA%\Quillwarren) unless the user says to delete them
;
; For the public release, build on Windows with electron-builder's template
; (build/installer.nsh adds the same question) so the installer, the
; uninstaller and Quillwarren.exe can be signed. See docs/DESKTOP.md, "Building".

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsProcess.nsh"

!define EXE "${PRODUCT_FILENAME}.exe"
!define UNINSTALLER "Uninstall ${PRODUCT_FILENAME}.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!define INSTALL_KEY "Software\${APP_GUID}"

Name "${PRODUCT_NAME}"
BrandingText "${PRODUCT_NAME} ${VERSION}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_FILENAME}"
InstallDirRegKey HKCU "${INSTALL_KEY}" InstallLocation
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT_NAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Quillwarren is a dungeon map editor. It installs for you only, needs no administrator rights, and keeps your maps in your own folder ($APPDATA\Quillwarren).$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE dirLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start Quillwarren now"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro addLangs

; A folder of its own: a chosen folder that already holds other things gets a Quillwarren folder inside it,
; so uninstalling never removes anything but Quillwarren.
Function dirLeave
  ${If} ${FileExists} "$INSTDIR\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\${EXE}"
    StrCpy $INSTDIR "$INSTDIR\${PRODUCT_FILENAME}"
  ${EndIf}
FunctionEnd

!macro closeDelveFirst UN
  Function ${UN}closeDelve
    retry:
      ${nsProcess::FindProcess} "${EXE}" $R0
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Quillwarren is running. Close it, then click Retry." /SD IDCANCEL IDRETRY retry
        Abort
      ${EndIf}
      ${nsProcess::Unload}
  FunctionEnd
!macroend
!insertmacro closeDelveFirst ""
!insertmacro closeDelveFirst "un."

Section "Quillwarren" SEC_APP
  SectionIn RO
  SetShellVarContext current
  Call closeDelve
  ; an older Quillwarren in this folder: replace it entirely (the maps live elsewhere)
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    RMDir /r "$INSTDIR"
  ${EndIf}
  SetOutPath "$INSTDIR"
  InitPluginsDir
  SetCompress off
  File "/oname=$PLUGINSDIR\app-64.7z" "${APP_64}"
  SetCompress auto
  DetailPrint "Unpacking Quillwarren…"
  Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
  Delete "$PLUGINSDIR\app-64.7z"
  ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
    MessageBox MB_OK|MB_ICONSTOP "Quillwarren could not be unpacked into $INSTDIR." /SD IDOK
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; Quillwarren.exe keeps Electron's icon in builds made without rcedit: the shortcuts point at Quillwarren's own
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "${APP_ID}"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_NAME}.lnk" "${APP_ID}"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  WriteRegStr HKCU "${INSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" DisplayName "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" DisplayVersion "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" DisplayIcon "$INSTDIR\resources\icon.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" UninstallString '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" NoModify 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" NoRepair 1
  !ifdef APP_64_UNPACKED_SIZE
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" EstimatedSize ${APP_64_UNPACKED_SIZE}
  !endif
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.closeDelve
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ; only a folder that really is Quillwarren's
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    RMDir /r "$INSTDIR"
  ${Else}
    Delete "$INSTDIR\${UNINSTALLER}"
    RMDir "$INSTDIR"
  ${EndIf}
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${INSTALL_KEY}"
  ; the maps stay unless the user says otherwise (a silent uninstall never deletes them)
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your maps, pictures and settings?$\r$\n$\r$\nThey are in $APPDATA\Quillwarren (and model files in $LOCALAPPDATA\Quillwarren). Choose No to keep them for a later install." /SD IDNO IDNO keep
    RMDir /r "$APPDATA\Quillwarren"
    RMDir /r "$LOCALAPPDATA\Quillwarren"
  keep:
SectionEnd
