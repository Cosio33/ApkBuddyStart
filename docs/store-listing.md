# Materiales de envío a Microsoft Store (ApkBuddyStart 0.5.8)

> Este archivo está preparado para copiar directamente en los formularios de Partner Center. El paquete, los iconos y el manifiesto los generan los scripts;
> solo «crear la cuenta → reservar el nombre → subir → enviar a certificación» debe hacerse manualmente en la web.

---

## 1. Información básica

| Campo | Valor |
|---|---|
| Product name | `ApkBuddyStart` |
| Category | Developer tools → Utilities & tools (alternativa: Productivity) |
| Price | Free |
| Package | `dist/store/ApkBuddyStart_0.5.8.0_x64.msix` (x64, unos 850 MB) |
| Idiomas admitidos | Español / English (United States) |
| Sitio web | https://github.com/RoutineMiku/apkstart |
| Correo de soporte | <!-- escribe tu correo --> |
| Política de privacidad | https://github.com/RoutineMiku/apkstart/blob/main/docs/privacy.md (o una página propia) |

### Novedades de esta versión (Partner Center → **What's new in this version**, pegar directamente)

**Español**
```
0.5.8:
· Nueva «comprobación local · configuración automática»: comprueba automáticamente si la virtualización de CPU está activada, si la plataforma de hipervisor de Windows está habilitada, la GPU y la VRAM, la memoria y la versión del sistema.
· Lo que se puede cambiar automáticamente se aplica: recomienda memoria, número de núcleos de CPU, calidad y backend de renderizado según el hardware local, y fija la configuración de esta máquina en un controlador.
· Las operaciones que requieren permisos de administrador (activar funciones de Windows, instalar el controlador de aceleración) ofrecen un botón de un clic; lo que solo se puede cambiar en la BIOS incluye pasos claros.

0.5.7 (incluido):
· Nuevos «controladores (parches de compatibilidad)»: cuando una máquina no puede iniciar, se puede importar o escribir un parche JSON que declare a qué máquinas afecta y qué parámetros de arranque cambia.
· La página de ajustes permite importar controladores, activarlos/desactivarlos, abrir el directorio de controladores y exportar la plantilla de esta máquina; los parches solo modifican parámetros de arranque de la lista blanca y no ejecutan ningún código.
· Se incluyen tres ejemplos (iGPU AMD, sin aceleración por hardware, iGPU Intel antigua), desactivados por defecto y listos para activarse cuando haga falta.

0.5.6 (incluido):
· Solo se conserva la ejecución propia de ApkBuddyStart: ya no se detecta, se toma el control ni se depende de ningún emulador instalado en el ordenador (MuMu, LDPlayer, BlueStacks y WSA ya no se usan).
· Se han eliminado de los ajustes el «modo de motor» y todas las opciones de emuladores de terceros, de modo que importar una configuración antigua ya no puede cambiar al emulador de otro.
· La memoria, los núcleos de CPU y la partición de datos siguen siendo asignables por el usuario, con límites calculados según tu equipo.

0.5.5 (incluido):
· Se corrige el problema de pantalla completamente negra en algunos equipos: se detecta la capacidad de la GPU y se cambia el nivel de renderizado, con un reintento automático si la imagen sale mal.
· Se admite la instalación de juegos Android grandes del orden de los 50 GB: el espacio en disco se comprueba antes de instalar, en lugar de fallar a mitad de camino.
· La memoria, los núcleos de CPU y el tamaño de la partición de datos ahora los puede asignar el usuario, con límites que siguen la configuración de tu equipo.
· Ampliar la partición de datos ya no «informa de éxito pero no hace nada»: cuando hace falta reconstruirla, se indica claramente y se pide confirmación.
· El paquete se ejecuta de forma autónoma con su propia ejecución integrada; no hace falta instalar previamente ningún emulador.

0.5.4 (incluido):
· Se corrige que, en pantallas con escalado distinto del 100 % (125 % / 150 %), las ventanas independientes solo se vieran parcialmente, quedaran desplazadas hacia una esquina y los clics fueran incorrectos.
· Se corrige que el arranque en frío se quedara bloqueado en el diálogo «Permitir depuración USB» y que se informara erróneamente de problemas de GPU/virtualización, provocando un tiempo de espera agotado.
· Se corrige que las apps que PackageManager daba por «instaladas» pero cuyos archivos faltaban no se pudieran abrir.
· Se corrige el bucle en que la versión portátil se actualizaba pero no reiniciaba y volvía a descargar una y otra vez; la desinstalación con un clic ahora reconoce correctamente las versiones instaladas.
· Se refuerzan la validación del nombre de paquete APK y de la extracción de archivos comprimidos para rechazar rutas maliciosas y ataques de inyección de comandos.

0.5.3 (incluido):
· Los accesos directos de las apps Android en el escritorio y el menú Inicio vuelven a usar **el icono propio de cada app**, en lugar del icono de marca de ApkBuddyStart.
· Al fijar una app a la barra de tareas, el botón y el elemento fijado usan el mismo icono de aplicación (cada app tiene su propia identidad).
· El exe del propio ejecutor lleva ahora el icono de la marca y la información de versión; el Explorador de archivos ya no muestra el icono predeterminado de Electron ni el número de versión 33.x.

0.5.2 (incluido):
· Si tras instalar no está activada la función «Windows Hypervisor Platform», ahora se abre directamente ese cuadro de ajustes y se indica qué casilla hay que marcar.
· Los textos informativos ya no recomiendan instalar el controlador AEHD (una app de tienda no puede instalar controladores de kernel).
· Al ejecutar en modo de emulación por software, el primer inicio de una app muestra una notificación del sistema que explica que la aceleración por hardware puede ser de 5 a 10 veces más rápida.

0.5.1 (incluido):
· Al cambiar a una app con otra orientación de pantalla, durante los unos 40 segundos que dura el cambio se muestra una ventana «Cambiando orientación…», en lugar de un escritorio en blanco.
· En el arranque en frío ya no se informa falsamente de que «la máquina virtual no tiene red» ni se sugiere restablecer los datos de Android.
· Se corrige un fallo ocasional de «la app no se pudo iniciar» tras reiniciar por un cambio de orientación.
· Al abrir otra app mientras la anterior todavía está arrancando, el nuevo arranque se pone en cola en lugar de interrumpirla.
· Se ha eliminado el destello de la ventana negra de consola en el arranque; la ventana de la app ya no muestra brevemente el nombre de la app anterior.
```

**English**
```
0.5.8:
· New "PC check-up · auto-config": detects whether CPU virtualization is enabled, whether the Windows Hypervisor Platform is on, plus GPU/VRAM, memory and OS build.
· Everything that can be automated is applied: memory, CPU cores, render resolution and render path are tuned for this PC, and the result is saved as a driver for future launches.
· Actions that need administrator rights (enabling Windows features, installing the acceleration driver) get a one-click button; BIOS-only changes come with exact steps.

0.5.7 (included):
· New "drivers" (compatibility patches): when a PC cannot boot the runtime, import or write a JSON patch that declares which machines it matches and which launch options to change.
· Settings can import a driver, toggle it, open the drivers folder, and export a template for this PC. Patches only touch whitelisted launch options and never execute code.
· Three built-in examples (AMD iGPU, no hardware acceleration, old Intel iGPU) are shipped disabled by default.

0.5.6 (included):
· Only ApkBuddyStart's own runtime remains: emulators installed on the PC (MuMu, LDPlayer, BlueStacks, WSA) are no longer detected, taken over, or relied on.
· The engine selector and all third-party emulator options were removed from Settings, so an imported old config can no longer switch to someone else's emulator.
· Memory, CPU cores and the /data partition are still user-allocatable, with limits derived from your PC.

0.5.5 (included):
· Fixed black app screens on some PCs: graphics capability is detected and the render path is switched automatically, with a retry when the picture is blank.
· Supports installing large Android games in the 50 GB range: disk space is checked up front instead of failing halfway through.
· Memory, CPU cores and the /data partition size can now be allocated by the user, with limits derived from your PC.
· Growing the data partition no longer reports a fake success: when a rebuild is required, it is stated clearly and confirmed first.
· The package runs standalone with its own bundled runtime; no emulator needs to be installed beforehand.

0.5.4 (included):
· Fixed detached windows showing only partially, sitting off-corner, and misaligned clicks on displays scaled above 100% (125%/150%).
· Fixed cold boot stalling on the "Allow USB debugging" dialog and being misreported as a graphics/virtualization failure.
· Fixed apps that PackageManager reported as installed but whose files were missing and would not launch.
· Fixed portable updates that never restarted and re-downloaded in a loop; one-click uninstall now recognizes installed builds.
· Hardened APK package-name and archive-extraction checks against malicious paths and command injection.

0.5.3 (included):
· Desktop and Start menu shortcuts for Android apps now use each app's own icon again,
  instead of ApkBuddyStart's brand icon.
· Pinning an app to the taskbar keeps the same app icon on both the pinned shortcut and
  the running window (each app has its own app identity).
· The runner's own exe now carries the product icon and version info, so Explorer no
  longer shows Electron's default icon and 33.x version number.

0.5.2 (included):
· If the optional Windows feature "Windows Hypervisor Platform" is off, the app opens the
  Windows Features dialog and tells you which item to tick.
· The hint no longer suggests installing the AEHD kernel driver (a Store app cannot).
· In software emulation, the first app launch shows a notification explaining that hardware
  acceleration makes it 5-10x faster.

0.5.1 (included):
· A "switching orientation…" window is shown during the ~40s panel change instead of a blank desktop.
· The startup log no longer falsely reports "no network" and suggests resetting Android data.
· Fixed an occasional "app failed to start" after an orientation restart.
· Launching another app while one is still starting now queues instead of interrupting it.
· No more console-window flash during boot; the window no longer shows the previous app's name.
```

---

## 2. Descripción corta (≤100 caracteres)

**Español**
```
Ejecuta apps de Android en Windows con doble clic en un APK: ventanas independientes, iconos en el escritorio y ejecución integrada, listo nada más instalar.
```

**English**
```
Run Android apps on Windows by double-clicking an APK. Each app gets its own window.
```

---

## 3. Descripción detallada (≤10.000 caracteres)

**Español**

```
ApkBuddyStart convierte las aplicaciones Android en software corriente de Windows, que se puede instalar y abrir.

No hace falta abrir primero un emulador, configurar ADB ni buscar una imagen. Tras instalar ApkBuddyStart, haz doble clic en un archivo .apk en el Explorador de archivos: se analiza, se instala automáticamente y coloca un acceso directo con el icono real de la app tanto en el escritorio como en el menú Inicio. A partir de entonces, hacer doble clic en ese icono inicia directamente la aplicación Android.

■ La aplicación es una ventana
Cada aplicación Android se ejecuta en su propia ventana: las apps en vertical mantienen la proporción del teléfono y llenan toda la altura de la pantalla; las de horizontal llenan una proporción 16:9. El modo ventana se puede mover y redimensionar libremente, y cada app recuerda su propio tamaño. Pulsa F11 para alternar en cualquier momento entre pantalla completa y ventana.

■ Se encuentra como un programa nativo
Al instalar un APK se crean automáticamente los accesos directos del escritorio y del menú Inicio; basta con escribir el nombre de la app en la búsqueda de Windows para abrirla, y la barra de tareas agrupa por aplicación.

■ Archivos compartidos
%USERPROFILE%\ApkBuddyStartShared se sincroniza en ambos sentidos con /sdcard/ApkBuddyStartShared dentro de Android. Los archivos guardados por las apps Android se pueden ver directamente desde Windows.

■ Una descarga, listo al instalar
El paquete incluye el entorno de ejecución de Android completo (emulador, platform-tools e imagen de sistema); en tiempo de ejecución no se descarga ningún contenido ejecutable.

■ Ligero
La carcasa no tiene dependencias de terceros; el ejecución se inicia bajo demanda y se libera cuando está inactivo. También puedes reutilizar el entorno de ejecución de Android que ya tengas en tu máquina, con un consumo adicional cero.

■ La red es la del host
El lado Android usa el NAT en modo usuario de QEMU y comparte la salida con la tarjeta de red física del host; no se crea ninguna tarjeta ni conmutador virtual y no hay que instalar ningún controlador.

──────────── Requisitos del sistema ────────────
· Windows 10 versión 2004 (build 19041) o superior, x64
· Es necesario activar «Plataforma de máquina virtual» (Windows Hypervisor Platform / WHPX en las funciones de Windows); es el único método de aceleración por hardware admitido por la versión de Microsoft Store (una app de tienda no puede instalar controladores de kernel)
· Se recomiendan 8 GB de memoria o más; reserva unos 4 GB en la unidad del sistema para desplegar la imagen

──────────── Primer inicio ────────────
La primera vez se despliega la imagen del sistema incluida en el paquete en %USERPROFILE%\ApkBuddyStart\data (unos 3,3 GB; normalmente se tarda menos de un minuto). Los inicios posteriores no requieren conexión a red.

──────────── Notas ────────────
· La versión de tienda la actualiza Microsoft Store; la aplicación no ofrece actualización interna.
· Desinstalar la aplicación no elimina automáticamente los datos de %USERPROFILE%\ApkBuddyStart\data; para una limpieza completa, borra ese directorio manualmente.
· Esta aplicación no recopila datos personales, no contiene publicidad ni compras integradas.
```

**English** (opcional; se puede dejar vacío si solo se envía en español)

```
ApkBuddyStart turns Android apps into regular Windows software you can install and open.

After installing ApkBuddyStart, double-click any .apk in File Explorer. It is parsed and
installed automatically, and a shortcut with the app's real icon appears on your
Desktop and in the Start menu. Double-clicking that shortcut launches the Android
app directly.

· One app, one window — portrait apps keep their phone aspect ratio and fill the
  screen height; landscape apps fill 16:9. Windowed mode is freely resizable and
  remembers each app's size. F11 toggles full screen.
· Discoverable like native software — Desktop and Start menu shortcuts are created
  on install, so Windows Search finds apps by name.
· Shared files — %USERPROFILE%\ApkBuddyStartShared syncs both ways with
  /sdcard/ApkBuddyStartShared inside Android.
· One download, ready to use — the Android runtime (emulator, platform-tools,
  system image) ships inside the package. Nothing executable is downloaded at runtime.
· Lightweight — zero third-party dependencies in the shell; the runtime starts on
  demand and is reclaimed when idle.
· Host networking — Android uses QEMU user-mode NAT over the host NIC. No virtual
  adapter, no driver.

Requirements: Windows 10 2004 (build 19041) or later, x64; "Virtual Machine Platform"
(Windows Hypervisor Platform) enabled; 8 GB RAM recommended; ~4 GB free disk for the
system image.

First launch expands the bundled system image to %USERPROFILE%\ApkBuddyStart\data
(~3.3 GB, usually under a minute). No network access is needed afterwards.
```

---

## 4. Lista de funciones (Features, ≤200 caracteres cada una, máximo 20)

1. Instalación automática de .apk con doble clic, sin abrir la interfaz del emulador
2. Cada aplicación genera su propio icono de escritorio y acceso directo en el menú Inicio
3. Las apps se ejecutan en ventanas independientes, con modos pantalla completa/ventana y memoria de tamaño
4. Detecta automáticamente apps verticales/horizontales y las adapta con la proporción correcta
5. Las apps Android instaladas se encuentran directamente con la búsqueda de Windows
6. Carpeta compartida entre Windows y Android con sincronización bidireccional
7. Ejecución completa integrada; tras la instalación no se descarga ningún contenido ejecutable
8. La ejecución se inicia bajo demanda y se libera cuando está inactiva; carcasa sin dependencias de terceros
9. No crea tarjetas de red virtuales ni instala controladores de kernel; la red reutiliza directamente el host
10. Concede automáticamente permisos de ejecución y reintenta cuando una app se cierra de forma inesperada

---

## 5. Capturas de pantalla (al menos 1, se recomiendan 4)

Requisitos: PNG, **1366×768 o superior**, ≤50 MB por imagen, máximo 10.

Orden sugerido:

1. Interfaz principal (tarjetas de aplicaciones instaladas)
2. Una aplicación vertical en funcionamiento (para mostrar la ventana independiente y el llenado de pantalla)

**Generadas, listas para subir** (1920×1080, cumplen el mínimo de 1366×768):

| Archivo | Tema |
|---|---|
| `docs/store-shots/1-main.png` | Doble clic en un APK y se ejecuta al instante |
| `docs/store-shots/2-window.png` | Cada aplicación es una ventana independiente |

Para regenerarlas:

```powershell
npx electron build/store-shots.js
```

El script solo compone «interfaz real + fondo + texto»; no modifica la interfaz en sí.
Las capturas originales `raw-*.png` las produce el modo de captura `--smoke` de la aplicación (1920×1032).

---

## 6. Notes for certification (para el revisor, obligatorio)

```
ApkBuddyStart is an Android app runner for Windows. It bundles Google's official Android
emulator (qemu-system-x86_64.exe) and an AOSP system image inside the MSIX package.
No executable content is downloaded at runtime.

How to test:
1. Install the package and launch ApkBuddyStart.
2. On first launch it expands the bundled system image to
   %USERPROFILE%\ApkBuddyStart\data (~3.3 GB, about one minute). This is local extraction,
   not a download.
3. Drag any .apk onto the window (or double-click an .apk after enabling the file
   association in Settings) to install it. A shortcut appears on the Desktop.
4. Double-click the shortcut to run the Android app in its own window.

Notes:
· The app does not install APKs from the network on its own; the user must provide
  the .apk file.
· Hardware acceleration uses Windows Hypervisor Platform (WHPX), which is part of
  Windows. No driver or service is installed. If WHPX is not enabled, the app shows
  instructions instead of falling back silently.
· If the "hardware acceleration not enabled" hint appears on the test machine: this is
  expected on a Windows install where the optional feature "Windows Hypervisor
  Platform" (HypervisorPlatform) is turned off. The app cannot enable it by itself
  because MSIX apps cannot elevate. To enable it: Win+R → `optionalfeatures` → tick
  "Windows Hypervisor Platform" → OK → reboot. Everything still works without it
  (software emulation), just much slower. This is a Windows setting, not an app defect.
· Full-trust desktop app (runFullTrust). Data is stored under %USERPROFILE%\ApkBuddyStart,
  outside AppData, to avoid MSIX write virtualization breaking child processes.
· No telemetry, no ads, no in-app purchases, no account required.
```

---

## 7. Clasificación por edades (cuestionario IARC)

- La aplicación en sí no contiene contenido, pero puede ejecutar apps Android de terceros → selecciona «el usuario puede acceder a contenido de terceros»
- No contiene contenido generado por usuarios, ni funciones sociales, ni uso compartido de ubicación
- El resultado suele ser 3+ / Everyone

---

## 8. Pasos de subida (manual, unos 15 minutos)

1. Abre <https://partner.microsoft.com/dashboard> y entra en **Apps and games → New product → MSIX or PWA app**.
2. Reserva el nombre `ApkBuddyStart`, entra en **Product management → Product identity** y copia `Package/Identity/Name` y `Package/Identity/Publisher`.
3. Los valores de identidad **ya están confirmados** (`RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-…`); `node build/msix.js` genera directamente el paquete correcto. `build/msix.js` tiene una guarda: si Publisher no contiene `58CA1DED`, sale (código de salida 3) y no produce un paquete inútil. Solo hay que sobrescribirlos si Partner Center muestra valores distintos:
   ```powershell
   node build/msix.js --identity "<Identity/Name>" --publisher "<Identity/Publisher>"
   ```
4. **Packages** → sube `dist/store/ApkBuddyStart_0.5.8.0_x64.msix` y espera a que pase la validación.
5. **Store listing** → rellena el contenido de las secciones 2–5, sube las capturas y elige la categoría.
6. **Pricing and availability** → Free; selecciona China + Todo el mundo como mercados.
7. **Submission options** → pega las notas de certificación de la sección 6.
8. **Age ratings** → completa el cuestionario IARC.
9. Envía a certificación. El primer paquete suele tardar de 1 a 3 días hábiles.

> No uses la Store submission API para crear el primer envío: una vez creado por API,
> ese envío ya no se puede editar desde la web y entra en un estado de error irrecuperable.
