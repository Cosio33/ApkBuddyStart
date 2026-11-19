# ApkBuddyStart v0.4.3

> En una frase: se cambia **rotación / pantalla completa** de «modificar la resolución del runtime» a «cambiar el tamaño físico del panel», y por fin la horizontal queda **derecha y a pantalla completa**; además se corrige la lentitud general del equipo y se añade el **modo juego / baja latencia** (preparando el terreno para FPS).

## 1. Rotación / pantalla completa: ahora sí queda derecha y llena la pantalla

### Por qué antes nunca funcionaba bien

La imagen del emulador viene de un «panel LCD físico»: Qt abre la ventana según el tamaño del panel y pega la imagen en la esquina superior izquierda. Los tres enfoques anteriores eran caminos equivocados, y cada uno correspondía a un fenómeno que se veía en tus capturas:

| Enfoque | Resultado |
|---|---|
| Cambiar `wm size` en tiempo de ejecución | Solo cambia la resolución lógica de Android; el panel físico sigue en vertical → imagen **tumbada 90°**, que solo ocupa una franja en la esquina superior izquierda y con coordenadas de clic desplazadas |
| Cambiar `wm density` en tiempo de ejecución | El tamaño del framebuffer no cambia → la imagen **no llena**, y queda una gran zona en blanco a la derecha al maximizar |
| `adb emu rotate` | Solo gira el contenido de la imagen; el sistema sigue en vertical |

### Cómo se hace ahora

**Rotar = cambiar `hw.lcd.width/height` y reiniciar el emulador** (unos 30–60 s, y solo ocurre una vez al pulsar rotar):

- Panel vertical `720x1280`, panel horizontal `1280x720`;
- Al mismo tiempo se fija el bloqueo de orientación con `wm user-rotation` (horizontal bloquea 1, vertical bloquea 0) y se desactiva la rotación automática por sensor: si el panel pasa a horizontal pero la rotación sigue siendo 0, la imagen se tumba;
- La orientación se guarda en los ajustes y al volver a abrir ApkBuddyStart se arranca con esa orientación;
- **El botón de pantalla completa = pasar a horizontal**: se maximiza la ventana y se gira el panel físico, en lugar de estirar la imagen vertical.

### Dos bugs reales que se corrigen de paso

1. **`-no-skin` anulaba `-skin`**: los parámetros de arranque llevaban ambos a la vez, y `-no-skin` hacía que el tamaño del panel volviera al valor antiguo de `config.ini`. Esa es la causa directa de «cambié a horizontal en los ajustes pero sigue en vertical». Se eliminó `-no-skin`.
2. **Al maximizar no llenaba**: al maximizar Electron, la ventana del anfitrión pasa a 1936×1048, pero la capa de renderizado de Chrome interna se queda en el tamaño antiguo (medido: 532×984), y la ventana del emulador cuelga de esa capa y queda recortada por la ventana padre. Ahora `Fit` **estira primero la capa de renderizado a todo el área de cliente del anfitrión** y luego pega el emulador con ese tamaño; el escaneo de ventanas también se autosana una vez por ronda, para recuperarse incluso si se pierde el evento de redimensionado de JS.

## 2. Lentitud: tres focos de sobrecarga que ralentizaban todo el equipo

1. **Frecuencia del escaneo de ventanas**: antes, durante los primeros 90 s de arranque, se enumeraban todas las ventanas del escritorio cada 120 ms (4 llamadas a `EnumWindows` + consulta de rutas de proceso por ronda), consumiendo CPU sin parar. Ahora es 250 ms durante los primeros 10 s y **1500 ms** después; el modo juego lo reduce aún más a **3000 ms**.
2. **Prioridad del emulador**: el valor predeterminado, balanced, baja qemu a BelowNormal, e incluso a **Idle** (lo más bajo) al cerrar la aplicación, lo que provocaba pérdidas de fotogramas graves en Android. Ahora, al cerrar la aplicación, ya no se baja a Idle sin condiciones.
3. **Gancho global del ratón**: `WH_MOUSE_LL` callback de forma síncrona cada evento de ratón del escritorio, aumentando notablemente la latencia del puntero. **En modo juego no se instala en absoluto.**

## 3. Novedad: modo juego / baja latencia

Ajustes → Rendimiento y recursos → **Prioridad de la máquina virtual → «Juego / baja latencia»**:

- Sube el proceso del emulador a prioridad **High**, para que el renderizado y la entrada de Android tengan prioridad de CPU;
- Desactiva el gancho global del ratón, de modo que el puntero use la ruta de entrada nativa;
- Reduce el escaneo de ventanas a 3000 ms, para molestar menos desde el anfitrión;
- La estrategia de recursos «fluida» ahora también entra directamente en este modo (prioridad para vídeo / juegos).

El coste es que los demás programas del equipo van algo más lentos, por lo que el valor predeterminado sigue siendo «equilibrado».

## 4. Refuerzos varios

- `settings.json` ahora tolera **BOM UTF-8**. Antes, en cuanto el archivo llevaba BOM, `JSON.parse` lanzaba un error y toda la configuración volvía silenciosamente a los valores por defecto: el usuario veía «se perdieron todos mis ajustes» sin poder averiguar por qué (me pasó en mis propias pruebas).
- Nuevas pruebas de regresión: la horizontal debe usar `lcdFor({landscape})` y no volver a `wm size` en tiempo de ejecución; el modo ventana debe usar `-skin` y no llevar `-no-skin`; el modo juego debe ser High y no instalar el gancho global.

## 5. Pruebas reales

- `npm test`: **117 pruebas, todas superadas** (8 + 25 + 84).
- Horizontal medido: `wm size` = `Physical size: 1280x720`, `user_rotation=1`; la imagen del invitado está **derecha, con la maquetación correcta y sin bordes negros**; al maximizar, el área de cliente del anfitrión es 1920×1032 y la capa de renderizado se estira a juego.
- Vertical medido: `720x1280`, `rotation=0`, imagen derecha y a pantalla completa.

## 6. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
