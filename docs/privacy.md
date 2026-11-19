# ApkBuddyStart Política de privacidad / Privacy Policy

Última actualización: 2026-11-16

## Español

ApkBuddyStart es un ejecutor de aplicaciones Android que se ejecuta localmente. Nuestro principio es simple: **no recopilamos, subimos ni compartimos tus datos personales.**

### 1. Qué no recopilamos

- No recopilamos cuentas, nombres, correos electrónicos, números de teléfono ni otros datos de identidad (esta aplicación no tiene sistema de cuentas).
- No recopilamos identificadores de dispositivo, ID de publicidad ni información de ubicación.
- No integramos ningún SDK de análisis, seguimiento, informes de fallos ni publicidad.
- No enviamos ningún dato a nuestros servidores (esta aplicación no tiene servidores propios).

### 2. Datos guardados localmente

Los siguientes datos se guardan únicamente en tu propio ordenador y nunca salen del dispositivo:

| Ubicación | Contenido |
|---|---|
| `%USERPROFILE%\ApkBuddyStart\data` | Imagen de sistema Android, aplicaciones instaladas, datos de aplicaciones, instantáneas |
| `%USERPROFILE%\ApkBuddyStartShared` | Carpeta compartida sincronizada bidireccionalmente con `/sdcard/ApkBuddyStartShared` de Android |

Desinstalar la versión de Microsoft Store no elimina automáticamente los directorios anteriores; puedes borrarlos manualmente cuando quieras.

### 3. Comportamiento de red

- **Versión de Microsoft Store**: el paquete de instalación incluye todos los componentes de ejecución; el primer inicio solo realiza una extracción local y no descarga ningún contenido ejecutable. Las actualizaciones las gestiona Microsoft Store.
- **Versión de instalador / portátil**: solo se accede a las listas de Release de GitHub / Gitee al comprobar actualizaciones; la versión ligera descarga el paquete de ejecución desde el Release del proyecto en el primer inicio. Las solicitudes contienen únicamente el número de versión y las cabeceras HTTP estándar necesarias para la descarga.
- El acceso a la red de las propias aplicaciones Android lo decide cada aplicación, y utiliza el NAT en modo usuario de QEMU compartiendo la red del host; ApkBuddyStart no inspecciona ni conserva el contenido.

### 4. Terceros

Las aplicaciones Android que ejecutas a través de ApkBuddyStart son proporcionadas por sus respectivos desarrolladores, y su tratamiento de datos se rige por sus propias políticas de privacidad. ApkBuddyStart no controla ni representa a estas aplicaciones de terceros.

### 5. Niños

Esta aplicación no está dirigida a menores de 13 años y no recopila información de niños de forma intencionada.

### 6. Cambios y contacto

Si la política cambia, se actualizará esta página y se modificará la fecha de «Última actualización».
Para consultas, abre un issue en https://github.com/RoutineMiku/apkstart/issues

---

## English

ApkBuddyStart is a locally-running Android app runner. Our principle is simple: **we do not collect, upload, or share your personal data.**

- No account system, no identity data, no device identifiers, no advertising ID, no location.
- No analytics, telemetry, crash-reporting, or advertising SDKs.
- No data is sent to any server operated by us — we do not operate one.

Local data (never leaves your device):

| Path | Content |
|---|---|
| `%USERPROFILE%\ApkBuddyStart\data` | Android system image, installed apps, app data, snapshots |
| `%USERPROFILE%\ApkBuddyStartShared` | Shared folder synced with `/sdcard/ApkBuddyStartShared` inside Android |

Network behaviour:
- **Microsoft Store build**: all runtime components are bundled; first launch only extracts locally. Updates are delivered by Microsoft Store.
- **Installer / portable build**: GitHub and Gitee Release endpoints are contacted only when you check for updates; the lightweight build downloads the runtime package on first launch. Requests contain only the version and standard HTTP headers.
- Network access from Android apps is decided by those apps. Traffic uses QEMU user-mode NAT over the host network; ApkBuddyStart does not inspect or retain it.

Third-party apps you run are provided by their own developers and governed by their own privacy policies.

Contact: open an issue at https://github.com/RoutineMiku/apkstart/issues
