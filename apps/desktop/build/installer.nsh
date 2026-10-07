; Delve's additions to electron-builder's NSIS installer (nsis.include).
; Used when the installer is built with electron-builder's own template (on
; Windows, or on Linux with wine). The wine-free build on Linux uses
; installer-nowine.nsi instead, which does the same itself.

; Uninstalling keeps the maps unless the user says otherwise. Updates (which
; run the old uninstaller silently) never ask and never delete anything.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your maps, pictures and settings?$\r$\n$\r$\nThey are in $APPDATA\Delve (and model files in $LOCALAPPDATA\Delve). Choose No to keep them for a later install." /SD IDNO IDNO delve_keep_data
        SetShellVarContext current
        RMDir /r "$APPDATA\Delve"
        RMDir /r "$LOCALAPPDATA\Delve"
      delve_keep_data:
    ${endIf}
  ${endIf}
!macroend
