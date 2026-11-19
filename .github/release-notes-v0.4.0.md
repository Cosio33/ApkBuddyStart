# ApkBuddyStart v0.4.0

> En una frase: se corrige la regresión «Hongguo no abre / se queda en pantalla negra», un clic en la bandeja abre la interfaz principal, se vuelve a exprimir la velocidad de arranque y se suprimen de forma unificada las ventanas parásitas durante la ejecución.

## 1. Corrección: Hongguo no abre / se queda en pantalla negra (regresión de v0.3.9)

**Causa**: para «esperar a que la red esté lista antes de lanzar la aplicación», la versión anterior incluía en el flujo de arranque una lógica de espera con **reintento en frío**. Cuando la red va lenta, esa lógica «detiene la máquina virtual y la reinicia en frío», justo cuando la aplicación está a punto de ejecutar `adb install` / `am start`; el dispositivo desaparece a mitad de camino y aparece:

```
adb.exe: device 'emulator-5554' not found
launch failed com.phoenix.read
```

**Corrección**:

- **En la ruta de arranque solo se espera, nunca se reinicia**: se espera como máximo 20 s y, si no se consigue red, se lanza igualmente la aplicación (la página puede ir más lenta, pero no puede fallar directamente);
- El trabajo pesado, como el arranque en frío o el restablecimiento, solo se hace cuando el usuario pulsa explícitamente «Reparar red»;
- `waitForNetwork` ya no se rinde en cuanto ve `device-offline`: una máquina virtual recién reiniciada puede tardar decenas de segundos en aparecer en adb, y ahora se le da un margen de 45 s (antes, esto hacía que se interpretara erróneamente como «reparación fallida»).

**Además, se ha corregido «Reparar red»**: en pruebas, esta imagen solo consigue una conexión estable en el arranque posterior a `-wipe-data`, así que ahora se restablecen directamente los datos (se conserva la lista de aplicaciones y abrirlas las reinstala automáticamente) y, en cuanto hay red, **se guarda de inmediato una instantánea**, de modo que al restaurarla se recupera también el estado de la tarjeta de red.

En pruebas: tras la corrección, el registro de arranque muestra `máquina virtual en red lista (10.0.2.16)`; pulsar «Aceptar y continuar» entra en `MainFragmentActivity` y la portada muestra con normalidad las series y el flujo de recomendaciones.

## 2. Bandeja: un clic abre la interfaz principal

Antes solo estaba enlazado el doble clic; si el usuario hacía un solo clic y no pasaba nada, pensaba que el icono de la bandeja estaba roto. Ahora un clic abre directamente la ventana principal (el botón derecho sigue mostrando el menú y el doble clic sigue funcionando como antes).

## 3. Velocidad de arranque

- La ruta de arranque ya no hace reintentos en frío, eliminando esperas de 3 a 5 minutos;
- La espera de red baja de 60 a **20 segundos**, y si el dispositivo se desconecta se vuelve de inmediato en lugar de quedarse girando;
- Tras reparar la red se guarda una instantánea «red correcta» y se restaura desde ella en cada arranque posterior: en pruebas, el arranque completo (encendido → red → instalación → incrustación) tarda unos **48 segundos**, de los cuales unos 20 son de encendido.

## 4. Ventanas parásitas durante la ejecución

El proxy de ventanas añade una capa de respaldo: oculta de forma unificada todas las ventanas de nivel superior visibles y sobrantes creadas por **procesos que pertenecen a nuestro directorio de runtime** (cuadros de aviso de Qt, diálogos de fallo, barras de volumen, ventanas de registro, etc.), conservando solo la ventana principal del emulador que debe incrustarse en el anfitrión. La implementación anterior las iba nombrando una por una por nombre de clase, y si se escapaba una, parpadeaba una vez.

## 5. Refuerzo de ingeniería

- `agent.ps1` vuelve a llevar **BOM UTF-8**. Antes, guardarlo de forma normal perdía la BOM y PowerShell 5.1 leía los comentarios en chino como ANSI, pudiendo unir el comentario con la siguiente línea de código y provocar un fallo de compilación en `Add-Type` (que se manifestaba como «fallo al iniciar el proxy de ventanas / la ventana de la aplicación no se incrusta»).
- Nueva prueba de regresión: **el script del proxy de ventanas debe llevar BOM UTF-8**; si se vuelve a perder, la prueba fallará directamente.

## 6. Pruebas reales

- `npm test`: **114 pruebas, todas superadas** (8 + 25 + 81).
- Hongguo: arranque → aceptar → la portada muestra el flujo de vídeos con normalidad (confirmado con captura).
- Un clic en la bandeja abre la interfaz principal.

## 7. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
