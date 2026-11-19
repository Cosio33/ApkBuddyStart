## ¿Qué resuelve esta versión

### 1. Abrir ApkBuddyStart hacía desaparecer las ventanas de WeChat (y de otras aplicaciones Qt)

Era el problema más grave de la versión anterior. El proxy de ventanas identificaba las suyas por el **nombre de clase de ventana**:

- `FindEmulator()` reconocía las ventanas cuyo «nombre de clase contiene `QWindowIcon`»; ese es el nombre de clase de **todas las ventanas de nivel superior de Qt**;
- `HideToolWindows()` reconocía las ventanas cuyo «nombre de clase contiene `QWindowTool`», y los menús, paneles de emojis y ventanas flotantes de Qt usan justamente `QWindowToolSaveBits`;
- la supresión periódica escaneaba cada 120 ms y, al encontrar una, hacía `ShowWindow(h, 0)`; `embed` / `park` también le aplicaban `SetParent`.

WeChat 4.x resulta ser Qt 6 (el `Weixin.dll` contiene las cadenas `QWindowToolSaveBits` / `Qt6`), y el nombre de clase de su ventana principal es `Qt51514QWindowIcon`, **idéntico al del emulador**. Por eso ocurría eso de «abro ApkBuddyStart y la ventana de WeChat desaparece / se incrusta en ApkBuddyStart convertida en un bloque negro».

**Comparación real en la misma máquina** (WeChat 4.1.7.59, ventana principal de 296×388):

| Versión | Estado de la ventana de WeChat |
|---|---|
| 0.3.3 | `hidden` a los 3,7 s de iniciar; las 74 muestras posteriores, todas ocultas |
| 0.3.4 | `visible` durante todo el proceso, a los 45 s y a los 280 s; 0 veces oculta |

**La solución: el nombre de clase no es una identidad, la ruta del proceso sí.**

- Se añade el comando `scope`: el proceso principal envía «nuestro directorio» (raíz del runtime y el directorio `engine` incluido en el paquete) y el pid del proceso principal antes de suprimir o incrustar ventanas;
- Toda decisión sobre ventanas pasa primero por `IsOurs(pid)`: el ejecutable del proceso debe estar dentro de esos directorios;
- **sin scope no se toca ninguna ventana**: antes preferimos dejar pasar una ventana negra que ocultar la de otro;
- La consola negra ya no se detecta con una coincidencia difusa del tipo «el título contiene emulator/qemu/netsim», sino comprobando que la cadena de procesos padres de conhost llega al directorio del runtime, o que el título contiene la ruta absoluta de dicho directorio;
- `embed` verifica que el pid de la ventana anfitriona sea igual al del proceso principal; si no, se rechaza (evita incrustar la ventana en otra aplicación tras reciclar un identificador);
- En el gancho del ratón se añaden la comprobación `IsWindow(_host)` y la del pid anfitrión; si el identificador deja de ser válido, se deja pasar todo;
- La rotación (Ctrl+←/→) solo envía la tecla global cuando nuestra ventana está en primer plano; si no, simplemente no la envía;
- Cuando se recrea el proceso proxy, se vuelve a enviar el scope; si no, el nuevo proxy no se atrevería a tocar nada.

### 2. Gitee también ofrece un paquete íntegro que se descomprime con doble clic (ya no son part1/part2)

- Se cambia el compresor: de `Compress-Archive` (deflate de .NET) a 7-Zip `-mx=9`; en el mismo directorio **105,2 MB → 99,8 MB**;
- Se elimina `d3dcompiler_47.dll` del paquete (desde Windows 8.1 el `System32` incluye una DLL con el mismo nombre; en pruebas el renderizado no cambia), ahorrando otros 2,1 MB; `vk_swiftshader` / `vulkan-1` se mantienen como respaldo cuando el driver GPU no está disponible;
- Resultado final: **95,0 MiB**, por debajo del límite de 100 MB por archivo de Gitee; se descarga y se descomprime directamente;
- Se añade `build/zip.js`: tras comprimir, usa el propio analizador de zip de la aplicación para verificar el número de entradas y los bytes totales descomprimidos,
  y **hace fallar la CI de inmediato si se superan los 100 MiB**: en el futuro, si el paquete engorda, se detectará al momento y no se volverá a recurrir silenciosamente a los fragmentos.

### 3. La «selección automática de la mejor fuente» en realidad no funcionaba

Los archivos con el mismo nombre se deduplicaban por nombre y se usaba el primero en llegar; como GitHub iba primero, **la dirección de Gitee con el mismo nombre se descartaba directamente**. Al dejar de fragmentar el paquete íntegro, eso significaba usar siempre GitHub.

- Los archivos con el mismo nombre ahora fusionan sus `urls` y registran el `size` por dirección (los bytes generados por cada fuente son distintos);
- Antes de descargar se mide la velocidad y se elige la mejor; la regla de `downloadMulti` de «solo mezclar fuentes que declaren el mismo tamaño» pasa a usar como referencia el tamaño total de **la fuente más rápida** (antes se tomaba `Math.max` fijo, lo que equivalía a descargar siempre la fuente más grande);
- En pruebas, de los cuatro candidatos de esta máquina (conexión directa a GitHub / ghfast / gh-proxy / Gitee), el más rápido fue Gitee: 95,2 MB en 48 s (unos 2 MB/s).

### 4. Otros

- La «guarda de ventanas» del proxy solo reconoce procesos de su propio runtime; otros emuladores (MuMu / el emulator.exe incluido en LDPlayer) ya no hacen que el proxy siga guardando ventanas 3 minutos más;
- Los scripts de herramientas (`check-agent` / `check-console` / `check-windows` / `check-launch-clean` / `check-quit-clean`) también se actualizan con el scope.

## Registro de verificación

| Elemento | Resultado |
|---|---|
| Pruebas unitarias + de integración | run-tests 3 / auto-test: **70 superadas, 0 fallidas** |
| Extremo a extremo (runtime real + AVD real + APK de Hongguo) | Instalar → abrir → incrustar, todo superado; ventana de la aplicación en 0,5 s; ventanas fugadas acumuladas: **0** |
| Convivencia con WeChat (4.1.7.59) | Durante arranque del emulador / instalación / incrustación, ventana de WeChat oculta **0** veces |
| Paquete íntegro en Gitee | 95,18 MiB; `Expand-Archive` descomprime en 5,2 s; md5 de 69 archivos coincidentes con el directorio de origen |
| Descarga real desde Gitee | 95,2 MB en 48 s; estructura zip íntegra |

## Descarga

- Versión ligera `ApkBuddyStart-v0.3.4-win64-portable.zip` (**95 MB**, descomprimir y usar; el runtime se descarga en el primer inicio):
  GitHub y Gitee ofrecen **un único zip completo**, ya no hay que unir fragmentos.
- Versión completa `ApkBuddyStart-0.3.4-Setup.exe` (unos 1,35 GB, incluye adb / emulador / imagen del sistema; usable sin conexión tras instalar):
  supera el límite de 100 MB por archivo de Gitee, así que solo está en GitHub.
