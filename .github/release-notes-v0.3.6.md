# ApkBuddyStart v0.3.6

> En una frase: **arreglado el «Hongguo se queda en pantalla negra tras pulsar «Aceptar y continuar»»**. La causa real era que el Wi-Fi de la máquina virtual Android tardaba demasiado en conectarse y la aplicación cargaba la portada sin red, dejando solo un fondo negro. No tiene nada que ver con la GPU ni con el backend de renderizado.

## 1. Pantalla negra al pulsar «Aceptar» en Hongguo: causa real y solución

### El diagnóstico erróneo de la versión anterior

La v0.3.5 atribuía la pantalla negra al backend GPU (swangle / software); estaba **equivocada**. Cambiar de backend, por supuesto, no servía de nada.

### La causa real localizada con pruebas en esta versión

Investigando capa por capa con adb:

- `cmd wifi status`: `Wifi is not connected`; `ip -o addr show wlan0`: **ninguna dirección IP**;
- es decir, **la máquina virtual no tenía red en ese momento**;
- el diálogo de privacidad de Hongguo es una página local, por lo que se muestra con normalidad; al pulsar «Aceptar y continuar» necesita cargar los datos de la portada; si no los consigue, los renderiza como un bloque negro entero: eso es lo que el usuario ve como «pantalla negra tras pulsar aceptar»;
- y `sys.boot_completed` solo significa que el sistema ha arrancado; **la asociación del Wi-Fi + DHCP suelen llevar varias decenas de segundos hasta más de dos minutos**.
  La aplicación arranca antes de que la red esté lista, todas las peticiones de la portada fallan y la página se queda negra.

Prueba real: en la misma máquina virtual, consultar justo después del arranque da «sin IP», y consultar uno o dos minutos después da
`wlan0 inet 10.0.2.16/24` y `Wifi is connected to "AndroidWifi"`; en ese momento la portada de Hongguo funciona perfectamente.

### Correcciones de esta versión

1. **Esperar a que la red esté lista antes de lanzar la aplicación**: `installer.launch` espera hasta 150 s antes de `am start`, y registra en el registro `esperando a que la máquina virtual Android se conecte a la red… N s`; solo cuando está lista lanza realmente la aplicación, evitando de raíz la pantalla negra causada por «la aplicación arranca antes que la red».
2. **Revisión de red tras el arranque**: en cuanto el arranque termina correctamente, se comprueba si la máquina virtual ha obtenido una IP; sin red, el registro indica la causa explícitamente y el usuario ya no tiene que adivinar frente a una pantalla negra.
3. **Ajustes → Reparar red** (botón nuevo): reparación con un clic. Consiste en restablecer los datos de usuario de Android y reiniciar, y esperar entonces hasta que la red esté lista (máximo 4 minutos); si funciona, se guarda el estado «red correcta» como instantánea de arranque rápido.
   - **La lista de aplicaciones se conserva**: al abrir una aplicación se reinstala automáticamente, sin necesidad de reinstalar el APK a mano;
   - Se pierden los datos de runtime propios de la aplicación, como la sesión de inicio y el historial de series, por lo que hay que volver a iniciar sesión;
   - Solo afecta al AVD actual; no se tocan la imagen del sistema ni la caché de APK locales.

> Si Hongguo sigue en pantalla negra: primero abre Hongguo directamente (esta versión espera automáticamente a la red); si sigue negra, pulsa «Ajustes → Reparar red».

## 2. Sigue en vigor la corrección de «limpiar caché» de la versión anterior

No se han cambiado `includeSnapshots` ni «restablecer datos de Android» de la v0.3.5; siguen funcionando.

## 3. Limitaciones conocidas

- Esta imagen de Android 14 (`google_apis_playstore`) tiene un problema de la versión original: al arrancar en frío **con datos de usuario ya existentes**, el Wi-Fi suele quedarse en `NO-CARRIER` y no consigue IP; en cambio, el arranque justo después de restablecer los datos se conecta con normalidad. Por eso «Reparar red» restablece los datos y guarda enseguida una instantánea para conservar el estado utilizable.
- La imagen de Play Store no permite `adb root`, así que no se puede borrar por separado la configuración Wi-Fi defectuosa.

## 4. Registro de pruebas

- Tras la corrección: pulsar «Aceptar y continuar» → entra en `MainFragmentActivity`, y la portada muestra con normalidad la lista de series y el flujo de recomendaciones (confirmado con captura, sin pantalla negra).
- En la misma máquina virtual, tras esperar a que la red esté lista: `wlan0 inet 10.0.2.16/24`, `Wifi is connected to "AndroidWifi"`.
- `npm test`: **113 pruebas, todas superadas** (8 + 25 + 80).

## 5. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
