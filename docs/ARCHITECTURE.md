# Arquitectura

## Capas

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Capa de presentación  src/ui (HTML/CSS/JS)  ←→  preload (contextBridge)      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Capa de orquestación  src/main.js (ventanas/bandeja/dispatcher CLI)          │
│                       installer.js (canalización de instalación)            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Capa de dominio  engine.js (ciclo de vida/detección/reciclado en inactividad)│
│                  adb.js (operaciones con el dispositivo)                    │
│                  sharer.js (intercambio de archivos)                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Análisis sin conexión  zip.js → axml.js / arsc.js → apk.js                   │
│                        png.js / shortcut.js (iconos y accesos directos)      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Adaptación de motores  QEMU integrado (WHPX/TCG) │ Importar imagen del      │
│                        sistema │ Ejecución existente (opcional)              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Flujos clave

### 1. Instalación con doble clic en un APK

```
Explorer: doble clic en .apk
  → HKCU\Software\Classes\ApkBuddyStart.apk\shell\open\command
  → ApkBuddyStart.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js: análisis sin conexión (zip → AXML del manifiesto → arsc recupera label/icon)
      2. engine.ensure(): si la ejecución no está lista, se inicia/detecta automáticamente
      3. adb install -r -g -t
      4. Icono → PNG (icons/) + ICO de varios tamaños (icons/*.ico)
      5. shell.writeShortcutLink crea el .lnk del escritorio (--launch <pkg>)
      6. store.upsertApp registra los metadatos
```

### 2. Arranque desde el icono del escritorio (experiencia nativa)

```
Doble clic en <nombre-de-app>.lnk
  → ApkBuddyStart.exe --launch <pkg>
  → El bloqueo de instancia única se fusiona con la instancia ya en ejecución (o se inicia una nueva en silencio)
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → Ventana freeform independiente
  → La ventana de la carcasa se oculta/sale automáticamente, sin dejar interfaces sobrantes
```

### 3. Intercambio de datos

```
Equipo local %USERPROFILE%\ApkBuddyStartShared  ⇄  Android /sdcard/ApkBuddyStartShared
  Sincronización bidireccional incremental (según mtime+size), sondeo cada 8 s + disparo en acciones clave
```

## Por qué no usar librerías existentes

| Necesidad | Enfoque habitual | Enfoque de ApkBuddyStart | Motivo |
|---|---|---|---|
| Leer metadatos del APK | aapt2 / apk-parser | zip + AXML + ARSC escritos a mano | Tamaño sin dependencias, sin instalar SDK, arranque sin procesos externos |
| Convertir iconos a ICO | ImageMagick / sharp | Escalado con nativeImage + contenedor ICO escrito a mano | Evitar una dependencia nativa de 80 MB |
| Asociación de archivos | El instalador escribe HKLM | HKCU + SHChangeNotify | Sin administrador y se puede activar/desactivar en ajustes cuando se quiera |
| Emulador | Incluir VirtualBox completo | Capa de adaptación de motores | Reutilizar una ejecución existente sin coste; la vía QEMU conserva una opción de imagen de sistema controlable |

## Diseño de estabilidad

- Todas las llamadas a adb llevan tiempo de espera y normalización de errores (AdbError).
- La detección de la ejecución se hace en paralelo, con 4 s de tiempo de espera y degradación automática en caso de fallo.
- Perro guardián de inactividad de QEMU: solo se recicla si no hay ninguna app en primer plano y se supera el número de minutos configurado; si hay una app en ejecución, nunca se recicla.
- Las escrituras de ajustes y del manifiesto de aplicaciones usan escritura atómica tmp+rename.

## Modelo de contenedor a nivel de aplicación (rendimiento)

### Límites frente a un «contenedor real»

Zhuoyitong de Huawei / WSA / Anbox son **contenedores o capas de compatibilidad**: comparten el kernel del host con el guest,
los servicios del sistema se inician bajo demanda y, en teoría, se podría cargar solo aquellos servicios de los que depende una determinada app.
La base de ApkBuddyStart es Google Android Emulator (virtualización completa del sistema con QEMU):
el kernel de Linux, zygote y system_server deben arrancar una vez como un todo; **no se puede «cargar únicamente los servicios del sistema que necesita una app»**, y esto no se puede sortear con código de la capa superior.

Pero la sensación de «pesado» del usuario no viene de esos servicios residentes, sino de otras cuatro cosas.
Si se resuelven, la experiencia equivale a «abrir solo el entorno que necesita la app»:

| Carga real | Cómo se aborda | Dónde se implementa |
| --- | --- | --- |
| Cada vez que se abre una app hay que arrancar Android por completo (40~142 s, CPU/disco al máximo) | El entorno se arranca una sola vez y permanece; el qemu desacoplado sigue vivo tras salir ApkBuddyStart, y la siguiente vez `adoptExisting()` toma el control junto con la instantánea quickboot, de modo que abrir una app solo hace `am start` + enganchar la ventana | `engine.js` / `emulator.js` |
| Las apps abiertas antes se quedan en segundo plano consumiendo memoria y red | Al abrir una app nueva, `am force-stop` detiene las demás apps del usuario; al cerrar la última ventana, `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu compite por la CPU con el escritorio de Windows con prioridad Normal | Tras el arranque baja a `BelowNormal` y a `Idle` cuando el contenedor está aparcado; las vCPU se reducen a un cuarto de los núcleos físicos (2~3 núcleos) | `win/priority.ps1` / `doctor.liteProfile()` |
| Sin apps abiertas, la sincronización, las notificaciones y la inspección de ventanas siguen sondeando a toda velocidad | La sincronización de archivos y el puente de notificaciones solo se activan cuando hay ventanas de apps; la inspección de ventanas se limita a los 8 s posteriores al enganche; el bucle principal del socket pasa a sondeos cortos de 50 ms | `main.js` / `win/agent.ps1` |

### Sobre «traducir APK a x86»

Este paso **no se hace cada vez que se abre una app**, y ya está integrado:
- La imagen del sistema es x86_64, así que los APK nativos x86 se ejecutan directamente;
- los APK que solo son ARM dependen del native bridge de la imagen (la capa de traducción de binarios ARM→x86 incluida en las imágenes de Google Play), que se aplica **en la instalación** y se invoca bajo demanda en tiempo de ejecución;
- por tanto, ApkBuddyStart no necesita —y no debería— volver a «traducir» en cada arranque.
  «Traducir en cada apertura» sería justamente el diseño más lento.

### Causa raíz de la deriva del ratón / las ralentizaciones del equipo (corregido)

`win/agent.ps1` usaba un hook global de ratón de bajo nivel `WH_MOUSE_LL` para implementar «volver con el botón lateral»,
pero lo instalaba en el hilo del servicio de ventanas, que a su vez se bloqueaba en `sock.Poll(4000)`.
Cada evento de ratón de Windows tenía que esperar sincrónicamente a que ese hilo respondiera, hasta 4 segundos;
y el hook no se desinstalaba al cerrar la ventana, así que mientras ApkBuddyStart estuviera vivo ralentizaba todo el sistema.
Sumado al pico de E/S de la primera descompresión de `.xz` / `e2fsck` / `resize2fs`,
el primer plano casi no podía obtener recursos.

Solución:
- El hook ya no queda residente de forma incondicional: solo se instala en un **hilo de mensajes dedicado** (bucle `GetMessage`) y únicamente cuando la ventana de la app está en primer plano y hay al menos una asignación de ratón activa; se desinstala en cuanto se pierde el foco o se cierra la ventana; la devolución de llamada solo procesa 7 mensajes objetivo y cualquier otro (incluidos todos los eventos de clic izquierdo) pasa directamente con un `CallNextHookEx`;
- el bucle principal del servicio pasa de `Poll(4000)` a `Poll(50)`;
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` pasan de «cada 2 segundos para siempre» a
  «durante los 8 s posteriores al enganche, sin forzar el recálculo del área no cliente»;
- el primer despliegue se retrasa 20 segundos para no competir por la E/S con el arranque en frío.

### Botones del ratón (clic izquierdo para confirmar / clic derecho para volver / rueda para desplazarse)

Dentro de la ventana de la app se incrusta la ventana hija Qt del emulador; la asignación nativa es la siguiente:

| Entrada | Comportamiento nativo de Qt | Cómo lo gestiona ApkBuddyStart |
| --- | --- | --- |
| Clic izquierdo | Toque con el dedo / mantener y arrastrar = deslizar | **No se intercepta en absoluto**, pasa directamente; esto es la «confirmación» |
| Clic derecho | También se trata como un clic, con riesgo de pulsaciones accidentales | Intercepta `WM_RBUTTONDOWN/UP/DBLCLK` y envía `input keyevent 4` (volver) |
| Rueda | Cada muesca envía un evento táctil por separado y la imagen se sacude | Intercepta `WM_MOUSEWHEEL/MOUSEHWHEEL` y las agrupa en una sola `input swipe` en una ventana de 60~90 ms |
| Botones laterales | Ninguno | Opcional: asignarlos a volver / avanzar (desactivado por defecto) |

La agrupación de la rueda ocurre en `win/agent.ps1` (`PushWheel` / `FlushWheel`) y la traducción en
`core/pointer.js` (`WheelRouter` → `wheelToSwipe`). La inyección usa el **`adb shell` persistente** de `AdbClient.input()`,
con `echo __APKSTART_<id>__` como respuesta y control de flujo, de modo que no se lanza un proceso adb por cada muesca de la rueda
ni los comandos de deslizamiento se acumulan en la cola del shell.
Las coordenadas se asignan según la posición normalizada del cursor dentro de la LCD; el desplazamiento horizontal genera un swipe horizontal y la resolución se actualiza automáticamente al girar la pantalla.

El hook solo se instala cuando la ventana de la app está en primer plano; al volver al escritorio o cerrar la ventana se desinstala. Si desactivas las tres opciones —volver con clic derecho, rueda suave y botones laterales—, no se instala ningún hook global.

### Opciones configurables (Ajustes → Botones del ratón / Rendimiento y contenedor ligero)

| Opción | Valor predeterminado | Descripción |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | Clic derecho = volver en Android; al desactivarlo se recupera el comportamiento Qt de «el clic derecho también cuenta como clic» |
| `engine.mouseWheelMode` | `smooth` | `smooth` agrupa e inyecta / `native` deja que Qt procese muesca a muesca / `off` no intercepta |
| `engine.mouseSideButtons` | `false` | Botones laterales para volver / avanzar; si las tres opciones están desactivadas no se instala ningún hook global |
| `engine.liteMode` | `true` | Reduce la cuota de vCPU; al desactivarlo se asignan automáticamente más núcleos según la máquina |
| `engine.priorityMode` | `balanced` | Con `performance`, qemu usa prioridad Normal |
| `engine.deepTrim` | `false` | Desactiva además (`pm disable-user`) un conjunto de paquetes en segundo plano del sistema; al desactivar la opción se restauran con `pm enable` |

El recorte profundo evita deliberadamente tocar componentes esenciales como `gms` / `systemui` / webview / el teclado
(véase `container.NEVER_TRIM`), para que las apps que dependen de notificaciones push e inicio de sesión no aparezcan con errores repetidos.

### Ciclo de vida de una sesión

```
Arranque en frío (solo la primera vez, o tras borrar el AVD)
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
Abrir la App A: ensure() toma el control del entorno residente → am start A → enganchar la ventana
            → beginApp(A): detener otras apps del usuario, subir la prioridad, activar sincronización/notificaciones
        ↓
Cambiar a la App B: beginApp(B) → am start B (sin reiniciar Android)
        ↓
Cerrar la última ventana: endApp() → force-stop → am kill-all → deviceidle
            → qemu baja a Idle → se detienen sincronización/notificaciones (contenedor aparcado, sin apagar)
        ↓
Inactividad superior a idleShutdownMinutes: el perro guardián apaga la ejecución
(Las instancias adoptadas antes no se podían reciclar por no tener un handle de proceso local; ya está corregido)
```
