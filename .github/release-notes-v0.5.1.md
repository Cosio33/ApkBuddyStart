# ApkBuddyStart v0.5.1

Esta versión es el remate de **estabilidad y aspecto**: se reproducen, corrigen y vuelven a verificar uno a uno los 6 problemas confirmados en la revisión en equipo real de la versión anterior.
El nuevo número de versión obedece sobre todo a Microsoft Store: si ya enviaste la 0.5.0, hace falta `0.5.1.0` para sobrescribir la actualización.

## 1. Cambiar de aplicación ya no significa mirar una pantalla vacía durante 40 s

En el modo de ventana independiente, la ventana cáscara normalmente no se muestra (la imagen está en la ventana propia del emulador). Pero al cambiar a una aplicación con **orientación de pantalla distinta** hay que reiniciar el runtime para cambiar el panel, unos 40 s; durante ese tiempo antes no había ninguna ventana en el escritorio y el usuario solo podía pensar que el programa se había cerrado.

Ahora, durante la espera se muestra una ventana que dice «cambiando a vertical para «Hongguo, cortos» (reiniciando el entorno Android, unos 40 s, solo una vez)…» y se recoge automáticamente en cuanto se conecta la imagen.

Prueba real: en t=2,1 s aparece la ventana de espera y sigue hasta t=41,9 s, cuando se conecta la imagen; en todo momento se sabe qué está pasando.

## 2. Ya no se informa falsamente de «la máquina virtual no tiene red; restablece los datos de Android»

La asociación del Wi-Fi + DHCP suele ir de 5 a 20 s por detrás de `sys.boot_completed`, pero la implementación anterior comprobaba una sola vez y sacaba la conclusión; por eso **en cada arranque en frío** aparecía un ⚠️: «la máquina virtual Android no tiene ahora mismo red… puedes restablecer los datos de Android en «Ajustes → Reparar red»».

Ese aviso era falso (la red se conecta sola unos segundos después), y la solución que proponía **borra las aplicaciones instaladas**.

Ahora la revisión de red dispone de una ventana de espera de 12 s (se devuelve en cuanto está lista), y solo se avisa si se agota de verdad; además, ya no se recomienda una acción destructiva.

## 3. Corrección: «fallo al arrancar la aplicación tras reiniciar por cambio de orientación»

`emulator.exe` es solo un lanzador: cuando termina de generar qemu, sale, pero el objeto de proceso se queda guardado. Como consecuencia, el `ensure()` que viene justo después de reiniciar por cambio de panel toma la vía rápida de «reutilizar» en `start()` y obtiene el serial de un emulador **ya apagado**; todos los comandos adb posteriores dan `device not found` / `Can't find service: activity`, lo que se manifestaba como «cambiar de aplicación falla directamente y vuelve a la interfaz principal».

Ahora, antes de reutilizar se confirma que haya una máquina funcionando en el puerto de consola; y `stop()` también limpia el identificador del lanzador.

## 4. Serialización de los arranques

Un arranque puede durar hasta 80 s (cambio de panel + arranque en frío). Si durante ese tiempo se pulsa otra aplicación, el comportamiento anterior era **ejecutar de verdad una segunda vez en paralelo**: `openAppWindow` cerraba la aplicación que se estaba arrancando mientras la máquina virtual se reiniciaba, y fallaban las dos.

Ahora: pulsar varias veces la misma aplicación = un solo arranque; cambiar de aplicación pone en cola y espera a que termine el arranque anterior.

## 5. La consola negra al arrancar y el nombre de una aplicación que parpadea en la ventana nueva

- Tras Win11 cambiar el host de consola predeterminado a Windows Terminal, la ventana de consola de qemu pasa a pertenecer a `WindowsTerminal.exe` y no se puede reconocer la propiedad por pid / cadena de procesos padres / título; por eso en cada arranque parpadea en pantalla un recuadro negro de 200–300 ms. Ahora se reconoce con «instantánea de las ventanas de consola antes del arranque + ventana nueva en los 20 s posteriores + título vacío o con terminal», y se añade un canal de escaneo de alta frecuencia de 100 ms (solo durante los primeros 15 s).
- El proxy de ventanas guarda en caché el último título que puso, y `setTitle` estaba después de `show()`, de modo que la ventana nueva mostraba durante unos 0,5 s el nombre **de la aplicación anterior**. Ahora el título se fija antes de `show`.

## 6. Documentación: por qué `adb devices` no ve este dispositivo Android

El servicio adb de ApkBuddyStart se ejecuta en un **puerto dedicado, el 5044** (tu propio adb usa el 5037); el aislamiento es intencionado. Para conectarte: `$env:ANDROID_ADB_SERVER_PORT = 5044` y luego ejecuta `adb devices`.
Tampoco hagas `adb connect` a 5555 a mano: la imagen de Play Store muestra el diálogo «¿permitir depuración USB?» y se queda tapando la aplicación.

---

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.1.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Actualización: Store compara la versión de cuatro partes, `0.5.1.0 > 0.5.0.0`, así que puede sobrescribir la 0.5.0 ya enviada
- Los materiales de publicación están en `docs/store-listing.md` y los pasos en `docs/store-upload-walkthrough.md`

Pruebas: 9 + 25 + 117 = 151 superadas.
