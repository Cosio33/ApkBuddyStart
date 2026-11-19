## ¿Qué resuelve esta versión

### 1. Descarga lenta: la verdadera razón es que «todos los hilos se amontonan en una dirección bloqueada»

Pruebas en esta máquina: 8 hilos contra GitHub dan solo **0,23 MB/s**, y la actualización de 113 MB tarda **493 segundos**;
al mismo tiempo, dos conexiones directas dan **cero bytes** (TCP conecta pero no hay datos), solo el espejo está funcionando.

- **Descarga paralela de fragmentos desde varias fuentes**: el archivo se divide en bloques y distintos bloques se descargan a la vez desde «conexión directa a GitHub / ghfast / gh-proxy», sumando el ancho de banda.
  En la misma máquina: **113 MB pasan de 493 a 77 segundos** (unos 1,5 MB/s, incluyendo la prueba de velocidad y la descompresión).
- **Cambio de fuente por baja velocidad**: cuando un bloque baja a decenas de KB/s, se interrumpe, cambia de fuente y continúa desde el punto donde se quedó; antes se «quedaba clavado al 95 %».
- **Reanudación por fragmentos**: si falla a mitad la descarga del paquete de runtime de 1,4 GB, al volver a ejecutar solo se descargan los bloques que faltan, sin empezar de cero.
- **Perro guardián de estancamiento**: si la conexión se establece pero no envía bytes en 20 segundos, se descarta de inmediato y se prueba la siguiente fuente, en lugar de esperar tontamente el tiempo de espera de 30 s del socket y bloquear todo el paquete.
- **Medición y selección en cada descarga**: cada dirección candidata descarga 256 KB reales para medir la velocidad, y solo se cuenta el rendimiento «después de recibir el primer byte»
  (incluir la negociación de unos cientos de milisegundos haría que una fuente con mucha latencia pero gran ancho de banda se juzgara como lenta); las pruebas se hacen en secuencia para que no compitan entre sí por el ancho de banda.

### 2. Doble fuente: selección automática de la mejor entre GitHub y Gitee

- Ambos repositorios son ahora públicos: GitHub `RoutineMiku/apkstart` y Gitee `daily-miku/apkstart`.
- La comprobación de versiones pregunta a ambos y toma la de número más alto; si una fuente falla por tiempo de espera o está bloqueada, la otra no se ve afectada.
- Los archivos adjuntos de las versiones en Gitee tienen un límite de 100 MB por archivo, por lo que el paquete portable se publica allí como `.part1/.part2`;
  el cliente descarga cada fragmento eligiendo la mejor fuente y luego los une (verifica el tamaño de cada fragmento y se detiene si falta alguno).
- Las llamadas anónimas a Gitee tienen límite de frecuencia: se añadió una caché de versiones de 10 minutos y un cortocircuito de 15 minutos ante 403/429;
  cuando ambas fuentes fallan, se vuelve al último resultado y se marca como `stale`, sin que la interfaz muestre un error directo.

### 3. Ya no se borrarán datos del usuario por error

- **No se limpian datos automáticamente cuando el disco está lleno**: antes, la última opción de la matriz de reintentos usaba `-wipe-data`; con el disco lleno fallaba cada opción y los reintentos consecutivos borraban la aplicación y las partidas guardadas. Ahora ningún reintento automático limpia datos y, si falta espacio, se detiene y te dice qué hacer.
- **Cambiar de disco el espejo no cuenta como cambiar de espejo**: mover el directorio de runtime de la unidad C a la D (que es lo que se recomienda en los ajustes) antes se identificaba como «el espejo cambió» → `-wipe-data` → se perdían todas las aplicaciones instaladas. Ahora la comparación se hace por la identidad del espejo, así que cambiar de disco no toca los datos.
- **Se corrige el orden de los parámetros de `qemu-img resize`**: antes podía ocurrir que «el archivo creciera a 6 GB pero el sistema de archivos siguiera en 64 MB»;
  Android se llenaba al primer intento de escritura y todos los servicios fallaban con ENOSPC en `setxattr`. Ahora, al iniciar, también se autocomprueba y corrige.

### 4. Otros

- Los fallos de instalación ya no inundan la pantalla: hacer clic varias veces en el mismo APK solo ejecuta una instalación; los mensajes de error dan una conclusión accionable según el tipo
  (partición insuficiente / paquete ARM / conflicto de firma / reducción de versión).
- Recursos y disco bajo control: tres niveles de estrategia de recursos (ahorrar / equilibrado / fluido), tres de calidad gráfica,
  partición de datos de Android ajustable de 4 a 24 GB con ampliación en caliente (sin perder las aplicaciones instaladas) y directorio de datos de Android configurable en otra unidad.
- Tamaño: versión portable de 230 MB (se recortaron 52 paquetes de idioma innecesarios, ahorrando 39 MB).
- Los registros se rotan por tamaño y ya no crecen sin límite; la sincronización de la carpeta compartida deja de mover el mismo archivo una y otra vez.

## Verificación en equipo real (misma máquina, Windows 11 + imagen Android 14 Play)

| Elemento | Resultado |
|---|---|
| Arranque en frío hasta poder abrir aplicaciones | **23–25 s** (la primera vez, con detección, unos 32 s) |
| Acierto de instantánea quickboot | **5 s** |
| Instalar un APK y abrir la aplicación | La ventana de la aplicación aparece en **1,5 s** (instantánea en caliente) |
| Ventanas visibles del emulador/consola durante los 45 s de arranque | **0** |
| Ventanas residuales en el escritorio tras salir de ApkBuddyStart | **0** |

## Instalación

- **Versión completa** `ApkBuddyStart-*-Setup.exe`: incluye el runtime, listo para usar tras instalar (unos 1,4 GB).
- **Versión ligera** `ApkBuddyStart-*-win64-portable.zip`: descomprimir y usar; en el primer inicio descarga el runtime automáticamente
  (ahora elige la fuente más rápida y reanuda la descarga).

Ambos repositorios tienen el mismo contenido; en China se recomienda usar Gitee.
