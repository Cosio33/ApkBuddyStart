# Notas de la versión v0.3.5 de ApkBuddyStart

> Esta versión corrige, sobre la base de la v0.3.4, una serie de defectos confirmados en la revisión de código; todos han sido probados en la máquina local.

## ¿Qué resuelve esta versión

### 1. No se pueden instalar APK de más de 2 GB (#21)
La versión anterior leía todo el archivo en memoria al analizar el APK; con más de 2 GB se topaba directamente con el límite de un único búfer de Node. El síntoma era «haces clic en instalar, aparece un error en inglés y el indicador del extremo inferior derecho no deja de girar».

- El análisis pasa a usar un **lector ZIP basado en archivos**: solo lee el directorio central y obtiene el manifiesto, la tabla de recursos y los iconos bajo demanda; el pico de memoria baja de «el tamaño del paquete de instalación» a «unos pocos MB»;
- Los paquetes divididos `.apks` / `.xapk` también pasan a descomprimirse en flujo (cada fragmento se descomprime y se escribe directamente en disco); si falla, se limpia el directorio temporal;
- El tiempo de espera de `adb install` pasa de fijarse en 4 minutos a **escalarse según el tamaño del paquete** (unos 5 minutos para un paquete de 2 GB, con un máximo de 20), para evitar que un paquete grande en un disco lento se juzgue como fallido;
- Los mensajes de error de instalación salen ahora todos por el canal de eventos del proceso principal y se limpia el aviso giratorio de «instalando…», de modo que no queda una barra de progreso girando sin parar tras un error.

### 2. Compatibilidad ZIP con imágenes grandes y paquetes de actualización grandes

- Se añade compatibilidad con **ZIP64** (localizador EOCD y campo extendido id=0x0001): cuando el número de entradas supera 65535, ya no se descartan entradas silenciosamente, y los desplazamientos y tamaños de entradas gigantes se leen del campo extendido.

### 3. En la fase de despliegue se «quedaba en preparando runtime» o «se paraba en el 99 % y volvía a descargar otra imagen»

- La medición de fuentes pasa de «sin ninguna respuesta en 30 segundos» a **informar del progreso una por una** (fuente i de n), con un máximo de 6 s de espera por fuente; un puerto cerrado solo se envía al final de la lista y no afecta a la descarga;
- Antes de descargar el paquete íntegro del runtime se muestra el aviso «obteniendo información de la versión del runtime…»;
- Un fallo al extraer la imagen del sistema **ya no se traga en silencio**: se informa claramente del error y del nombre del archivo, y desaparece el «progreso parado en el 99 % → vuelve a empezar a descargar 1,4 GB desde la fuente oficial»;
- La extracción de la imagen pasa a **escribir primero un `.part` y luego renombrarlo de forma atómica**: un corte de luz o cierre del programa a mitad de proceso no deja un system.img a medias que «parezca completado»;
- El criterio de «ya extraído» pasa de «más de 32 MB» a «al menos el tamaño del archivo comprimido», de modo que una imagen incompleta se vuelve a extraer;
- El guardián de disco incorpora ahora la estimación del paquete íntegro del runtime (comprimido 1,5 GB + extraído 3,3 GB, ambos presentes al mismo tiempo en el pico); si falta espacio, se da un aviso accionable por adelantado en lugar de fallar a mitad de la descarga.

### 4. Cambias «directorio de datos del runtime» en los ajustes pero sigue descargando en el directorio antiguo (#23)

Cuando la versión portable lleva un `runtime/` junto al directorio del programa, la versión anterior sobrescribía al iniciar el `runtime.dir` que el usuario había configurado a mano con ese runtime incluido. Ahora: **si el usuario ha indicado explícitamente un directorio y este contiene emulator, se respeta siempre**; solo se toma el control automáticamente si «no se ha configurado» o «el directorio configurado ya no es utilizable».

### 5. La actualización en línea podía confundir el paquete íntegro de runtime de 1,5 GB con el paquete del programa

Una versión publicada incluye a la vez el paquete portable y `ApkBuddyStart-runtime-*.zip`. La coincidencia genérica `.zip` de respaldo de la versión anterior no excluía este último; si en una publicación faltaba el paquete portable, el actualizador extraía el paquete íntegro de runtime dentro del directorio del programa. Ahora la coincidencia de respaldo excluye explícitamente los archivos `runtime`; cuando no hay ningún archivo utilizable, se informa honestamente de «descárgalo manualmente desde la página de versiones».

### 6. Tras un fallo de arranque, el informe de diagnóstico no revelaba la causa (#20 / #25)

La versión anterior guardaba el «registro de intentos de arranque / conclusión del diagnóstico» solo en memoria; si el usuario reiniciaba ApkBuddyStart y luego exportaba el informe, este contenía `attempts: []` y `UNKNOWN`, y el autor tenía que revisar los registros.

- Cuando falla el arranque, se guardan en disco **los intentos / la conclusión del diagnóstico / el código de salida** en `%APPDATA%\apkstart\logs\last-failure.json` (se borra con el siguiente arranque correcto);
- El informe de diagnóstico incluye ahora el registro guardado, el significado del código de salida y la cola de `emulator.log` (cuando el registro en memoria está vacío, se leen directamente las últimas 300 líneas del archivo);
- Nueva **regla de diagnóstico para `0xC0000005` (3221225477 en decimal)**: se identifica como «fallo del backend de renderizado» y se recomienda actualizar el driver gráfico / bajar la calidad, en lugar del vago «el runtime no pudo completar el arranque»;
- Ante este tipo de fallo se **cambia automáticamente a un backend de renderizado más conservador y se recuerda** (`engine.badGpu`, que caduca con cada versión de emulator), para no volver a chocar con él en el siguiente arranque;
- El panel del runtime en los ajustes muestra directamente «último arranque fallido: …», sin tener que exportar el informe.

### 7. Desinstalar ApkBuddyStart borraba la asociación original del usuario con los archivos .apk

Al desasociar, la versión anterior limpiaba sin condiciones el programa predeterminado para `.apk` (el comentario del código prometía «solo si sigue apuntando a nosotros», pero no estaba implementado). Ahora:

- Al registrar, se guarda el programa predeterminado original en `HKCU\Software\ApkBuddyStart\assocPrev`;
- Al desasociar, **se restaura primero**; solo se limpia si no hay registro y la asociación actual sigue apuntando a ApkBuddyStart;
- Prueba en esta máquina: la asociación original era `MuMuPlayer.apk` y, tras registrar y desasociar, se restauró tal cual.

### 8. Iconos: formatos fuera de WebP y «usar una imagen de marcador de posición sin decirlo»

- Se añaden `jpg/jpeg` a los formatos candidatos de icono;
- Los iconos adaptativos y los XML `layer-list` ahora buscan mapas de bits de forma recursiva (hasta 3 niveles), en lugar de caer siempre en la imagen de marca de marcador de posición;
- Cuando realmente no se puede resolver, el aviso de fin de instalación dice explícitamente «no se pudo analizar el icono; el acceso directo usa temporalmente un icono de marcador de posición», en lugar de dejar al usuario mirando un triángulo verde sin saber qué es.

### 9. Tras una instalación nueva, hacer clic en el icono del escritorio solo muestra el escritorio de Android

Se trata de un error de la versión original (también presente en v0.3.4) detectado en pruebas: tras instalar la aplicación, `apps.json` registra como entrada de arranque el «componente completo» (`com.foo.bar/com.foo.bar/.MainActivity`), pero al arrancar se vuelve a concatenar el nombre del paquete y `am start -n` recibe `com.foo.bar/com.foo.bar/com.foo.bar/.MainActivity`; el sistema cancela el arranque (registro `result code=-92`), y en la ventana solo aparece el escritorio de Android.

- Nueva `componentArg()`: el componente completo se usa tal cual; solo se añade el nombre del paquete cuando es un nombre de clase puro; se admiten ambos tipos de datos históricos;
- `parseResolvedActivity()` pasa a recorrer todas las líneas (la salida de `resolve-activity` suele terminar con líneas vacías), de modo que una última línea vacía ya no se interpreta como «no se pudo resolver»;
- Prueba: tras reinstalar Hongguo y hacer clic en el icono del escritorio, `mCurrentFocus` apunta correctamente a `com.phoenix.read/...SplashActivity` y la ventana muestra la interfaz de la propia aplicación (ya no el escritorio).

### 10. Límites de la rotación de registros

- Cuando el nombre de un archivo de registro no termina en `.log`, la rotación «primero borra y luego renombra», lo que pierde el registro; ahora se omite la rotación en ese caso (preferimos un registro algo más grande antes que perderlo).

### 11. Otros

- Nuevo accesorio de prueba «APK sintético» (`test/lib/make-apk.js`): genera un manifiesto AXML binario, un icono PNG y un directorio ABI, de modo que la cadena de análisis también queda cubierta cuando no hay un accesorio de APK real;
- Casos de regresión nuevos o ampliados: Zip64, paquetes divididos .xapk, materializeImages, selección de archivos de actualización, diagnóstico de `0xC0000005`, límites de registro, guardado del registro de fallos y degradación de iconos WebP;
- `npm test` pasa de 98 a **113 pruebas, todas en verde**.

## Registro de verificación

| Elemento | Resultado |
|---|---|
| `npm test` | 113 superadas / 0 fallidas (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO / .lnk / degradación de WebP, todo superado |
| Arranque en frío real | Listo en 25,0 s (`sys.boot_completed=1`) |
| Acierto de instantánea | 5–6 s |
| Apagado limpio | `code=0`, `hasSnapshot=true` |
| Análisis de APK real | Hongguo Short Drama 7.4.3.32 / `res/b/a3.webp` / arm64-v8a correcto |
| Análisis de APK de 2,15 GB | Completo en 18 ms, RSS del proceso de 47 MB (la versión anterior tenía que leer los 2,2 GB completos en memoria) |
| Instalación nueva + arranque desde icono del escritorio | Tras reinstalar Hongguo y hacer clic en el icono: `mCurrentFocus` = `com.phoenix.read/...SplashActivity`, ventana con la interfaz de la aplicación (antes del arreglo, el escritorio de Android) |
| Autocomprobación del runtime `npm run selftest -- --apk` | **13 pruebas, todas superadas**: adb / motor / imagen / AEHD, Android 14 API34, freeform, sincronización bidireccional de carpeta compartida, análisis → instalación → arranque en ventana independiente → captura |
| `tools/check-launch-clean.js` | Durante todo el proceso de instalar y abrir: ventana de la aplicación visible en **0,5 s**, ventanas de emulador/consola visibles **0 veces** en total |
| Cadena de instalación | Paquete instalado, APK de 153 MB arrastrado dentro: análisis/instalación/icono/acceso directo en 22 s; Target/Args/Icon de los .lnk del escritorio y del menú Inicio correctos |
| Sin fugas de ventanas | `check-quit-clean`: arranque completo + 8 s tras salir, ventanas de emulador/consola visibles **0** |
| Asociación de registro | Asociación original en esta máquina: `MuMuPlayer.apk`; se restauró tal cual tras registrar → desasociar |
| Paquete instalado | Portable de 226 MB, prueba de humo de la interfaz superada |

## Limitaciones conocidas

- La **causa raíz** de `0xC0000005` sigue estando en el lado del driver gráfico / el backend Vulkan; esta versión se limita a «cambiar de backend automáticamente y dejar claro el motivo». Si una máquina determinada sigue fallando sin excepción, basta con enviar el nuevo informe de diagnóstico para localizarlo.
- El análisis de iconos aún no admite drawables vectoriales ni `shape` (se usa la imagen de marcador de posición y se informa de ello).
- La asociación con `.apk` se escribe en HKCU (sin privilegios de administrador); si otro programa reclama la asociación una y otra vez, prevalece la configuración del sistema en «Aplicaciones predeterminadas».
