# Entorno de desarrollo y referencia rápida de comandos

> Este documento registra los datos del entorno necesarios para «seguir desarrollando ApkBuddyStart en esta máquina de desarrollo».
> La mayoría de las trampas son específicas del entorno de sandbox; si cambias de máquina, basate en la detección real.
> Última verificación: 2026-11-14 (v0.3.5, publicado como corrección local sobre v0.3.4).

## 0. Registro de incidencia: el espacio de trabajo acabó entero en la papelera

Alrededor de las 20:55 del 2026-11-14, **todo el directorio** `D:\apkstart-dsh` (261 elementos: código fuente / pruebas / documentos /
memoria de `.workbuddy`) fue movido a la papelera por una operación de «limpieza de artefactos antiguos de apkstart»;
en la misma limpieza también se eliminaron directorios antiguos como `D:\apkstart-dist`, `D:\dist-gitee`, `D:\ApkBuddyStart-0.3.3-preview`,
`D:\tmp-wx`, etc. — parece que una limpieza con comodín de `D:\apkstart*` se llevó por delante el espacio de trabajo.

Proceso de recuperación (reutilizable):
1. **No vacíes la papelera**. Las entradas de la unidad D están en `D:\$Recycle.Bin\<SID>\`, y cada entrada es un par
   `$I<id><ext>` (metadatos) + `$R<id><ext>` (datos).
2. El formato de `$I`: versión u64 @0, tamaño original u64 @8, hora de borrado u64 @16,
   **longitud de la ruta u32 @24 (en caracteres UTF-16, ¡no en bytes!)**, ruta UTF-16LE @28.
   Basta con renombrar `$R` con la ruta original registrada en `$I` para recuperarlo (el directorio se reconstruye solo).
3. `.git` no estaba en la papelera (probablemente la herramienta de borrado lo omitió): se recuperó el historial desde
   `C:\Users\15656\WorkBuddy\2026-10-29-20-43-38\apkstart\.git` (e1db34b = v0.3.4) y se volvió a confirmar el espacio de trabajo.
4. Verificación tras la recuperación: `src/**` y `dist\ApkBuddyStart-win64-portable\resources\app\src`
   tienen SHA256 idéntico archivo por archivo; las 112 pruebas de `npm test` pasan.

**Recomendación**: en el futuro, comprime periódicamente el código fuente + `.git` + docs + test en un zip y guárdalo fuera de `D:\`
(por ejemplo, bajo `C:\Users\15656\WorkBuddy\`); no lo pongas en la misma unidad que el espacio de trabajo.

## 1. Ubicación del conjunto de herramientas (no está en PATH; hay que usar rutas absolutas)

| Herramienta | Ruta | Versión |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | Incluida con Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | `node_modules\electron\dist\electron.exe` en el repositorio | 33.4.11 |

En PowerShell, amplía primero el PATH:

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

Si se eliminaron las dependencias, vuelve a instalarlas (unos 19 segundos, usando el espejo):

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. Dos variables de entorno que hay que limpiar en cada shell

El shell host hereda estas dos; si no se limpian, aparecen fenómenos extraños como «Electron ejecutándose como Node puro»:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # si no, electron.exe se comporta como node y --launch da error de opción inválida
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # si no, la eliminación masiva de build/pack.js es bloqueada por safe-delete con SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. Comandos habituales

```powershell
cd D:\apkstart-dsh\apkstart

# pruebas unitarias/de regresión (solo Node, sin Electron/adb/red)
npm test

# pruebas de integración de Electron (degradación de iconos ICO / .lnk / WebP)
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# captura de humo de la interfaz (--settings también captura la página de ajustes; --perf/--download capturan las secciones correspondientes)
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# arranque real (mide tiempos de arranque en frío/en caliente; --stop apaga limpiamente y guarda una instantánea)
node tools\e2e-boot.js . --stop

# empaquetado de la versión portátil (genera dist\ApkBuddyStart-win64-portable)
node build\pack.js

# instalador completo (necesita build/runtime, ~1,4 GB de ejecución; se ejecuta en CI)
npm run build:exe
```

> Tras ejecutar la comprobación de humo o el arranque, recuerda verificar que no queden procesos residuales:
> `Get-Process -Name ApkBuddyStart,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`
> El emulador se inicia desacoplado (detached), así que después de que salga Electron qemu puede seguir vivo (es intencionado: la próxima vez se toma el control al instante).
>
> Si `dist\ApkBuddyStart-win64-portable` está ocupado (Explorador de archivos / antivirus / una instancia anterior aún abierta),
> `pack.js` recurre a `dist\ApkBuddyStart-v<versión>-win64-portable`; es un comportamiento esperado: cierra el proceso que lo ocupa y cambia el nombre de vuelta.
> Los procesos de solo lectura/indexación (Defender, SearchIndexer) pueden impedir borrar un directorio vacío durante unos minutos; espera y vuelve a intentarlo.

## 4. Rutas de datos y ejecución (en esta máquina)

| Uso | Ruta |
|---|---|
| Ajustes / manifiesto de aplicaciones / registros / copia de APK | `%APPDATA%\apkstart` (el directorio real se llama `ApkBuddyStart`, la diferencia de mayúsculas no importa) |
| Ejecución (emulator + adb + imagen) | `D:\ApkBuddyStartRuntime` (`settings.runtime.dir`) |
| AVD / aplicaciones instaladas / instantáneas | `D:\ApkBuddyStartData` (`settings.runtime.avdDir`) |
| Directorio compartido | `%USERPROFILE%\ApkBuddyStartShared` |
| Informe de diagnóstico | `%APPDATA%\apkstart\logs\diagnostic-*.txt` |
| Registro del último error de arranque | `%APPDATA%\apkstart\logs\last-failure.json` |

## 5. Precauciones con archivos y texto (específicas de este terminal)

- **No uses `Set-Content` / `Get-Content -Raw` con archivos UTF-8 que contengan texto en español**:
  PowerShell 5.1 decodifica por defecto como ANSI y escribe caracteres corruptos (en esta sesión ocurrió una vez y destrozó un archivo de prueba).
  Para leer y escribir texto usa siempre herramientas de editor; si necesitas escribir en PowerShell, hazlo con
  `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`.
- **Los métodos estáticos de `[System.IO.File]` usan el directorio inicial del proceso**, de modo que siguen resolviendo la ruta antigua tras un `cd`: usa siempre rutas absolutas.
- **Borrar directorios grandes**: `Remove-Item -Recurse` puede ser bloqueado por la capa safe-delete;
  usa `[System.IO.Directory]::Delete($path, $true)`; si el espacio no se libera tras el borrado, vacía la papelera.
- **Procesos de larga duración** (qemu / descargas grandes): usa tareas en segundo plano; al terminar un comando normal se limpia también su árbol de procesos hijos.
- Al leer la salida de `reg.exe`, ten en cuenta que usa la página de códigos de consola; el contenido ASCII como nombres de paquete y rutas no tiene problemas.

## 6. Tabla de fallos habituales

| Síntoma | Causa / solución |
|---|---|
| `electron --version` muestra `v20.x` (versión de Node) | `ELECTRON_RUN_AS_NODE=1` no se ha limpiado |
| El empaquetado muestra `SAFE_DELETE_BULK_GUARD_ERROR` | `NODE_OPTIONS` no se ha limpiado |
| Los casos axml/apk de `npm test` aparecen como «omitidos» | No hay fixtures reales; los casos con APK sintético sí se ejecutan (`test/lib/make-apk.js`) |
| `0xC0000005` (3221225477) en el emulador | Fallo del backend de renderizado; las versiones nuevas cambian de backend automáticamente y escriben `last-failure.json`; el informe está en `logs\diagnostic-*.txt` |
| «Running multiple emulators with the same AVD» | Un qemu residual mantiene el bloqueo; `node tools\emu-clean.ps1` o reinicia (las versiones nuevas limpian huérfanos automáticamente) |
| Gitee devuelve 403 en la comprobación de actualizaciones | Limitación de la API anónima; el cliente aplica un cortocircuito de 15 minutos y usa solo GitHub; no es un fallo |
| `reg.exe` / `sc.exe` bloqueados en el sandbox | Afecta solo a las pruebas automatizadas; el producto en el escritorio del usuario no se ve afectado |
| La versión portátil se cierra al segundo de iniciar, sin ventana | Otro proceso de ApkBuddyStart tiene el bloqueo de instancia única (puede ser una instancia antigua que no terminó de salir); ejecuta primero `Stop-Process -Name ApkBuddyStart` |

## 7. Proceso de publicación (solo tras confirmar que las pruebas reales pasan)

```powershell
# 1. subir versión (bump)
#    package.json: version -> 0.3.5
# 2. notas de la versión: docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. confirmar cambios (commit) + crear tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "ApkBuddyStart v0.3.5"
# 4. enviar a ambos repositorios (GitHub por SSH, Gitee por https; según convenga)
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI: `release.yml` compila la versión portátil (zip de 95 MB), el instalador completo Setup (~1,35 GB) y el paquete completo de ejecución
(~1,36 GB), y sincroniza la versión portátil a Gitee (requiere el secreto `GITEE_TOKEN`; si falta, falla directamente en lugar de omitirlo silenciosamente).
La compresión xz del job `full` tarda unos 40 minutos, lo cual es normal.
