# Recorrido del código de ApkBuddyStart (para continuar el desarrollo)

> Dirigido a ingenieros que vayan a **seguir escribiendo código en este proyecto**. El objetivo no es repetir el README, sino responder tres preguntas:
> **en qué capas se divide el código, qué cadena recorre realmente cada acción clave y dónde es más fácil tropezar al hacer cambios**.
>
> Fecha de generación: 2026-11-14 · Versión correspondiente **v0.3.5** (desarrollo continuado sobre v0.3.4 del commit `e1db34b`) · Repositorio `RoutineMiku/apkstart`
> Línea base del recorrido: `src/**`, 41 archivos y unas 14.845 líneas (js/html/css/ps1); `npm test` = **70 pasan / 0 fallan**.
>
> **Cómo leer este conjunto de documentos**
> - Empieza por este archivo (visión general + cadenas de llamadas clave + mapa de problemas, unas 360 líneas);
> - para cambiar «instalación / análisis / iconos / accesos directos» → `CODE-WALKTHROUGH-PARSE.md`;
> - para cambiar «descarga / despliegue / cambio de fuente / actualización en línea / reglas de rutas» → `CODE-WALKTHROUGH-RUNTIME.md`;
> - para cambiar «arranque / incrustación de ventana / botones del ratón» → secciones 2.3~2.6 de este archivo + `docs/ARCHITECTURE.md`.

---

## 0. Resumen de una página

| Pregunta | Respuesta |
|---|---|
| Qué es | Un «ejecutor de aplicaciones Android» para Windows: carcasa Electron + ejecución propia de Android (Google Android Emulator / virtualización completa con QEMU), que instala cada app Android como un icono de escritorio y la abre en una ventana independiente de Windows |
| Arquitectura en una frase | **El proceso principal de Electron orquesta, `core/*` aporta las capacidades de dominio, el agente de ventanas PowerShell hace el trabajo sucio de Win32 y la capa de renderizado solo hace la UI** |
| Qué no hace | No escribe su propio hipervisor, no hace traducción de kernel Linux/GPU, no monta NTFS (la carpeta compartida usa sincronización en su lugar) y no depende de emuladores de terceros |
| Dependencia clave | Análisis escrito a mano, sin dependencias de terceros en la ejecución (zip/AXML/ARSC/PNG/ICO); solo `@napi-rs/lzma` (para descomprimir imágenes .xz) y Electron |
| Dónde están los datos | Código en `%APPDATA%\apkstart` (settings.json / apps.json / icons / apks / logs), ejecución en `runtime.dir` (se puede cambiar de unidad), AVD en `runtime.avdDir` (se puede cambiar de unidad) |
| De dónde sale la versión | `package.json:version`, que lee `app.getVersion()`; CI publica al recibir tags `v*` |

---

## 1. Estructura del repositorio

```
apkstart/
├─ src/
│  ├─ main.js                1790 líneas  Proceso principal de Electron: ventanas/bandeja/instancia única/CLI/IPC/ciclo de vida
│  ├─ preload.js              130 líneas  Puente seguro contextBridge (única entrada de la capa de renderizado)
│  ├─ ui/                            Capa de renderizado (HTML/CSS/JS nativo, sin framework)
│  │  ├─ index.html / app.js         Interfaz principal (lista de apps + diálogo de ajustes), app.js 1490 líneas
│  │  ├─ shell.html / shell.js/css   Cáscara de la ventana de la app (barra de título de 38 px + máscara de arranque)
│  │  └─ assets/                     logo / appicon.ico / códigos QR
│  └─ core/                           Capa de dominio (lo más posible en Node puro, sin dependencia de Electron)
│     ├─ Orquestación   installer.js engine.js container.js
│     ├─ Ejecución      emulator.js provision.js userdata.js doctor.js layers.js
│     ├─ Dispositivo    adb.js android.js sharer.js notify.js display.js
│     ├─ Ventana        appwin.js agent.js win/agent.ps1 win/priority.ps1 windowctl.js pointer.js
│     ├─ Análisis       zip.js axml.js arsc.js apk.js png.js shortcut.js assoc.js
│     └─ Descarga/actualización download.js sources.js updater.js store.js logfile.js
├─ build/                    Canalización de empaquetado (pack.js / prepare-runtime.js / slim-runtime.js / zip.js / seed/)
├─ test/                     run-tests.js(8) + engine-test.js(11) + auto-test.js(53) + un montón de sondas de equipo real
├─ tools/                    Scripts de publicación y comprobación en equipo real (publish-gitee.js, check-*.js, e2e-boot.js)
├─ docs/                     ARCHITECTURE.md, images/, promo/, este archivo
├─ engine/                   Caché de descarga de la ejecución (ignorada por git, solo README)
└─ .github/workflows/        ci.yml (pruebas con dos versiones de Node), release.yml (portátil + completa + sincronización Gitee)
```

**Dirección de las llamadas entre capas** (solo se permite que una capa dependa de la inferior):

```
ui/*  ──preload(contextBridge)──▶  main.js
main.js ──▶ installer.js / engine.js / appwin.js / updater.js / sharer.js …
installer.js ──▶ apk.js ──▶ zip.js / axml.js / arsc.js / png.js / shortcut.js
engine.js ──▶ emulator.js ──▶ provision.js (guardas de ruta/disco) + userdata.js (ext4) + adb.js
appwin.js ──▶ agent.js ──TCP JSON──▶ win/agent.ps1 (P/Invoke de C#)
Todas las capas ──▶ store.js (persistencia de ajustes y manifiesto)
```

---

## 2. Cadenas de llamadas clave (míralas antes de tocar código)

### 2.1 Doble clic en APK → instalado y con icono en el escritorio

```
Explorer: doble clic en .apk
 → HKCU\Software\Classes\ApkBuddyStart.apk (registrado por assoc.js, sin administrador)
 → ApkBuddyStart.exe "C:\x\a.apk"
 → main.js parseArgs() → runInstall(filePath)              main.js:537
     ├ Anti-reentrada: installBusy (varios clics/arrastres solo ejecutan una vez)  main.js:540
     ├ installer.install()                                 installer.js:141
     │   ├ /\.(apks|xapk)$/ → parseBundle() (extrae fragmentos a un directorio temporal) installer.js:26
     │   ├ parseApk()  →  zip.js → axml.js → arsc.js        apk.js:75
     │   ├ isArmOnly(meta) && sin imagen Play →
     │   │     ensureCompatImage() + switchToCompat()        installer.js:159
     │   └ runtime.ensure()  → véase 2.3
     ├ installer.finishInstall()                            installer.js:179
     │   ├ emulator.invalidateSnapshot() (la instantánea antigua deja de valer tras instalar)
     │   ├ adb install -r -g -t (si falla NO_MATCHING_ABIS, cambia a imagen compatible y reintenta)
     │   ├ Guardar icono en PNG + iconToIco() (WebP lo decodifica el proceso de renderizado) main.js:213 decodeIcon
     │   ├ Copia de seguridad del APK en apks/ (para reinstalar automáticamente en el futuro)
     │   ├ resolveLauncher(): se guía por el LAUNCHER que resuelve el sistema    adb.js
     │   ├ store.upsertApp()
     │   └ createShortcut(): dos .lnk, escritorio + menú Inicio                  installer.js:286
     └ Notificación / actualizar la caché de iconos del Explorador
```

**Por qué `resolveLauncher` debe ejecutarse después de instalar**: la «Activity principal» que se analiza del APK suele no ser el LAUNCHER real (Hongguo Short Drama tiene `SplashActivity` y no `MainFragmentActivity`); usar elpunto de entrada equivocado se salta la inicialización y la app se cierra a los 3~8 s. Véase `docs/ARCHITECTURE.md`.

### 2.2 Doble clic en el icono del escritorio → aparece la ventana de la app

```
<nombre-de-app>.lnk → ApkBuddyStart.exe --launch <pkg> (el lnk lo escribe shortcut.js, con AppUserModelId)
 → main.js parseArgs() solo acepta la forma com.foo.bar                    main.js:201
 → ¿Instancia existente? second-instance → runLaunch()                     main.js:1477
 → runLaunch(pkg)                                                           main.js:606
     ├ openAppWindow(): abre enseguida una ventana solo con barra de título + máscara de arranque main.js:286
     ├ armAgent(): primero envía el scope al agente de ventanas y activa la «supresión permanente» main.js:1547
     ├ installer.launch()                                                  installer.js:385
     │   ├ runtime.ensure() (véase 2.3)
     │   ├ beforeStart → prepareForeground() (inmersivo/desactivar animaciones/ocultar bloqueo)
     │   ├ ¿La app no está en la ejecución actual? Se reinstala desde el APK de respaldo installer.js:404
     │   ├ grantRuntimePermissions()
     │   └ startApp() + staysAlive() (ventana de 25 s / supervivencia continua de 4 s)
     │        Fallo: reintenta 3 veces → pm clear + conceder permisos → arrancar otra vez
     │        Fallo con evidence(APP_CRASHED) → cambiar a imagen compatible y repetir
     ├ appWin.embed(): SetParent incrusta la ventana del emulador          appwin.js:213
     └ runtime.beginApp(pkg): detiene otras apps, sube prioridad, activa sincronización/notificaciones engine.js:901
```

**La incrustación no es «emitir la imagen»**, sino hacer `SetParent` de la ventana hija Qt del emulador a la ventana host de Electron y después `SetWindowPos` según el rectángulo del área cliente. Por tanto:
- La imagen se renderiza de forma nativa a 60 fps nativos, y el ratón y el teclado van directos al guest;
- hay que llamar a `app.disableHardwareAcceleration()`, o la capa DirectComposition de Chromium se superpondrá a la ventana hija (`main.js:72`);
- al cerrar la ventana hay que **hacer primero park (SetParent(NULL)+SW_HIDE) y después destruir la ventana host**, o Windows volverá a colgar la ventana hija en el escritorio (`appwin.js:318` / `agent.ps1:990`).

### 2.3 `runtime.ensure()`: qué hace exactamente un arranque

`engine.js:796 _ensureInner()` prueba en orden, **y cualquier paso que tenga éxito devuelve el resultado**:

1. `client.isOnline()` → ya hay un dispositivo en línea: se reutiliza directamente con `prepare()`;
2. `adoptExisting()` (`engine.js:708`) → busca puertos de emuladores aún vivos (`tasklist` + `netstat` para encontrar el puerto de escucha de qemu, sin adivinar 5554); tras `adb kill-server`, conecta uno por uno con `connect` + `getprop sys.boot_completed` y reutiliza los que se puedan tomar;
3. Ya hay un `emulator-NNNN` en `adb devices` → se reutiliza;
4. El proceso existe pero el dispositivo está sin conexión → `emulator.stop()` y se empieza de nuevo;
5. Ruta única (desde 0.5.6 no hay bases de terceros ni modo attach):
   - `provisioner.materializeImages()` despliega las imágenes del sistema `.xz/.gz` (si ya están desplegadas, pasa al instante);
   - `checkEnv()` comprueba que adb/emulator/sysimg estén completos;
   - `killOrphanEmulators()` limpia los qemu residuales (si no, el bloqueo del AVD es FATAL);
   - `bootEmulator()` → `emulator.start()` (véase 2.4) → si tiene éxito, `prepare()` (ensureFreeform + perro guardián) → guarda una instantánea con el equipo inactivo a los 20 s.

La capa externa de `ensure()` es una **Promise idempotente** (`engine.js:787`): si el precalentamiento y un clic del usuario ocurren a la vez, solo se arranca una máquina, evitando pelear por el bloqueo del AVD.

### 2.4 `emulator.start()`: el bucle de arranque con degradación automática

El núcleo de `emulator.js` es «`doctor.planVariants()` genera hasta 4 juegos de parámetros → se prueba cada uno → una sonda evalúa cada juego → si el proceso se cae o aparece un registro fatal, se pasa al siguiente»:

- Los parámetros los deriva `doctor.chooseProfile()` (memoria/núcleos/LCD/GPU/partición de datos/puerto); `liteMode` reduce las vCPU a un cuarto de los núcleos físicos (2~3);
- con `gpuMode=auto` se elige el backend según la versión del emulator (37.x usa `host`; las versiones antiguas, `swiftshader_indirect`), con `software` como último recurso;
- `badGpu` recuerda el backend que «se cayó al arrancar» (la clave incluye la versión del emulator y caduca automáticamente al actualizar);
- cada ronda de sonda envía **una sola** orden adb (`getprop sys.boot_completed; pm path android`); 6 rondas seguidas de error llaman automáticamente a `resetAdbServer()` para autorrecuperarse;
- **La partición `/data` la crea el propio ApkBuddyStart** (`userdata.js` + `ensureDataPartition()`, `emulator.js:348`): el `userdata.img` de la imagen oficial es solo un marcador de posición de 1 MB lleno de ceros; arrancar `emulator.exe` directamente omite el formateo y el guest cae en un bucle de reinicio en recovery. Por eso el primer inicio escribe a mano un ext4 con bloques de 4 KB (con `FILETYPE|ENCRYPT` y `ext_attr`) y luego lo amplía con el `qemu-img resize` + `resize2fs` incluidos hasta la capacidad configurada.

### 2.5 Reglas de almacenamiento y rutas (todos los issues de cambio de unidad están aquí)

| Concepto | Ubicación en el código | Valor predeterminado | ¿Se puede cambiar de unidad? |
|---|---|---|---|
| Directorio de datos del código `DATA_DIR` | `store.js:10` | `%APPDATA%\apkstart` | No (la caché se puede mover a la unidad del AVD con `relocateUserDataIfCrowded()` cuando C va justa, `main.js:50`) |
| Raíz de la ejecución `paths().root` | `provision.js` | `DATA_DIR\runtime` | Sí: `runtime.dir` |
| Directorio del AVD `paths().avdHome` | `provision.js` | `DATA_DIR\avd` | Sí: `runtime.avdDir` |
| Directorio de despliegue de la imagen del sistema `paths().sysImgRoot` | `provision.js` | `DATA_DIR\system-images` | Sigue a la raíz de la ejecución (**debe usar exactamente el mismo conjunto de reglas que el destRoot de `materializeImages`; antes se guardaron dos copias en C por esto) |
| Directorio compartido | `store.js:99` | `%USERPROFILE%\ApkBuddyStartShared` | Sí: `sharedDir` |

### 2.6 El agente de ventanas (`agent.ps1`): por qué existe

La opción `windowsHide` de Node no controla las ventanas de consola `qemu` / `netsimd` que el propio emulator crea desacopladas (la ventana pertenece a `conhost.exe` y el pid no coincide). Por eso hay un **proceso PowerShell permanente** con C# + P/Invoke incrustado, al que se dan órdenes mediante JSON de una línea por TCP local:

| Orden | Función |
|---|---|
| `scope {dirs, pid}` | Declara «qué procesos de qué directorios son nuestros» + el pid del proceso principal. **Sin scope, no se toca ninguna ventana** |
| `embed {host,x,y,w,h}` | `SetParent` + `SetWindowPos` para incrustar en la ventana host; si el pid del host no es el del proceso principal, se rechaza (`host-not-ours`) |
| `fit` | Reordena la ventana hija siguiendo el resize/move de la ventana host |
| `park` | La desprende y la esconde (hay que hacerlo antes de destruir el host) |
| `boothide on/off` | Supresión permanente: aplica `ShowWindow(0)` periódicamente a la ventana principal, la barra de herramientas y la ventana negra de consola del emulador, omitiendo la que ya está incrustada |
| `hook on/off {right,wheel,side}` | Hook global de ratón (volver con clic derecho / agrupar rueda / botones laterales); **solo se instala cuando la ventana de la app está en primer plano y se desinstala al perder el foco** |
| `rotate` / `hide` / `show` / `probe` / `windows` / `consoles` / `quit` | El resto |

**Lección central de v0.3.4: el nombre de clase no es identidad, lo es la ruta del proceso.** Las versiones antiguas identificaban la ventana por `QWindowIcon`, y WeChat 4.x también es Qt6 con exactamente el mismo nombre de clase → «abres ApkBuddyStart y desaparece la ventana de WeChat». Ahora todas las decisiones pasan primero por `IsOurs(pid)` (`agent.ps1:168`); la ventana negra de consola se gestiona por la cadena de procesos padres de conhost + un título que contiene el directorio del scope (`agent.ps1:219`).

---

## 3. Responsabilidades e interfaces clave de cada capa

### 3.1 `main.js` (orquestación del proceso principal)

| Bloque | Líneas | Descripción |
|---|---|---|
| Decisiones previas al arranque | 40-72 | `relocateUserDataIfCrowded()` (mueve la caché si C va justa), `disableHardwareAcceleration()` |
| Toma automática de la versión completa | 97-171 | Si junto al exe hay `runtime/` y cualquier imagen completa → escribe `runtime.dir`, activa el modo compatible; exige `sameTree` (solo reconoce árboles bajo el directorio de este EXE) para que una versión portátil movida no siga usando el paquete antiguo |
| Instancia única + parámetros | 196-209, 1473-1482 | `--launch <pkg>` / `<path.apk>` / `--autostart`; second-instance reparte a la instancia ya en ejecución |
| Bandeja | 468-530 | Acceso directo a las 8 primeras apps, alternar pantalla completa, reconstruir accesos directos, comprobar actualizaciones, salir |
| Instalación | 537-573 | `runInstall()`: anti-reentrada + el error solo muestra una notificación del sistema |
| Arranque | 606-662 | `runLaunch()`: véase 2.2 |
| Actualización | 579-604 | `runUpdate()`: `updater.prepare()` → `apply()` → sale para que el script tome el control |
| IPC | 702-1469 | Unos 120 channels, agrupados por dominio (apps/apk/settings/display/runtime/provision/doctor/android/update/window/shell) |
| Ciclo de vida | 1484-1790 | `whenReady` ensambla todos los objetos; `before-quit` sale en dos fases (primero park de ventanas y luego salida real) |

**Convención de nombres IPC**: `dominio:acción`; la capa de renderizado solo puede llamar a `window.apkstart.*` expuesto por `preload.js`, y los eventos push están en lista blanca (`preload.js:120`).

### 3.2 `core/engine.js` (ciclo de vida de la ejecución)

Exporta `class Runtime`: `ensure / prewarm / boot / stop / adoptExisting / beginApp / endApp / status / diagnostics / cleanup / dispose`.
Invariantes clave:

- `ensure()` y `prewarm()` son Promises idempotentes;
- `dispose()` **nunca mata qemu a la fuerza** (matarlo a la fuerza trunca la instantánea quickboot que se está escribiendo → el próximo arranque será en frío);
- una instancia adoptada no tiene handle de proceso local, así que `vmRunning` debe mirar también `adb isOnline()`, o el perro guardián nunca podrá reciclarla;
- el perro guardián de reciclado por inactividad ronda cada 60 s: solo para si vence `idleShutdownMinutes` y no hay ninguna app activa.

### 3.3 `core/emulator.js` (adaptación del emulador)

Responsabilidades: crear el AVD / generar parámetros / lanzar el proceso / sonda / instantáneas / prioridad / puertos / limpieza de huérfanos / partición de datos. Interfaz pública: `start/stop/running/scheduleSnapshotSave/saveSnapshotNow/cancelSnapshotSave/invalidateSnapshot/ensureDataPartition/resizeDataPartition/dataInfo/setPriority/killOrphanProcesses/resetAdbServer/versions`.
Los puntos delicados están en los comentarios de la cabecera del archivo (`emulator.js:330-347`): el tamaño de bloque debe ser 4096, el bit `encrypt` se añade al final, `ram.bin` frente a `ram.img`, y `emulator.exe` es solo un lanzador.

### 3.4 `core/adb.js` (operaciones con el dispositivo)

`class AdbClient`: `isOnline/shell/exec/install/installMultiple/uninstall/startApp/forceStop/clearData/runningPackages/wmSize/setOrientation/keyBack/keyForward/input/prepareForeground/grantRuntimePermissions/dismissPermissionDialog/resolveLauncher/ensureFreeform/devices/connect/killServer`.
Clave de rendimiento: **canal de entrada `adb shell` persistente** (`input()` usa `echo __APKSTART_<id>__` como respuesta y control de flujo), de modo que «volver con clic derecho» y la rueda ya no lanzan un proceso adb por cada muesca.

### 3.5 `core/installer.js`

Véase 2.1. Dos rutas de «autoreparación» que conviene recordar: `switchToCompat()` (tras cambiar de imagen, vuelve a instalar las apps ya instaladas desde sus APK de respaldo) y `ensureShortcuts()` (al arrancar completa los iconos/accesos directos que las versiones antiguas omitieron).

### 3.6 `src/ui/`

- `app.js`: máquina de estados en un solo archivo (objeto `state` + un montón de funciones render), sin framework; todas las llamadas al backend son `await window.apkstart.xxx()`;
- progreso de instalación: en `installFiles()`, toast sticky + evento `install:progress`; **en caso de error, primero `off()` y después `dismiss()`** (el antiguo «el mensaje de error no dejaba de repetirse» venía de ahí);
- `shell.html/js`: cáscara de la ventana de la app, solo cuatro botones (girar/minimizar/maximizar/cerrar) + máscara de arranque.

### 3.7 Persistencia `core/store.js`

`getSettings()` hace cada vez `deepMerge(DEFAULT_SETTINGS, valor-en-disco)` y **migra forzosamente** tres ajustes históricos (`headless=false` / `hideAfterLaunch=false` / `freeform=false`);
`saveSettings()` escribe tmp + rename (escritura atómica) y gestiona la traducción de `resourceMode` → `liteMode/priorityMode/renderSize`.
`apps.json` es un array `{ apps: [...] }`, y `upsertApp` combina por `package`.

---

## 4. Canalización de compilación / publicación

| Comando | Script | Producto |
|---|---|---|
| `npm run pack` | `build/pack.js` | `dist/ApkBuddyStart-win64-portable/` (~226 MB descomprimido; la ejecución se descarga en el primer inicio) |
| `node build/zip.js <dir> <zip>` | `build/zip.js` | Comprime con 7-Zip `-mx=9` y se autoverifica con nuestro propio analizador zip; **falla directamente si supera 100 MiB** (límite de archivo único de Gitee) |
| `npm run runtime` | `build/prepare-runtime.js` | `build/runtime/` (emulator reducido + imágenes xz/gz + `build/seed/userdata.img.gz`) |
| `npm run build:exe` | Los dos pasos anteriores + `electron-builder --win nsis` | `dist/release/ApkBuddyStart-<ver>-Setup.exe` (~1,32 GB, ejecución integrada) |
| `npm test` | `run-tests.js` + `engine-test.js` + `auto-test.js` | 70 pruebas de Node puro |
| `npm run test:boot` | `test/boot-test.js` | Arranque real de un guest Alpine, valida parámetros QEMU/creación de disco/apagado limpio |
| `npm run selftest` | `scripts/selftest.js` | Verificación de extremo a extremo sobre un dispositivo ya instalado (adb/versión/freeform/carpeta compartida; con `--apk` recorre instalación → arranque → captura) |

`.github/workflows/ci.yml`: Windows × Node 20/22 ejecuta `npm test` + `test/pointer-hook-logic.ps1` (para evitar que se rompan los botones del ratón).
`.github/workflows/release.yml`: tag `v*` → job `build` (zip portátil → GitHub Release → sincronización Gitee; si falta `GITEE_TOKEN`, falla directamente en lugar de omitirlo en silencio) + job `full` (ensamblar ejecución → xz → Setup NSIS → subir Release + zip de la ejecución completa).

**Lista de comprobación de publicación** (extraída de tropiezos históricos):
1. Hay que subir (bump) el número de versión de `package.json` (si no, el cliente dice «ya estás al día»);
2. Si se escribe `.github/release-notes-<tag>.md`, se usa; si no, `--generate-notes`;
3. El job `full` tarda ~40 minutos (comprimir 1,1 GB en xz);
4. Para Gitee usa `tools/publish-gitee.js`; primero el paquete completo y solo se divide si supera el límite;
5. Tras publicar, verifica «el paquete publicado == el código»: revisa si el `agent.ps1` dentro del zip contiene `SetScope`/`IsOurs` y la versión de `package.json`.

---

## 5. Herramientas de prueba y verificación en equipo real

- **Regresión de Node puro** (obligatoria en CI): `test/auto-test.js` cubre la matriz de parámetros de doctor, la máquina de estados del contenedor, el descargador/doble fuente, la lógica del puntero, la rotación de logs, etc.;
- **Sondas de equipo real** (se ejecutan a mano en la máquina local; no funcionan en el sandbox): `tools/check-windows.js` (fugas de ventanas en el arranque), `check-console.js` (ventana negra), `check-launch-clean.js` (instalar+abrir+incrustar), `check-quit-clean.js` (residuos al salir), `check-update.js` (API real de GitHub), `e2e-boot.js` (tiempos de arranque en frío/en caliente);
- **Prueba de humo de la interfaz**: `electron . --smoke out.png`, con `--settings` / `--perf` / `--download` para capturar cada zona de la página de ajustes;
- **Pruebas de lógica PS**: `test/pointer-hook-logic.ps1` ejercita por reflexión la devolución de llamada del hook; `agent-compile.ps1` solo verifica que el C# compila.

> Entorno probado en esta máquina (la del desarrollo): **Node 22.22.2 / npm (`.workbuddy/binaries/node`)**, **PortableGit 2.55**, Electron 33.4.11 (`node_modules/electron/dist`), ejecución en `D:\ApkBuddyStartRuntime` (emulator 37.3.9.0 + AEHD Operational), AVD en `D:\ApkBuddyStartData` y datos en `%APPDATA%\apkstart`.

---

## 6. Mapa de problemas actuales (lo primero que conviene mirar al hacerse cargo)

### 6.1 Bugs conocidos y activos (corresponden a issues de GitHub)

| Issue | Síntoma | Ubicación del código ya localizada |
|---|---|---|
| #21 Se cuelga al instalar APK de 2 GB+ | La app da error y «el icono de la esquina inferior derecha no deja de girar» | `apk.js:78` usa `fs.readFileSync(filePath)` para leer el paquete entero y choca con el límite de un único Buffer de Node; debería usar el `ZipFile` ya existente en `zip.js` (lectura por fd del directorio central) |
| #20 / #25 No puede arrancar (0xC0000005) | El emulator imprime Userspace boot properties y luego `exit 3221225477` | Ambos casos son NVIDIA + emulator 37.3.9.0 + `-gpu host`; la ejecución local tiene la misma versión, así que se puede reproducir in situ |
| #26 Instalación muy lenta / se queda en «preparando la ejecución» | El primer despliegue se detiene en la descarga | `provision.installRuntimePack()` / ruta de descarga pieza a pieza desde la fuente oficial; cortocircuito por limitación de Gitee |
| #27 / #28 Se ocultan las ventanas de WeChat y UU Remote | Ya corregido en v0.3.4 (scope/IsOurs) | `agent.ps1:168`; basta con que el usuario actualice |
| PR #18 / #22 | Duplican implementaciones ya integradas | #18 fue sustituido por `b3fc7c2`; el orden de parámetros de `_qemuImg` de #22 ya se corrigió en `emulator.js:403` |

### 6.2 Defectos de implementación confirmados (detectados línea a línea en el recorrido, sin corregir)

| # | Ubicación | Defecto | Impacto |
|---|---|---|---|
| 1 | `apk.js:78` / `installer.js:27` | `fs.readFileSync` lee el APK entero | Los APK de 2 GB+ revientan (issue #21); en máquinas con poca memoria también es peligroso analizar paquetes grandes |
| 2 | Todo `zip.js` | **No hay Zip64** (`zip.js:29-30,37,161-162,180`) | Con más de 65535 entradas se pierden entradas en silencio; una entrada >4 GiB lanza `RangeError` (las imágenes del sistema y los paquetes de actualización tarde o temprano lo alcanzarán) |
| 3 | `assoc.js:62-63` | La «preservación de la asociación original del usuario» que promete el comentario no existe; al desinstalar se borra sin ningún tipo de condición el valor predeterminado de `.apk` | Se pierde la asociación APK original del usuario; el módulo no tiene ninguna prueba |
| 4 | `logfile.js:19-21` | Si `bak === file`, primero borra y luego renombra | Los nombres que no terminan en `*.log` pierden el log (`appLog` resulta ser `app.log`, así que no ha estallado) |
| 5 | `provision.js:531` + `sources.js:412` | Al empezar el despliegue fija `percent:1` y después **mide la velocidad en serie** de cada dirección hasta 9 s | 4 candidatos = más de 30 s sin progreso → el usuario piensa que «se ha quedado en preparando la ejecución» (issue #26) |
| 6 | `provision.js:575-576` / `:790` | El fallo al desplegar `.xz` se traga en dos niveles de `catch` | El progreso se queda en el 99 % y salta a «usar la fuente oficial para completar», descargando otro paquete de 1,4 GB en vano |
| 7 | `provision.js:262-277` | A la tabla `need` de `guardDisk` le falta la entrada `'runtime'` y solo estima 1536 MB | El paquete completo + el despliegue ocupan en realidad unos 5 GB; la guarda puede pasar y aun así llenar el disco |
| 8 | `updater.js:80` | Respaldo `/\.zip$/i` para la versión portátil | Si una versión solo tiene `ApkBuddyStart-runtime-*.zip`, se toma por paquete de actualización y se extrae dentro del directorio del programa |
| 9 | `main.js:165-168` | `bootstrapBundledRuntime()` sobrescribe el `runtime.dir` elegido por el usuario cuando «el directorio portátil contiene runtime» | «Configuré el directorio de ejecución pero sigue descargando en AppData» (issue #23) |
| 10 | `main.js:213` / `shortcut.js:120` | Los iconos WebP dependen de un BrowserWindow oculto para decodificarse | En Node puro / sin GUI degradan en silencio a una imagen de marca de marcador, y no se distingue «falló la decodificación» de «no hay icono» |
| 11 | `apk.js:29,67` | La lista blanca de formatos de icono solo tiene `.png`/`.webp` y no recursa por XML `<bitmap>` | Los iconos `.jpg` y las combinaciones adaptive-icon se extraen mal |
| 12 | `arsc.js:65-77` | La puntuación de config son constantes inventadas (`anydpi` resta 500, `language` resta 40) | Una app en chino puede tomar el nombre en inglés; los tres tipos de codificación de entry no tienen pruebas y, si fallan, vuelven al valor por defecto en silencio |

### 6.3 Problemas estructurales (se pueden abordar en la siguiente fase)

1. **Unificar la ruta de archivos grandes**: cambiar `apk.js` / `installer.parseBundle()` para usar el `ZipFile` ya existente (lectura por fd, `zip.js:128` en adelante): el pico de memoria baja de «el tamaño del archivo» a «unos pocos MB» y se resuelve de paso el límite de 2 GB. Ojo: las dos clases tienen semánticas distintas de `read()` (`ZipArchive` devuelve null / `ZipFile` lanza error), así que al sustituir hay que añadir comprobaciones `has()`;
2. **Añadir Zip64**: cuando el EOCD muestra `0xffff/0xffffffff`, localizar el Zip64 EOCD (`0x06064b50`) y el locator (`0x07064b50`) y sustituir los 4 campos por u64;
3. **Dividir archivos grandes**: repartir los 1790 líneas de registro IPC de `main.js` en `src/main/ipc/*.js` por dominio; dividir las 1064 líneas de `emulator.js` en tres bloques: «matriz de parámetros / instantáneas / partición de datos»;
4. **Diagnóstico insuficiente** (los informes de #20/#25 muestran `attempts: []` y `bootLog: []`): al fallar, escribir `emulator.attempts` y el final de emulator.log en el informe de diagnóstico, y traducir los códigos de salida al español (`3221225477` = 0xC0000005, infracción de acceso);
5. **Capa de compatibilidad GPU**: `-gpu host` se cae con algunos controladores NVIDIA y emulator 37.3.9; se puede ampliar el mecanismo `badGpu` con una regla «código de salida 0xC0000005 → degradar automáticamente y recordarlo»;
6. **Huecos de prueba** (por riesgo): AXML/ARSC sin casos de bytes sintéticos (cuando faltan fixtures de APK reales se omite toda la sección → cobertura cero en CI), `arsc.resolve()` sin aserciones, sin casos para `.apks/.xapk`, `assoc.js` sin cobertura, `pngToIco`/`writeShortcut` fuera de `npm test`;
7. **Los assets de Gitee no coinciden con GitHub** (en v0.3.4 Gitee solo tenía el paquete portátil): el proceso de publicación ya incluye `publish-gitee.js`, pero CI necesita el secreto `GITEE_TOKEN` para no fallar.

### 6.4 Los eslabones más propensos a fallar en la cadena de despliegue (11 consultas rápidas)

| Síntoma (vista del usuario) | Ubicación en el código | Mecanismo |
|---|---|---|
| Se queda en «preparando la ejecución» al 1~3 % | `provision.js:531` + `sources.js:412` | Medición de velocidad en serie, sin progreso de bytes |
| Se para en el 99 % y salta a «usar la fuente oficial» | `provision.js:575-576,790` | El fallo al desplegar `.xz` se traga |
| «Configuré el directorio de ejecución pero descarga en AppData» | `provision.js:217-224,726` + `main.js:165-168` | Tres ramas de `sysImgRoot` siguen el directorio antiguo + la toma automática de la versión completa sobrescribe el ajuste |
| El disco está vacío pero dice que no hay espacio | `provision.js:262-277` | La guarda solo estima 1,5 GB |
| El progreso se atasca en el 95 % | `download.js:446-503` | Bloques finales de una fuente lenta; ya se añadió cambio de fuente por baja velocidad y garantía de settle |
| La descarga se anula al cortarse la conexión | `download.js:155,188-191` | Ver un archivo a medias degrada a flujo único |
| La actualización se queda en «reemplazando el programa» | `updater.js:271,280-285,315-323` | El script de sobrescritura **no puede ir desacoplado**; el antivirus lo bloquea |
| Aparece un archivo de 1,5 GB en el directorio del programa | `updater.js:80` | El paquete completo de la ejecución se toma por paquete de actualización |
| Gitee no tiene instalador en cierta versión | `release.yml` + `sources.js:172-204` | Falta el token → fallo directo; los fragmentos deben ser part1..N consecutivos |
| Tras cambiar de fuente sigue usando la dirección antigua | `main.js:819-825` | `provision._cache.*` no tiene punto de invalidación; hay que reiniciar |
| El AVD se considera «ya en uso» | `layers.js:87-90` + `engine.js:856` | Quedan `*.lock` residuales; el panel de limpieza puede reciclarlos |

> **Tres «mira aquí primero» para quien se haga cargo**
> 1. Con ver una sola función se explican el 80 % de los problemas de despliegue: `Provisioner.checkEnv()` (`provision.js:367`);
> 2. Las reglas de rutas están en un solo sitio: `Provisioner.paths()` (`provision.js:197`); el código nuevo que escriba archivos de ejecución debe tomar las rutas de ahí;
> 3. La estrategia de descarga está concentrada en `Sources` + `downloadMulti`; no escribas otra distinta en `provision.js`.

### 6.5 Registro de correcciones locales (v0.3.5-dev, sin publicar ni enviar)

Segunda ronda de desarrollo del 2026-11-14: solo se modificó el espacio de trabajo local; `npm test` pasó de **98 a 113 pruebas, todas en verde**
(run-tests 3→8 + engine-test 25 + auto-test 70→80, con nuevos casos de regresión: APK sintético / paquetes divididos .xapk /
materializeImages / Zip64 / assets de actualización / 0xC0000005 / límites de log / persistencia de fallos / composición de componentes de arranque, etc.),
y se hizo una verificación de extremo a extremo con un arranque en frío real (25 s) / en caliente (5 s, con instantánea) / apagado limpio (instantánea guardada);
**APK sintético de 2,15 GB medido: análisis en 18 ms y 47 MB de RSS en el proceso** (la ruta antigua necesitaba unos 2,2 GB de memoria contigua);
`assoc` se probó con el registro real de esta máquina en un ciclo completo de «copia de seguridad → registro → desregistro → restauración»
(asociación original de la máquina: `MuMuPlayer.apk`, restaurada tal cual).

| # | Qué se corrigió | Ubicación | Por qué |
|---|---|---|---|
| 1 | `parseApk` / `parseBundle` pasan a lectura zip por archivo con flujo | `apk.js:80-95`, `installer.js:27-60` | Los APK de 2 GB+ ya no chocan con el límite de un único Buffer de Node; cada fragmento del paquete dividido también se escribe con flujo |
| 2 | ZIP con soporte Zip64 (locator EOCD + extra id=0x0001) | `zip.js:9-92`, `zip.js:151-236` | Más de 65535 entradas ya no se truncan en silencio; las entradas gigantes ya no se salen de rango ni pierden desplazamientos |
| 3 | Tiempo de espera de `adb install` escalado con el tamaño del paquete (tope 20 minutos) | `adb.js:105-114` | Subir un paquete de 2 GB + dexopt supera los 4 minutos fijos |
| 4 | Despliegue: medición de velocidad con progreso (fuente i de n, 6 s por fuente) | `sources.js:408-424` | «Quedarse en preparando la ejecución» ya no es un tramo de 30 s sin progreso |
| 5 | El fallo al desplegar la imagen ya no se traga; usa `.part` + rename atómico; la comprobación de «ya desplegada» exige un tamaño no menor que el del comprimido (una imagen a medias se vuelve a descomprimir) | `provision.js:766-826` | Antes se paraba en el 99 % y volvía a la fuente oficial para bajar otros 1,4 GB; un system.img a medias se daba por terminado |
| 6 | `guardDisk('runtime')` incorpora una estimación de 5000 MB | `provision.js:262-268` | Paquete + despliegue alcanzan unos 4,7 GB en el pico; la estimación antigua era de solo 1,5 GB |
| 7 | El directorio de ejecución fijado por el usuario ya no lo sobrescribe la ejecución integrada | `main.js:136-162` | Issue #23: «configuré el directorio pero sigue descargando en AppData» |
| 8 | El respaldo `.zip` del actualizador excluye `ApkBuddyStart-runtime-*.zip` | `updater.js:73-88` | Evita que, si una publicación carece del paquete portátil, se extraiga el paquete completo de 1,5 GB como si fuera el programa |
| 9 | Regla de diagnóstico 0xC0000005 + degradación automática de GPU + persistencia del fallo | `doctor.js:320-330`, `emulator.js` (`describeExitCode` / `_persistFailure` / `lastFailure` / `tailLogFile`), `engine.js:diagnostics` | Issue #20/#25: que `attempts: []`, `bootLog: []` y UNKNOWN aparecieran en el informe se debía a que los datos solo vivían en memoria |
| 10 | `assoc` restaura la asociación `.apk` original del usuario al desinstalar | `assoc.js:40-135` | La implementación antigua borraba el valor por defecto sin mirar nada (la protección prometida en el comentario no existía) |
| 11 | Guarda de límite en la rotación de logs para `bak === file` | `logfile.js:15-30` | Los nombres que no son `.log` se borraban antes de renombrar y perdían el log |
| 12 | Iconos: añadido jpg a la lista blanca,recursivo de 3 niveles en iconos XML, marcador distinguishable con aviso suave | `apk.js:27-115`, `shortcut.js:109-140`, `installer.js:210-235,289-300` | Los iconos `.jpg`/adaptive-icon/layer-list ya no se convierten todos en marcadores; si no se pueden resolver de verdad, se avisa al usuario |
| 13 | UI de error de instalación: los mensajes se concentran en `install:error` y se limpia el giro de «instalando» | `ui/app.js:469-520,1446-1460`, `main.js:566` | En el issue #21, «da error pero la esquina inferior derecha sigue cargando» |
| 14 | Nuevas pruebas de regresión de «APK sintético»: manifiesto AXML propio + icono PNG + directorios ABI, cubren la base `attributeStart`, `package` sin namespace, atributos enteros y análisis de la Activity de arranque; los paquetes divididos `.xapk` y `materializeImages` (desplegar/omitir/imagen dañada sin dejar restos) tienen casos propios | `test/lib/make-apk.js`, `test/run-tests.js`, `test/auto-test.js` | Sin fixtures de APK reales, axml/apk tenían cobertura cero en CI; desplegar imágenes es el paso más frágil del despliegue |
| 15 | **Tras una instalación nueva, al pulsar el icono solo se ve el escritorio Android**: `startApp` componía sin ningún tipo de condición `${pkg}/${activity}`, pero `resolveLauncher`/ los registros de nuevas instalaciones guardan el componente completo `pkg/class` → el componente de `am start` queda `pkg/pkg/class` y el sistema lo cancela (result code=-92). Se añadió `componentArg()` para unificar ambas formas y `parseResolvedActivity()` tolera líneas vacías finales / líneas priority | `adb.js:105-131,520`, `test/auto-test.js` | Es un **bug existente aguas arriba detectado en las pruebas** (también en v0.3.4) que solo afecta a apps «instaladas/reinstaladas»; los apps.json antiguos (solo nombre de clase) no lo disparan |

> Aún sin hacer (para la siguiente ronda): dividir el IPC de `main.js`, dividir `emulator.js`, hacer configurable la puntuación de config de `arsc`,
> extraer la bandeja y el menú de actualización de las 1790 líneas de `main.js`, y los casos de bytes sintéticos de `arsc.js` (`axml.js`/`apk.js`
> ya están cubiertos por los casos de «APK sintético» en `test/run-tests.js` y ya no dependen de fixtures externos).

---

## 7. Apéndice: referencia rápida de módulos

### 7.1 Firmas de exportación de `src/core`

| Módulo | Exportaciones principales |
|---|---|
| `store.js` | `DATA_DIR/ICON_DIR/APK_DIR`, `getSettings/saveSettings/getApps/saveApps/upsertApp/removeApp/getApp/iconPath/apkPath/ensureDirs/DEFAULT_SETTINGS` |
| `engine.js` | `class Runtime`, `MONITOR_PORT` |
| `emulator.js` | `class EmulatorEngine` |
| `provision.js` | `class Provisioner` (`paths/checkEnv/installAdb/installEmulator/installSystemImage/installPlayImage/installAehd/installQemu/materializeImages/installRuntimePack/guardDisk/emulatorAccel/hypervisor`) |
| `installer.js` | `class Installer`, `accentOf` |
| `adb.js` | `class AdbClient`, `friendlyInstallError`, `friendlyLaunchError` |
| `apk.js` | `parseApk` |
| `zip.js` | `class ZipArchive` (paquete en memoria), `class ZipFile` (flujo por fd) |
| `appwin.js` | `class AppWindow`, `TITLEBAR_H` |
| `agent.js` | `class WinAgent`, `AGENT_SCRIPT` |
| `doctor.js` | `hostInfo/freeDiskMB/gpuCandidates/lcdFor/shortPath/liteProfile/chooseProfile/overridesFromSettings/autoProfile/planVariants/isPortFree/snapshotKey/imageIdentity/diagnose/describeProfile/writeReport/vcRedistOk` |
| `updater.js` | `class Updater` (`check/prepare/apply`, `repoUrl`) |
| `sources.js` | Enumeración/medición/caché/cortocircuito de doble fuente (véase `_wip-provision-stack.md`) |
| `download.js` | `downloadMulti` / flujo único / reanudación / perro guardián (véase el mismo documento) |
| `container.js` | `nextSessionState/buildSessionCommands/buildIdleCommands/buildRestoreCommands/NEVER_TRIM` |
| `pointer.js` | `pointerOptions/hookOptions/wheelToSwipe/WheelRouter/isInputCommand` |
| `layers.js` | `summary/prune` (inventario y reciclado de capas del contenedor) |

### 7.2 Documentos relacionados

- `docs/ARCHITECTURE.md`: arquitectura y decisiones de diseño orientadas al usuario (incluye los capítulos «modelo de contenedor» y «botones del ratón»);
- `docs/CODE-WALKTHROUGH-PARSE.md`: **recorrido archivo por archivo de la pila de análisis sin conexión** (zip / AXML / ARSC / PNG / apk / shortcut / assoc / version / logfile / display), con las firmas de interfaz de cada archivo, puntos delicados con número de línea, puntos de llamada, cobertura de pruebas y perfil de memoria;
- `docs/CODE-WALKTHROUGH-RUNTIME.md`: **recorrido archivo por archivo de la pila de descarga/despliegue/actualización** (sources / download / provision / updater / store / layers / notify / android), con selección entre dobles fuentes, mezcla de bloques de distintas fuentes, reanudación, reglas de rutas, script de sobrescritura en actualizaciones y una tabla de 14 consultas rápidas de problemas de despliegue.

### 7.3 Partes que solo se pueden verificar en equipo real (fuera del alcance del sandbox/CI)

- Flujo completo de arranque y ausencia de fugas de ventanas: `tools/check-windows.js`, `check-console.js`, `check-launch-clean.js`, `check-quit-clean.js`;
- Tiempos de arranque en frío/en caliente: `tools/e2e-boot.js` (datos históricos: arranque en frío ~23 s, con instantánea ~5 s, extremo a extremo con detección previa 30,7 s / 13,7 s);
- Cadena de actualización: `tools/check-update.js` (API real de GitHub + script real de sobrescritura);
- Botones del ratón, incrustación y giro de pantalla: `test/pointer-hook-logic.ps1`, `test/embed-probe*.ps1`, `test/win-*.ps1`.
