# ApkBuddyStart v0.4.1

> En una frase: se localiza y se erradica el grupo de síntomas «borde negro al rotar / la aplicación no llena / los clics no funcionan / no se puede pulsar aceptar»: en realidad todos tenían **la misma causa**: la ventana del emulador incrustada y la capa web de Electron son ventanas hermanas, y la capa web está siempre por delante.

## 1. La causa raíz real

Usando `WindowFromPoint` para hacer una prueba de impacto en el centro de la imagen, se descubre que lo que devuelve **no es la ventana del emulador**, sino `Chrome_RenderWidgetHostHWND` (la capa de renderizado web de Electron).

Es decir, el fondo negro de la capa web seguía cubriendo la imagen de Android y se comía todos los eventos del ratón. Por eso aparecían a la vez:

| Lo que ve el usuario | Causa real |
|---|---|
| La imagen tiene bordes negros / no llena | El fondo negro de la capa web tapa la imagen incrustada, o solo deja ver una parte |
| Los clics no funcionan / no corresponden | El ratón hace clic en la capa web y nunca llega a Android |
| No se puede pulsar «Aceptar y continuar» | Igual que arriba (`adb input tap` sí funciona, porque usa coordenadas lógicas y se salta el anfitrión) |
| Más evidente tras rotar / pantalla completa | Cambiar el tamaño de la ventana provoca un redibujado de Chromium, que se vuelve a traer al frente |

Antes, en v0.3.9, yo usé `SetWindowRgn` para recortar aquella franja de 8 px de la barra de título, y eso **rompió la prueba de impacto de las ventanas hijas Qt/GL** e hizo que la región no coincidiera con el tamaño de la ventana tras un redimensionado: esa es la fuente directa del problema de esta versión.

## 2. Corrección

1. **Se elimina el recorte con `SetWindowRgn`** y, en su lugar, al hacer `Embed()` se limpia explícitamente cualquier región residual de versiones antiguas. El desbordamiento bajo la barra de título lo cubre naturalmente la barra de título dibujada por el anfitrión.
2. **Se cuelga la ventana del emulador como ventana hija de la capa de renderizado web** (en lugar de ser una ventana hermana del anfitrión). El orden Z y la detección del ratón de una ventana hija tienen prioridad natural sobre los de la ventana padre, así que la capa web nunca vuelve a tapar la imagen ni a comerse los clics.
   - En el momento de incrustar, la capa web quizá aún no exista; por eso se vuelve a colgar tanto en `Fit()` como en el escaneo permanente, para garantizar que surta efecto.
3. **Se restringe `HideStrayWindows`**: solo oculta los tipos de ventana claramente emergentes (ventanas de herramientas Qt / consola) y nunca toca `QWindowIcon` / `subWin` (que es la LCD que se está mostrando), para no ocultar por error la imagen y dejarla toda negra.
4. **Tras terminar el arranque, se trae la ventana al frente** (topmost momentáneo que luego se retira): evita que otras ventanas (navegador, etc.) queden encima y provoquen «pantalla negra + clics que no funcionan».
5. **Tamaño de la ventana al rotar**:
   - En estado maximizado `setContentSize` no hace nada; ahora primero se llama a `unmaximize` y luego se cambia el tamaño; si no, la imagen horizontal se mete en una ventana vertical = bordes negros / imagen que no llena;
   - El tamaño objetivo se limita al área útil de la pantalla;
   - Tras cambiar `wm size`, Qt vuelve a reorganizar la ventana varias veces; ahora se hacen 6 rondas consecutivas de `Fit` para convergir y eliminar por completo los bordes negros residuales.

## 3. Pruebas reales (esta vez interacción real de extremo a extremo, no simulación con adb)

- Con un **ratón real** se pulsa «Aceptar y continuar» → se entra en `MainFragmentActivity` → se sigue hasta la página de reproducción `ShortSeriesActivity`;
- Captura de la ventana del anfitrión con `PrintWindow`: la imagen de Android **llena toda el área por debajo de la barra de título, sin bordes negros ni espacios en blanco alrededor**; vídeo / me gusta / comentarios / episodios / los cuatro botones de la barra de título, todo funciona con normalidad;
- `WindowFromPoint` en el centro de la imagen devuelve la ventana del emulador (antes de la corrección devolvía la capa web);
- `npm test`: **115 pruebas, todas superadas** (8 + 25 + 82); se añaden dos pruebas de regresión que fijan que «la ventana incrustada debe colgarse bajo la capa web y no debe tener región».

## 4. Refuerzo de ingeniería

- `agent.ps1` mantiene la BOM UTF-8 (perderla hace que PowerShell 5.1 lea los comentarios en chino como ANSI y falle la compilación de `Add-Type` → fallo al iniciar el proxy de ventanas);
- Nuevas pruebas de regresión: verifican que existan `SetParent(emu, parent)` / `FindChromeRender`, que no exista `CreateRectRgn(0, clipTop)` y que se limpie la región al incrustar.

## 5. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
