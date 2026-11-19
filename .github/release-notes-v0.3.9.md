# ApkBuddyStart v0.3.9

> En una frase: se convierte el **cambio entre vertical y horizontal** de «girar la imagen» a un auténtico **cambio de maquetación de móvil / tableta**; se corrige que la pantalla completa no pasaba a horizontal, que los clics no funcionaban y que apareciera un borde negro al pulsar los botones de la barra de título; además, se añade la **liberación de espacio de almacenamiento**.

## 1. Vertical / horizontal y pantalla completa: ahora es un cambio real de maquetación

**El problema anterior**: al pulsar rotar (o pantalla completa), la imagen entera se tumbaba en sentido horario o antihorario, la aplicación no volvía a maquetarse y no había forma de enderezarla; además, la pantalla completa no pasaba automáticamente a horizontal.

**Causa raíz**: la implementación anterior consistía en «cambiar `wm size` y pedir al proxy de ventanas que enviara Ctrl+← al emulador». Ctrl+← solo gira **la imagen del emulador** 90°, sin cambiar en absoluto la maquetación de Android, así que lo que se veía era «la imagen tumbada». Además, la configuración de generación del AVD fijaba `hw.sensors.orientation=no`, así que Android no permitía la rotación y solo se podía engañar girando la imagen.

**Lo que se hace ahora**:

- Solo se cambia el **tamaño de pantalla lógico** (`wm size`) para que Android vuelva a maquetar con el nuevo ancho:
  - Vertical 720×1280 @320 dpi ≈ **360 dp de ancho → maquetación de móvil**;
  - Horizontal 1280×720 @320 dpi ≈ **640 dp de ancho → maquetación de tableta / dos columnas** (Android considera 600 dp el umbral de tableta);
- Al mismo tiempo, `wm user-rotation lock 0` garantiza que la imagen siempre esté derecha y que no aparezca el «tumbado»;
- **Se elimina el paso de girar la imagen**, de modo que imagen y maquetación siempre coinciden;
- La ventana recalcula la relación de aspecto según la nueva resolución y se reajusta, sin dejar bordes negros;
- **El botón de pantalla completa ahora cambia automáticamente a horizontal (maquetación de tableta)**, y al salir de pantalla completa vuelve a la maquetación vertical de móvil; el conmutador «modo de pantalla» de los ajustes funciona igual;
- La configuración del AVD pasa a `hw.sensors.orientation=yes` + `hw.sensors.accelerometer=yes`, para que las máquinas nuevas no queden bloqueadas en vertical.

## 2. Corrección: aparecía un borde negro al pulsar los cuatro botones de la barra de título

La ventana Qt del emulador es algo más grande que la LCD real (8 px de borde gris por cada lado). Para que ese borde gris no apareciera en la imagen, antes se hacía desbordar la ventana hija 8 px hacia arriba y hacia la izquierda, justo sobre la parte inferior de la barra de título; como, al pulsar un botón, el proxy de ventanas trae la ventana del emulador al frente, esa parte desbordada dibujaba un **borde negro** bajo la barra de título.

**Corrección**: se añade **recorte de región de ventana** (`SetWindowRgn`) a la ventana del emulador incrustada, recortando directamente esos 8 px que se desbordaban sobre la barra de título. Así, por mucho que se eleve la ventana, no puede dibujar sobre la barra de título.

## 3. Corrección: los clics no funcionaban / no se podía pulsar «Aceptar y continuar»

Este punto tiene el mismo origen que los dos anteriores: tras girar la imagen 90°, la asignación de coordenadas del proxy de ventanas seguía siendo la de la «vertical», así que la posición del clic se desplazaba y parecía que «hacer clic no hacía nada». Al corregir el cambio de maquetación, los clics vuelven a funcionar con normalidad.

De paso se reduce el coste de «esperar a la red»: el reintento con arranque en frío ahora se hace **una sola vez por proceso** y la primera espera baja de 60 s a 25 s; antes, abrir la aplicación podía suponer esperar varios minutos, y ahora en condiciones normales pasa en unos segundos.

## 4. Optimización del espacio de almacenamiento

«Limpiar restos de versiones antiguas» ahora recupera también las **instantáneas de arranque rápido abandonadas**:

- El `default_boot` heredado de versiones antiguas (una copia de ram.img de unos **3 GB**);
- Los restos `*.stale-*` que no se pudieron borrar y se renombraron;
- La instantánea en uso actual (`apkstart`) nunca se toca.

En el equipo de desarrollo, los elementos recuperables suman unos **4,65 GB** (6 directorios de versiones antiguas del programa + 1 instantánea abandonada).

## 5. Pruebas reales

- `npm test`: **113 pruebas, todas superadas** (8 + 25 + 80).
- Tras `wm size 1280x720`, el framebuffer pasa a **1280×720** medido y la imagen está derecha (confirmado con captura).
- La ventana de la aplicación se incrusta con `embedded=true`; al cerrarla, `pidof` está vacío (la corrección de la versión anterior sigue en vigor).

## 6. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
