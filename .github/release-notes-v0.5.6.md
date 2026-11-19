# ApkBuddyStart v0.5.6

Esta versión hace una sola cosa, pero la hace a fondo: **eliminar por completo toda la cadena de «bases de emuladores de terceros»**.

A partir de esta versión, ApkBuddyStart **funciona de forma autónoma pase lo que pase**: solo usa su propio adb / emulator / imagen del sistema; no detecta, no toma el control, no acciona ni depende de ningún emulador instalado en tu equipo (no se conecta a MuMu / LDPlayer / BlueStacks / WSA / FydeOS).

La 0.5.5 ya había conseguido «no incluir emuladores de terceros en el paquete y usar el runtime propio por defecto», pero el código aún conservaba las tres bases mumu / fydeos / attach y la lógica de «si no está disponible, revertir». Mientras esa vía siga existiendo, basta con que el usuario cambie un ajuste o importe un `settings.json` antiguo para que ApkBuddyStart vuelva a accionar el emulador de otro: no queda claro dónde acaban los datos, las partidas y las imágenes, y la otra parte deja de funcionar en cuanto actualiza o cambia de puerto. Esta versión desmonta esa vía, no solo la desactiva.

---

## 1. Un único runtime

- `src/core/backends/` ahora solo contiene `base.js` / `builtin.js` / `index.js`: se eliminan `mumu.js` (842 líneas), `fydeos.js` (365 líneas), `mumu-compat.js` y `frame.js`.
- El registro queda fijado en `['builtin']`; `create()` **ignora deliberadamente `settings.engine.mode`**: los restos de `mode=mumu`, `fydeos`, `attach` y cualquier valor escrito a mano crean siempre el runtime incluido.
- Se acabó la «selección automática»: no se buscan directorios de instalación de emuladores de terceros, ni el registro, ni puertos adb. `autoPick()` devuelve directamente builtin y el código no llama a `probe()` ni una sola vez.
- Se elimina además un riesgo: las rutas candidatas de `adb` antes incluían los adb incluidos en MuMu / LDPlayer / BlueStacks. Usarlos heredaba el estado del servidor ajeno (puerto, autorización, parpadeos de offline); ahora solo se reconoce el Android SDK y los directorios de instalación manual, y el nuestro va siempre primero.

## 2. Una configuración antigua no puede traer de vuelta a terceros

- `store.getSettings()` fuerza `engine.mode = 'builtin'` al leer de disco y elimina los campos residuales `mumuPath / mumuIndex / mumuRenderProfile / mumuMemoryGB / mumuCores / fydeosHost`.
- Solo se modifica el objeto en memoria y no se vuelve a escribir de inmediato: el archivo de ajustes es del usuario y se guardará naturalmente la próxima vez que este guarde sus ajustes.
- Se retiran también el marcador de respaldo `_fallbackFrom`, la bifurcación `backendAvailable()`, la rama `attach` y `ATTACH_ENDPOINTS` (los puertos fijos de WSA / LDPlayer / MuMu / Nox / MEmu).

## 3. La página de ajustes es más simple

- Se elimina el desplegable «modo de motor» y se sustituye por una línea de texto de solo lectura: *ApkBuddyStart incluye su propio runtime (QEMU + Android 14, funcionamiento autónomo)*.
- Se eliminan los cuatro grupos de controles «directorio de instalación de MuMu», «dirección de FydeOS», «dirección del dispositivo + botón de sondeo» y «asignación de recursos de la instancia MuMu».
- La memoria / los núcleos de CPU / la partición de datos se pueden seguir asignando a mano (es lo que añadió la 0.5.5, mediante parámetros de qemu y sin relación con terceros); los límites siguen calculándose según la memoria del anfitrión, el número de núcleos y el espacio libre en disco.

## 4. Guarda de compilación más estricta

`build/guard-standalone.js` antes solo bloqueaba «binarios y directorios de emuladores»; ahora también bloquea **el código fuente de los adaptadores**: si aparece cualquiera de `backends/mumu.js`, `backends/fydeos.js`, `core/mumu-compat.js` o `core/frame.js` en el resultado del empaquetado, la compilación termina con `exit(4)`.
Así, «volver a dejar una vía para tomar el control de emuladores ajenos» no puede colarse en el paquete sin que se note.

## 5. Verificación

- Suite completa de pruebas solo con Node: **258 pruebas superadas**; `scripts/selftest.js` contra un `emulator-5554` real en ejecución: **9/9 superadas** (dispositivo, versión de Android, resolución, freeform y sincronización bidireccional de la carpeta compartida).
- Las pruebas de funcionamiento autónomo pasan de 15 a 22, y añaden: el registro solo contiene builtin, varios valores residuales de mode solo crean builtin, un `id=mumu` explícito no puede imponerse, los archivos de módulos de terceros no deben existir, la página de ajustes ya no tiene desplegable de motor, la capa de persistencia reescribe los campos obsoletos, los candidatos de adb no incluyen adb de terceros y la guarda bloquea el código de los adaptadores sin afectar a `builtin.js`.

## Notas de actualización desde 0.5.5

- `0.5.6.0 > 0.5.5.0`; la Store puede sobrescribir la actualización directamente.
- Se conservan las aplicaciones Android, las partidas guardadas y las instantáneas quickboot ya instaladas; no hace falta reinstalar.
- Quienes hubieran cambiado el motor a MuMu / FydeOS / attach: tras actualizar se vuelve automáticamente al runtime incluido y la página de ajustes muestra la descripción del runtime en solo lectura; el primer arranque puede tardar una decena de segundos más porque hay que volver a arrancar el runtime incluido.
- Las aplicaciones y los datos de cuando usabas un emulador de terceros están allí, no aquí; si los necesitas, vuelve a arrastrar el APK para instalarlos.

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.6.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Materiales de envío: `docs/store-listing.md` (incluye el texto «What's new» de esta versión en español e inglés)
- Pasos: `docs/store-upload-walkthrough.md`
