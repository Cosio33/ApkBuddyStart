# ApkBuddyStart v0.5.0

Esta versión incluye: **la corrección definitiva de «siempre sin red»**, **un arranque dos veces más rápido**, **una nueva edición para FydeOS** y, añadidas después, una serie de mejoras de experiencia (sistema en chino / teclado chino / cambio de nombre de ventana / autosanación de rotación / descargas y limpieza de versiones antiguas / clics más responsivos / ahorro de recursos y memoria).

## 0,5. Descargas ya no se redescargan sin fin + se pueden limpiar versiones antiguas en cualquier carpeta + clics más responsivos + ahorro de recursos

**Un fallo de descarga ya no deja archivos a medias.** Antes, todas las rutas de error lanzaban una excepción sin borrar el archivo, y en tmp quedaban para siempre un zip a medias junto con el archivo lateral `.chunks.json`. La siguiente vez, con una reanudación por Range, si el servidor o la fuente había cambiado, no se podían recomponer los bytes correctos → otro fallo → otro archivo a medias… y cada apertura volvía a descargar el mismo paquete. Ahora `discardPartial()` limpia de forma unificada en todos los puntos de error (reintentos agotados, interrupción de la escritura, tamaño incorrecto, fallo de verificación, antes de cambiar de fuente y rechazo directo de `openStream`). El despliegue automático añade además una **pausa de 30 minutos tras un fallo**; pulsar manualmente «desplegar con un clic» permite reintentar de inmediato.

**Ahora se pueden limpiar versiones antiguas en otras carpetas.** El limpiador solo examinaba el directorio padre del exe actual y dos directorios de Program fijos, así que una versión portable descomprimida en otro lugar nunca se encontraba. Ahora amplía el análisis a las capas superficiales de la raíz de cada disco y a Downloads/Desktop/Documents, y además localiza el directorio de instalación real a partir de los accesos directos del escritorio y del menú Inicio. También se incluyen en la limpieza los restos de copias de seguridad empaquetadas `.prev-*`, excluyendo siempre la versión en ejecución. En pruebas en esta máquina, se pasó de no detectar nada a encontrar más de 24 entradas, unos 5,6 GB.

**Clics más responsivos / el vídeo no pierde fotogramas.** La prioridad de programación de la aplicación en primer plano sube de `below` a `normal`: `below` dejaba qemu sin recursos cuando el sistema estaba ocupado, y esa era la causa principal de «hay que esperar un instante a que responda el clic y el vídeo pierde fotogramas». `normal` solo lo pone al mismo nivel que el escritorio, sin consumir más CPU/memoria/GPU. Además, cada vez que se vuelve a la aplicación se vuelve a subir la prioridad, para que no se quede ralentizada en un nivel bajo.

**El modo ahorro de recursos usa menos memoria.** El nivel «ahorrar recursos» baja el límite de memoria de la máquina virtual de 3 GB a 2 GB: qemu consume unos 1 GB menos de forma residente y la instantánea de arranque rápido también es 1 GB más pequeña (lo que beneficia la sincronización de disco). Las cargas ligeras no necesitan 3 GB; si se especifica la memoria manualmente, ese valor tiene siempre prioridad.

**El modo tableta en horizontal es más estable.** Antes, la autosanación de orientación solo actuaba cuando la imagen estaba tumbada; pero el formato tableta en horizontal depende de dos estados de runtime fáciles de perder (ignorar las peticiones de orientación de la aplicación y density 190), que tras restaurar una instantánea o reiniciar el framework vuelven a los valores por defecto y retroceden al formato móvil. Ahora esos dos valores también se comprueban y se completan aunque la imagen no esté tumbada (es idempotente y, en condiciones normales, no escribe nada).

> Sobre «varias ventanas»: una sola instancia del emulador de Google tiene un único framebuffer y no se puede dividir en varias ventanas nativas de Windows independientes sin añadir más emuladores (la opción de proyección de pantalla se probó y su rendimiento es inutilizable). Por eso esta versión mantiene una sola aplicación con cambio rápido; el código del marco multiventana se conserva pero está desactivado por defecto. El verdadero multiarranque tendría un coste de 2–3 GB de memoria adicionales por aplicación y no se ha incluido.

## Cero. Sistema en chino, teclado chino, cambio de nombre de ventana y autosanación de rotación (añadido después)

**Idioma del sistema: chino simplificado por defecto.** Aquí hubo una trampa: `-prop persist.sys.locale=zh-CN` no hace nada en absoluto (el emulador intercepta `persist.sys.*` y `ro.product.locale` se sobrescribe desde build.prop), y en el invitado no se ve ni una con `getprop`. Al usar el oficial `-change-locale zh-CN`, la página de ajustes del sistema, los diálogos de permisos y el formato de fecha pasan todos a chino. Solo surte efecto en un arranque completo, así que al restaurar una instantánea antigua en inglés se invalida automáticamente y se hace un arranque en frío (un marcador garantiza que se haga una sola vez en toda la vida); las nuevas instantáneas ya serán en chino. En los ajustes se puede cambiar entre simplificado, tradicional, inglés, japonés y coreano.

**Teclado en chino**: la imagen solo trae el teclado inglés (LatinIME), así que se incluye en el paquete un teclado AOSP Pinyin de Google (`assets/PinyinIME.apk`, con bibliotecas nativas x86_64, 1,6 MB) que se instala silenciosamente al arrancar y se establece como predeterminado. Se corrigió un bug sutil: `ime list -s` solo enumera los teclados **habilitados**, así que usarlo para comprobar «si está instalado» daba un falso «servicio no registrado» justo después de instalarlo y nunca se llegaba a `ime enable`. Se puede desactivar en los ajustes.

**La ventana ya no se llama "Android Emulator - apkstart:5554"**, sino con el nombre de la aplicación actual (por ejemplo, «Hongguo, cortos gratis»). El proxy de ventanas añade el comando `title`, reconoce también el nuevo título y sigue reintentándolo en las inspecciones (Qt vuelve a cambiarlo por su cuenta).

**Rotación / modo tableta ya no se quedan tumbados 90°**: la causa raíz era que arrancar la aplicación y recrear la Activity sobrescribían la orientación recién bloqueada, y antes solo se fijaba una vez. Ahora se leen los valores `init`/`cur` de `dumpsys window displays`; si el orden de ancho y alto está invertido entre ambos, significa que el espacio lógico se giró 90° y se vuelve a bloquear de inmediato; un perro guardián inspecciona cada 60 s (solo escribe si está realmente tumbado) y se vuelve a aplicar una vez más después de arrancar la aplicación.

**Otra capa para la red**: `checkNetwork` añade una sonda real de accesibilidad HTTP (el resultado se guarda en `reachable` y no afecta a la decisión de arranque); el punto de verificación de red se cambia a un endpoint 204 nacional y se escribe de forma idempotente en cada arranque, de modo que el sistema deja de marcar la red con «!».

## 1. Red de la máquina virtual: de «nunca conecta» a poder cargar contenido de verdad

Este es un problema que llevaba sin resolverse desde el inicio del proyecto: la portada de Hongguo mostraba siempre «error de red, inténtelo de nuevo más tarde» y el registro informaba en cada arranque de que «la máquina virtual no tiene red». La causa no era una sola, sino tres capas acumuladas:

**Primera capa: la configuración del AVD no contenía `hw.wifi`.**

Las imágenes de Play Store de la API 34 salen a internet por `wlan0` (el Wi-Fi virtual del emulador), no por el `eth0` de antes. Si a `config.ini` le falta esa línea, `wlan0` queda siempre en `NO-CARRIER` y no obtiene IP.

Los parámetros de línea de comandos `-netdelay` / `-netspeed` / `-dns-server` solo afectan al NAT en modo usuario de QEMU y **no tienen nada que ver** con que la tarjeta interna del invitado se haya levantado; por eso se llevaban años ajustándolos sin ningún efecto.

**Segunda capa: el hotspot Wi-Fi «está guardado pero no se conecta automáticamente».**

Tener la tarjeta no basta. El hotspot virtual del emulador `AndroidWifi` se registra en la base de datos de Wi-Fi como `Saved / Won't automatically connect` y no se conecta solo tras el arranque.

Tampoco sirve hacerlo por línea de comandos: `cmd wifi connect-network` necesita el permiso `NETWORK_SETTINGS`, que adb shell (uid 2000) no tiene, y lanza `SecurityException`. Así que se cambia a abrir la página de ajustes de Wi-Fi y usar `uiautomator` para encontrar la fila del hotspot y pulsarla: equivale a que lo haga el usuario a mano.

**Tercera capa: el sistema seguía marcando la red con «!».**

Android usa `connectivitycheck.gstatic.com` para decidir «si hay internet de verdad»; en China no se puede alcanzar, así que el sistema sigue creyendo que la red no sirve. Algunas aplicaciones lo interpretan como que están sin conexión y se niegan a cargar. Al cambiar a un endpoint 204 alcanzable desde China, el estado de la red pasa a `VALIDATED`.

**Se corrigen también dos errores de llamada que convertían la «reparación» en un trabajo en vano** (ambos escribían en el registro pero no hacían nada de verdad): `rt` es el objeto devuelto por `ensure()` y solo contiene `client`, mientras que `repairWifi` está en engine; escribir `rt.repairWifi` daba `undefined` y la llamada lanzaba un error que se tragaba `catch`; y `adbPath` es un método, por lo que pasarlo directamente como ruta convertía adb en el código fuente de una función.

**La estrategia de reparación también cambia de «limpiar datos de usuario de entrada» a un esquema escalonado**: primero reconectar el Wi-Fi (sin tocar datos) → luego arranque en frío (sin tocar datos) → y solo al final restablecer los datos. En la ruta de arranque solo se hace el paso más ligero.

> Prueba real: el episodio 1 de Hongguo muestra imagen, subtítulos y la lista de episodios con normalidad.

## 2. Velocidad: arranque de 53 s a 18 s, apertura de una aplicación de 7,2 s a 3,0 s

### Lo que más ralentizaba el arranque no era el encendido, sino tener que reconectar el Wi-Fi cada vez

Antes, cada arranque esperaba 22 s a que agotara el tiempo de espera y luego otros 13 s de reconexión. La causa era muy sutil: la instantánea solo se guardaba cuando «no había ninguna aplicación en primer plano», pero en cuanto arranca una aplicación el sistema nunca está inactivo, así que el estado «red conectada» **jamás se guardaba en la instantánea**, y la vez siguiente se restauraba una instantánea antigua sin red.

- Tras reconectar con éxito, se **fuerza** guardar una instantánea de inmediato (saltándose la comprobación de inactividad). Al siguiente arranque, la red se confirma lista en 2 s.
- Al esperar la red, si aparece «Wi-Fi no asociado» tres veces seguidas, se termina antes de tiempo en lugar de esperar hasta agotar el tiempo de espera.

| | Antes | Ahora |
|---|---|---|
| Arranque completo | 53 s | **17,6 s** |
| De los cuales, esperar la red | 22 s | 6,4 s (solo si realmente no hay red) |
| Reconexión de red | cada vez | **una vez, y ya no hace falta** |

### Abrir una aplicación: que el usuario no tenga que «hacer clic y esperar»

Desglosando la cadena, tras el precalentamiento el encendido solo tarda 0,13 s y el grueso pasa a ser «esperar a que la aplicación despierte»: el proceso aparece a los 2 s, pero, para asegurarnos de que no se fuera a cerrar de inmediato, seguíamos observándolo 4 s antes de conectar la imagen.

Ahora se cambia a **conectar la imagen en cuanto aparece el proceso**. Esos 4 s de observación de supervivencia se mantienen (son un respaldo contra el «parpadea y se cierra»), pero se ejecutan en paralelo en segundo plano, sin bloquear al usuario mientras quiere ver el contenido.

```
ensure done     +137ms    ← en arranque en frío aquí son 9,7 s
am start ok    +1631ms
app up         +2035ms    ← aparece el proceso, se conecta la imagen al instante
early attach   +2956ms    ← la ventana ya aparece en el escritorio
alive #1       +6131ms    ← confirmación de supervivencia; el usuario ya lleva rato viendo contenido
```

**Del clic a la imagen: de 7,2 s a 3,0 s.**

Además se vuelve a activar el «precalentamiento»: al abrir ApkBuddyStart, se arranca el entorno Android en segundo plano (unos 10 s, sin ninguna ventana visible), de modo que pulsar una aplicación después solo requiere un `am start`. Es lo que hacen WSA y la versión de escritorio de YingYongBao.

## 3. Interfaz

- **Tarjeta discontinua «Añadir aplicación»**: cuando hay pocas aplicaciones, debajo de la cuadrícula queda un gran espacio en blanco y el usuario no sabe qué más puede hacer. Ahora, al final, hay una tarjeta discontinua que dice «arrastra un APK para instalarlo» y que al pulsar equivale al botón «instalar APK».
- **La barra de estado muestra la red**: `● red correcta 10.0.2.16` / `máquina virtual sin conexión`.
  Este detalle era muy difícil de detectar: dentro de la aplicación solo aparecía «error de red» y al usuario nunca se le ocurría que la máquina virtual no tenía red. Para no cargar el sondeo de estado, la red se detecta una vez en segundo plano y se guarda en caché (no se confía en ella después de 5 minutos).

## 4. Novedad: edición para FydeOS

FydeOS (basado en ChromiumOS) ya puede ejecutar aplicaciones Android por sí solo. Abrir otra máquina virtual Android encima es un desperdicio puro: varios GB de imagen, varios segundos de arranque y 3 GB de memoria, todo innecesario.

Así que se ha hecho una edición para FydeOS: **se elimina toda la capa de máquina virtual** y solo se conserva lo que ApkBuddyStart aporta de verdad (arrastrar un APK y se instala, generar automáticamente iconos de escritorio y una ventana por aplicación).

Selecciona «subsistema Android de FydeOS» en Ajustes → Runtime → Modo de motor.

**Lo que no puede hacer (se dice desde el principio)**: no admite incrustación de ventanas. La incrustación usa `SetParent(HWND)` de Win32, y el escritorio de ChromeOS es Aura/Wayland, donde no existe eso de HWND. La buena noticia es que la ventana independiente era de todos modos el modo que da mejor experiencia.

Los pasos completos de instalación, la autorización ADB y la solución conocida al problema de «siempre unauthorized» están en
[docs/fydeos.md](https://github.com/RoutineMiku/apkstart/blob/main/docs/fydeos.md).

> **Nota sobre el estado**: la lógica de la base para FydeOS (conexión, autorización, mensajes de error y declaración de capacidades) y la generación de `.desktop` en Linux ya tienen cobertura con pruebas unitarias, pero **no se ha ejecutado un flujo completo de extremo a extremo en un dispositivo FydeOS real**. El binario de Linux también hay que compilarlo en un entorno Linux con `npm run pack:linux` (desde Windows no se puede generar un AppImage utilizable mediante compilación cruzada). Se agradece feedback a quienes tengan un dispositivo.

## 5. Sobre la elección de la base

Aprovechamos para evaluar a fondo «si conviene cambiar a Waydroid / WSA / YingYongBao / otro sistema ligero»; las conclusiones están en
[docs/backend-roadmap.md](https://github.com/RoutineMiku/apkstart/blob/main/docs/backend-roadmap.md).
Versión resumida:

| Opción | Conclusión |
|---|---|
| Waydroid + WSL2 | Requiere Hyper-V, que es **mutuamente excluyente** con la aceleración AEHD actual; además, en x86 no puede ejecutar aplicaciones solo arm64 |
| YingYongBao para PC | Código cerrado, sin API pública; no se puede incrustar ni distribuir junto a nosotros |
| WSA de Microsoft | Dejó de recibir soporte en 2025-03 y los canales oficiales de distribución están cerrados |
| FydeOS | ✅ Ya está hecho como versión independiente (ver arriba) |

## Notas sobre la actualización

- La ubicación del archivo de configuración no cambia; se puede sobrescribir directamente desde v0.4.x.
- El primer inicio hará una reparación de red (unos 13 s); con la nueva instantánea, ya no hará falta.
- El modo por defecto sigue siendo ventana incrustada; para una experiencia más tranquila, cambia a **ventana independiente** en los ajustes.
