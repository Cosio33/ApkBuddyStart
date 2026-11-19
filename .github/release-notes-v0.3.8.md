# ApkBuddyStart v0.3.8

> En una frase: se añade una **bonita tarjeta de bienvenida al arrancar** (que te avisa de que todo está listo al iniciarse automáticamente con el sistema), se corrige que **algunos usuarios no podían comprobar las actualizaciones**, se añade la **limpieza de restos de versiones antiguas** y se renueva por completo la estética de la interfaz.

## 1. Novedad: tarjeta de bienvenida al arrancar

Al iniciarse automáticamente con el sistema o al abrir ApkBuddyStart, aparece una tarjeta de bienvenida ligera:

- Arriba, una cabecera con el degradado de la marca y un saludo dinámico (buenos días / buenas tardes / es tarde…);
- Tres indicadores de un vistazo: **aplicaciones instaladas / estado del runtime de Android / puerto del dispositivo**;
- Dos consejos útiles para el momento: si no hay aplicaciones instaladas, enseña a instalarlas; si las hay, enseña a manejar las ventanas;
- Cuando hay una versión nueva, se avisa aquí directamente, sin mostrar además una burbuja en la esquina inferior derecha;
- Abajo se puede marcar **«No mostrar automáticamente la próxima vez»** o pulsar «Abrir ajustes».

Reglas de aparición: al iniciarse automáticamente con el sistema, siempre; al abrir manualmente, como máximo una vez al día; si se marca la casilla, nunca más.

## 2. Corrección: algunos usuarios no podían comprobar las actualizaciones

**Causa**: la información de versiones dependía de las API de dos servicios. La API anónima de GitHub solo permite 60 peticiones por IP y hora; la de Gitee es aún más estricta y, en pruebas, devuelve `403 Rate Limit Exceeded` tras unas pocas peticiones seguidas. En redes de empresa / campus / con NAT del operador, es fácil que ambos servicios limiten la frecuencia y la interfaz solo muestre «error al comprobar actualizaciones».

**Corrección**:

- Se añade un **respaldo que no depende de la API**: seguir directamente la redirección 302 de `releases/latest` para obtener el número de versión (por CDN, sin consumir cuota de API) y luego componer la URL de descarga según la convención de publicación;
- Se admiten las URL canónicas `/releases/download/<tag>/<nombre de archivo>` tanto de GitHub como de Gitee (en pruebas, Gitee redirige 302 al enlace directo del archivo y se descargan todos los bytes);
- Cuando falla la comprobación, la interfaz ya no queda en blanco, sino que ofrece un botón **«Abrir página de descargas»**; `app:updateOpen` ahora también permite `gitee.com`, para que los usuarios de China no se queden fuera.

## 3. Novedad: limpiar restos de versiones antiguas

Ajustes → Integración con el sistema → **«Limpiar restos de versiones antiguas»**:

- Analiza los **directorios de versiones antiguas del programa** (como `ApkBuddyStart-vX.Y.Z-win64-portable` en el mismo directorio, y que contengan de verdad `ApkBuddyStart.exe`; nunca toca la versión que se está ejecutando);
- Analiza las **entradas de desinstalación del registro ya invalidadas** (entradas huérfanas cuya `InstallLocation` o cuyo desinstalador ya no existen);
- Analiza los **paquetes temporales que dejan las actualizaciones** (`%APPDATA%\apkstart\update` y `ApkBuddyStart-*.zip` en directorios temporales, etc.);
- Primero muestra la lista y el espacio liberable, y solo borra tras confirmar; informa con honestidad de «cuántos elementos estaban en uso y no se pudieron borrar».

Se limpia solo aquello cuya seguridad se puede demostrar: **no se tocan los datos del usuario ni la versión actual**.

## 4. Ocultar las ventanas emergentes molestas del arranque

- Se elimina la notificación del sistema «nueva versión encontrada» al arrancar; todo se unifica en la tarjeta de bienvenida;
- Antes los avisos de arranque estaban repartidos entre varios toast / burbujas; ahora solo está esta tarjeta;
- Se mantiene la supresión de la ventana negra de consola (las ventanas de consola del emulador / netsimd / adb siguen ocultándose).

## 5. Renovación de la interfaz

- Nueva paleta de colores: verde esmeralda de marca + fondo neutro suave, con un halo de marca muy tenue en el fondo;
- La barra de título adopta un acabado de **cristal esmerilado**, y el icono de ventana se sustituye por una marca vectorial (a tamaño pequeño se sigue reconociendo como un «botón de reproducción», en lugar de un bloque oscuro borroso);
- Tarjetas de aplicación: esquinas más redondeadas, elevación al pasar el ratón + contorno del color de marca e iconos con sombra;
- Botones: degradado + brillo interior en el principal, y los secundarios más ligeros;
- Ventanas modales, títulos de grupo, barras de desplazamiento y barra de estado rediseñados de forma coherente;
- La tarjeta de bienvenida usa el mismo lenguaje visual (cabecera con degradado + halo + textura de puntos).

## 6. Pruebas reales

- `npm test`: **113 pruebas, todas superadas** (8 + 25 + 80).
- Verificación con capturas de humo: la interfaz principal y la tarjeta de bienvenida se renderizan con normalidad (ver capturas en la página de versiones).
- «Limpiar restos de versiones antiguas» detecta en el equipo de desarrollo 6 directorios de versiones antiguas, unos 1,3 GB, y excluye correctamente la versión en ejecución.

## 7. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
