; Blog Automation Studio installer (electron-builder includes this file in its NSIS script).
; Owner request (2026-11-12): the installer asks where to install. A first install suggests
; "...\AppData\Local\Programs\Blog Automation Studio"; an app that is already installed stays where it is
; (its folder is in the registry, and the app's own updates install there silently).
!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Blog Automation Studio"
  ${EndIf}
!macroend
