# ApkBuddyStart v0.5.5

Esta versión resuelve tres cosas: **la pantalla negra** (desfase entre la base MuMu y el GLES del anfitrión), **los juegos de gran tamaño, del orden de 50 GB, que no se podían instalar o fallaban a mitad**, y que **la memoria / CPU / almacenamiento pueda asignarlos el propio usuario**.

El paquete de instalación sigue siendo **autónomo**: incluye emulator + platform-tools + la imagen del sistema; se instala y funciona de inmediato, sin necesidad de tener MuMu ni ningún otro emulador preinstalado. MuMu solo se reutiliza si «ya lo tienes en tu máquina», como mejora opcional.

---

## 1. Diagnóstico y autosanación automáticos de la pantalla negra (base MuMu)

El registro gráfico de MuMu 12 en esta máquina no para de informar en cada arranque:

```
EGL ERROR: eglCreateContext: Requested GLES version (3.2) is greater than max supported (3, 1)
```

La GPU configurada en la instancia es `Adreno (TM) 740` (que anuncia GLES 3.2), pero la tarjeta del anfitrión solo ofrece hasta GLES 3.1.
El resultado es que Android arranca, ADB conecta y el proceso del juego sigue vivo, **pero la ventana de imagen queda completamente negra**: lo que el usuario ve es «se abre y se queda en negro».

El procedimiento actual es:

1. Leer el `graphics_log` de MuMu y extraer la versión GLES real del anfitrión y el modelo de tarjeta;
2. ordenar los niveles de renderizado según la tarjeta (`dx/vk` × alto/medio/bajo, 5 niveles en total) y escribirlos en la configuración de MuMu antes del arranque;
3. tras arrancar, capturar un fotograma del framebuffer del invitado y muestrear el brillo para decidir si está completamente negro;
4. si está negro, cambiar al siguiente nivel y reiniciar, hasta que la imagen funcione, y recordar qué nivel sirve en esta máquina;
5. hacer la revisión **solo en la instancia que ApkBuddyStart ha arrancado en esta sesión**: no se va a reiniciar el emulador que estés usando.

Se corrige también un bug real: las funciones `findDeviceWindows()` / `hwndOf()` que llama `windowTargets()` nunca se habían definido, así que la toma de control de ventanas de MuMu nunca seguía la ruta prevista (se manifestaba como «la ventana no se puede incrustar / no aparece la ventana independiente»).

## 2. Juegos de gran tamaño (del orden de 50 GB)

- Antes de instalar se hace una comprobación previa de disco: se estima como «paquete × 1,8 + 2 GB», de modo que un paquete de 50 GB necesita unos 92 GB; si no hay espacio, se dice **antes de empezar**, no se falla al 80 % de la instalación.
- El runtime incluido comprueba también la capacidad de la partición `/data` (ampliar solo la imagen del anfitrión sin que la partición del invitado acompañe es como no ampliar nada).
- El tiempo de espera para instalar paquetes grandes se escala según el tamaño, en lugar de fijarse en 180 s.

## 3. Memoria / CPU / almacenamiento asignados por el usuario

La página de ajustes añade «asignación de recursos de la instancia MuMu»: memoria de 2 a 32 GB y CPU de 2 a 16 núcleos, con `0 = mantener la configuración original de MuMu` (por defecto no se toca nada). En el runtime incluido, los límites configurables de memoria y núcleos ahora siguen al anfitrión: antes estaban fijados en 8 GB / 8 núcleos y una máquina de 32 GB solo podía recibir 8 GB.

Todas las entradas se normalizan al guardar: se reserva un 25 % de memoria para Windows, al menos 1 núcleo y un máximo del 80 % del disco para la partición de datos. Aunque edites `settings.json` a mano y pongas 999 GB, qemu no se vendrá abajo.

Prueba real: con 8192 MB / 6 núcleos → `MemTotal 8138280 kB` en el invitado y 6 núcleos en `/proc/cpuinfo`; todo coincide.

## 4. La ampliación de almacenamiento ya no «finge éxito»

Antes, pulsar «ampliar ahora» mostraba éxito, pero quickboot crea una capa de disco diferencial `userdata-qemu.img.qcow2` para userdata y es lo que monta el invitado: la base se ampliaba a 8 GB y el `resize2fs` interior también llegaba a 8 GB, pero `df /data` seguía dando 5,7 GB y el usuario seguía fallando a mitad al instalar un juego de 50 GB.

El invitado no tiene root ni `resize2fs`, y el disco diferencial no se puede fusionar en el anfitrión para convertirlo en un ext4 utilizable.
Ahora se **informa del error con honestidad**: se devuelve `needsReset` y, tras una segunda confirmación en la interfaz, se ejecuta «vaciar y recrear /data con la nueva capacidad»; se deja de fingir que se amplió.

## 5. Garantía firme de funcionamiento autónomo

- El script de empaquetado añade una guarda: si en el resultado aparece cualquier binario o directorio de MuMu / LDPlayer / BlueStacks, **la compilación falla de inmediato**. Estos problemas nunca se detectan en local y solo salen en el equipo de otra persona, por eso se frenan en fase de compilación.
- Si en los ajustes queda `mode=mumu` pero MuMu no está instalado en esta máquina (porque importaste una configuración o desinstalaste MuMu), ya no falla el arranque y bloquea toda la aplicación, sino que se vuelve automáticamente al runtime incluido y se explica el motivo en el registro; vuelve a seleccionar la base para cambiar de nuevo.
- El motor predeterminado es siempre el runtime incluido, y la selección automática en Windows también pone builtin en primer lugar; no se tomará el control de un emulador que el usuario tenga abierto.

---

## Notas de actualización desde 0.5.4

- `0.5.5.0 > 0.5.4.0`; la Store puede sobrescribir la actualización directamente.
- Se conservan las aplicaciones Android y las partidas guardadas ya instaladas; no hace falta reinstalar.
- Quienes usan la base MuMu: el primer arranque tras actualizar volverá a revisar la imagen y puede tardar unas decenas de segundos más; el nivel válido recordado se muestra en la página de ajustes.
- Para ampliar la partición de datos: tras guardar la nueva capacidad hay que «vaciar y recrear /data», lo que borra las aplicaciones instaladas; vuelve a instalarlas después de recrearla.

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.5.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Materiales de envío: `docs/store-listing.md` (incluye el texto «What's new» de esta versión en español e inglés)
- Pasos: `docs/store-upload-walkthrough.md`

Pruebas: 275 pruebas de la suite completa, todas superadas (20 nuevas de compatibilidad con MuMu, 32 de asignación de recursos y 15 de funcionamiento autónomo).
