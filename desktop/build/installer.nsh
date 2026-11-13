; Blog Automation Studio installer (electron-builder includes this file in its NSIS script).
; Owner request (2026-11-12): the installer asks where to install. A first install suggests
; "...\AppData\Local\Programs\Blog Automation Studio"; an app that is already installed stays where it is
; (its folder is in the registry, and the app's own updates install there).
!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Blog Automation Studio"
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------------------------
; App updates with a window (owner request 2026-11-13: “restart to update per click krne ke baad kuch asa show ho
; installer ya updating jasa koi popup”). “Restart to update” runs this installer with --updated --force-run, no longer
; silently (desktop/updates.cjs): its window shows the progress and it asks nothing. The install mode stays as it is,
; the folder page is left out by electron-builder already, the last page is left out here, and the new version opens
; by itself. A first install (the downloaded .exe, no --updated) shows every page as before.

; An update keeps the install mode the app has (electron-builder reads it from the registry when the installer starts),
; so the “who is this for” page is not shown.
!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

; The progress page of an update says so.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW basUpdateHeader
  Function basUpdateHeader
    ${If} ${isUpdated}
      !insertmacro MUI_HEADER_TEXT "Updating Blog Automation Studio" "Installing the new version. The app opens again by itself; your data folder is not changed."
    ${EndIf}
  FunctionEnd
!macroend

; The last page (“Run Blog Automation Studio”, Finish) as electron-builder makes it, left out of an update.
!macro customFinishPage
  Function StartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend

; Once the files are in place: an update with a window opens the new version itself (a silent one already does, with
; electron-builder's --force-run). The installer's window goes first, so the app opens in front.
!macro customInstall
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
  ${AndIfNot} ${Silent}
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${EndIf}
!macroend
