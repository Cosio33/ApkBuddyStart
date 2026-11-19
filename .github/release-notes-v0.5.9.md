# ApkBuddyStart v0.5.9

Versión de corrección y finalización en español. Mantiene el mismo motor de APKStart y corrige un fallo que impedía arrancar el emulador en equipos con el runtime incluido.

---

## 1. Corrección funcional: el emulador volvía a arrancar después de una instalación

**Síntoma:** después de instalar, la app abría pero el emulador nunca terminaba de arrancar (`No initial system image for this configuration!`), y por eso fallaba la instalación de cualquier APK.

**Causa:** `autoDeploy()` trataba el runtime incluido en el paquete como un éxito pero no lo marcaba como tal. El bloque `finally` grababa entonces una marca de error (`deployFailedAt`) falsa en cada arranque. Con esa marca, los arranques siguientes entraban en un enfriamiento de 30 minutos y ni siquiera intentaban expandir la imagen del sistema.

**Solución:**
- `autoDeploy()` marca el runtime incluido como éxito y limpia la marca de error anterior cuando la imagen sigue comprimida.
- `materializeImages()` limpia cualquier marca heredada de arranques fallidos en cuanto la expansión termina bien.

Resultado: la imagen `system.img.xz` se expande en el primer arranque y los reintentos automáticos ya no quedan bloqueados.

## 2. Proyecto 100 % en español

Se completó la traducción de todos los archivos que aún tenían texto en chino: documentación, notas de release, flujos de GitHub Actions, scripts de compilación, código fuente y pruebas.

Se conservan únicamente cuatro patrones funcionales con caracteres chinos que forman parte de la detección del sistema (expresiones regulares que emparejan mensajes de error del emulador y de Android, y un fixture de pruebas). Traducirlos rompería la detección.

La identidad visual y los flujos de publicación ya usan `ApkBuddyStart` de forma consistente. Se mantienen los identificadores internos de compatibilidad (`%APPDATA%/apkstart`, `APKSTART_*`, el crédito `RoutineMiku/apkstart`).

## 3. Verificación

- Suite completa de pruebas: **120/120 + todas las suites en 0 fallidas**.
- Sintaxis JavaScript y YAML validada en todos los archivos modificados.
- Escaneo de texto chino limpio salvo los cuatro patrones funcionales indicados.

## Descarga

- **Portable (ligera):** `ApkBuddyStart-v0.5.9-win64-portable.zip` — descarga el runtime la primera vez.
- **Completa (sin conexión):** `ApkBuddyStart-0.5.9-Setup.exe` — incluye el runtime y funciona sin descargar nada.
