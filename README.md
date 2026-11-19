# ApkBuddyStart

 Ejecuta aplicaciones Android en Windows como si fueran programas nativos.

Instalas un `.apk` con doble clic y la aplicación se abre en **su propia ventana**, con **su propio icono en el escritorio y en la barra de tareas**. Todo el entorno Android viene integrado: no necesitas WSA, ni instalar un emulador aparte, ni configurar ADB.

> **ApkBuddyStart** es un proyecto derivado de [ApkBuddyStart](https://github.com/RoutineMiku/apkstart) de RoutineMiku (licencia MIT), reescrito con la interfaz 100 % en español. El motor —emulación QEMU, ADB y aprovisionamiento— se conserva; la capa de interfaz se reescribió desde cero con textos nativos en español, sin traducción en tiempo de ejecución.

## ¿Qué hace?

| | |
|---|---|
| **Doble clic en un APK** | Se registra la asociación `.apk`: desde el Explorador se instala directamente, sin abrir ventanas de emulador. |
| **Una ventana por app** | Cada aplicación corre en su propia ventana, con su icono real extraído del APK y su identidad propia en Windows. |
| **Runtime incluido** | Emulador QEMU, ADB y una imagen de Android 14. La primera vez se despliega y después arranca desde disco. |
| **Diagnóstico del equipo** | Revisa virtualización, aceleración gráfica, memoria y controladores, y propone correcciones automáticas. |
| **Aceleración hardware** | WHPX o AEHD, con conmutación automática a una imagen compatible si la app solo trae bibliotecas ARM. |
| **Ajustes avanzados** | Directorio compartido, red, resolución, asignación de teclas, idioma del Android invitado y más. |

**Requisitos:** Windows 10/11 de 64 bits. Se recomienda activar la virtualización en la BIOS.

## Descarga

Ve a [Releases](https://github.com/Cosio33/ApkBuddyStart/releases) y descarga una de estas opciones:

- **`ApkBuddyStart-*-Setup.exe`** — instalador completo, con el runtime ya incluido. Recomendado.
- **Versión portable** — descarga el runtime la primera vez que se ejecuta.

## Primer arranque

1. Instala o extrae ApkBuddyStart.
2. Ábrelo. La ventana de bienvenida mostrará en español los pasos pendientes.
3. Pulsa **«Instalar Android en el disco virtual»** si el entorno aún no está desplegado.
4. Cuando termine, arrastra un APK a la ventana o haz doble clic en él desde el Explorador.

La barra superior muestra en todo momento el estado del entorno y ofrece un botón de **revisión del sistema** si algo no está bien.

## Compilar desde el código

Necesitas **Node.js 20+** y **Python 3**.

```bash
git clone https://github.com/Cosio33/ApkBuddyStart.git
cd ApkBuddyStart
npm ci
npm test
npm start          # abrir en modo desarrollo
npm run pack       # versión portable (~100 MB)
npm run build:exe  # instalador completo
```

El runtime de Android se descarga durante la compilación y no está incluido en el repositorio.

## Estructura del proyecto

| Ruta | Contenido |
|---|---|
| `src/main.js` | Proceso principal de Electron: ventanas, bandeja, IPC y arranque |
| `src/preload.js` | Puente seguro entre la interfaz y el proceso principal |
| `src/ui/` | Interfaz en español (HTML + JavaScript) |
| `src/core/` | Motor: emulador, ADB, instalador, provisionamiento, diagnóstico |
| `build/` | Descarga del runtime, empaquetado y metadatos del ejecutable |
| `test/` | Suite de pruebas (120 comprobaciones) |
| `.github/workflows/` | Integración continua y publicación de releases |

## Sobre el idioma

Toda la interfaz, los mensajes, los diálogos y las notificaciones están escritos **directamente en español en el código fuente**. No existe una capa de traducción en tiempo de ejecución.

El selector **«Idioma del sistema»** en Ajustes cambia el idioma del **Android emulado**, no el de ApkBuddyStart.

## Licencia

MIT. Proyecto derivado de ApkBuddyStart, de RoutineMiku, también bajo licencia MIT.
