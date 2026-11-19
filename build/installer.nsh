; Script NSIS personalizado de ApkBuddyStart
; Función: antes de iniciar la desinstalación, terminar los procesos del runtime que puedan seguir en segundo plano,
; de lo contrario bloquearían archivos del directorio de instalación, dejando una desinstalación incompleta que ni las herramientas de borrado de terceros pueden eliminar.
;
; Tras salir, ApkBuddyStart puede dejar qemu ejecutándose de forma independiente (para acelerar el próximo inicio),
; por eso la desinstalación debe encargarse de limpiarlo.

; Toque final de la instalación: un añadido más para el icono del escritorio.
; el createDesktopShortcut de electron-builder usa su propio flujo CreateShortcuts,
; y en algunos entornos (escritorio redirigido por OneDrive o accesos directos revertidos por software de seguridad) falla,
; y el usuario ve que no aparece nada en el escritorio. Aquí se usa el CreateShortcut nativo de NSIS para escribirlo de nuevo:
; $DESKTOP usa SHGetFolderPath, que sigue correctamente la ruta redirigida del escritorio; se escribe como operación idempotente,
; y si electron-builder lo ejecuta de nuevo, simplemente sobrescribe el mismo .lnk.
!macro customInstall
  DetailPrint "Creando acceso directo en el escritorio…"
  CreateShortcut "$DESKTOP\ApkBuddyStart.lnk" "$INSTDIR\ApkBuddyStart.exe" "" "$INSTDIR\ApkBuddyStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkBuddyStart — Ejecuta aplicaciones de Android directamente en tu equipo"
  CreateDirectory "$SMPROGRAMS\ApkBuddyStart"
  CreateShortcut "$SMPROGRAMS\ApkBuddyStart\ApkBuddyStart.lnk" "$INSTDIR\ApkBuddyStart.exe" "" "$INSTDIR\ApkBuddyStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkBuddyStart — Ejecuta aplicaciones de Android directamente en tu equipo"
!macroend

!macro customUnInstall
  ; Primero eliminar los accesos directos creados aquí (no debe quedar nada aunque ApkBuddyStart no esté instalado)
  Delete "$DESKTOP\ApkBuddyStart.lnk"
  Delete "$SMPROGRAMS\ApkBuddyStart\ApkBuddyStart.lnk"
  RMDir "$SMPROGRAMS\ApkBuddyStart"

  DetailPrint "Terminando los procesos residuales de ApkBuddyStart…"
  ; /F fuerza la terminación y /T incluye los procesos hijos. Si el proceso no existe, taskkill devuelve 128; se puede ignorar.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkBuddyStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Dar un poco de tiempo para que los procesos terminen y liberen los archivos
  Sleep 1500
!macroend
