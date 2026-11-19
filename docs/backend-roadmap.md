# Evaluación de la base Android (rama v0.5.0)

> Contexto: v0.4.3 usaba el emulador nativo de Google con una ventana Qt, que luego se incrustaba en una ventana de Electron.
> Esta vía de incrustación tiene una serie de problemas congénitos (bordes negros, desalineación de coordenadas, que no llene el espacio, conflictos de orientación del panel Qt).
> Este documento registra la evaluación de viabilidad de «cambiar de base» y el enfoque realmente implementado en v0.5.0.

## Resumen de conclusiones

| Opción | Rendimiento | Estabilidad | Distribución / cumplimiento | Trabajo | Conclusión |
|------|------|--------|-----------|--------|------|
| **A. Emulador actual + modo de ventana independiente** | Medio | Alto | Sin problemas | Pequeño | ✅ **Implementado en v0.5.0** |
| **B. Waydroid + WSL2** | Alto | Medio | Sin problemas | Grande | ⚠️ Viable, pero con requisitos estrictos |
| **C. Waydroid + VM Linux ligera** | Alto | Medio | Sin problemas | Grande | ⚠️ Igual que B, y más pesada |
| **D. Edición de PC de Yingyongbao (App Store de Tencent)** | Alto | Alto | ❌ Código cerrado | — | ❌ No viable |
| **E. WSA de Microsoft** | Alto | — | ❌ Soporte finalizado | — | ❌ No viable |
| **F. Cambiar a FydeOS / PhoenixOS / Bliss OS** | Alto | Medio | Sin problemas | Enorme | ❌ Conflicto con el posicionamiento del producto |

## A. Modo de ventana independiente (implementado)

En lugar de incrustar la ventana del emulador en la nuestra mediante `SetParent`, dejamos que el emulador abra su propia
ventana nativa y nosotros solo nos encargamos de «abrir la aplicación → colocar esa ventana ante el usuario».

**Por qué esto es mejor que seguir arreglando la incrustación**: los problemas del modo incrustado (bordes negros, desalineación de coordenadas,
clics que no corresponden, que no llene el espacio) tienen su causa raíz en «tratar una ventana Qt/OpenGL como una ventana hija corriente». Cada
arreglo provoca el siguiente. En el modo de ventana independiente, el renderizado, la asignación de entradas y el ajuste de tamaño corren por cuenta
del emulador, que es justamente su punto fuerte.

**Implementado**:
- Ajuste `display.windowEmbed` (`embed` / `detached`), seleccionable en la UI.
- `appwin.openDetached()`: oculta la ventana vacía → rompe la relación padre-hijo → muestra la ventana nativa →
  la centra según la proporción del panel.
- `agent.ps1` incorpora los comandos `layout` / `detach` / `perf`; bajo `_detachedMode`
  la lógica de limpieza hace solo lo mínimo y no oculta la ventana que el usuario está viendo.
- El tamaño debe **calcularse bien a la primera según la proporción del panel**: la ventana nativa del emulador bloquea su propia relación de aspecto; dar una proporción errónea hace que
  la corregija (si das 1280 de ancho, en realidad solo hay 400).

**Pruebas reales** (en esta máquina Ryzen 7 8745HS / Win10 26300 / AEHD):
la app Hongguo (dramas cortos gratuitos) llena por completo la ventana nativa `Android Emulator - apkstart:5554`,
con la orientación correcta, clics correspondientes y sin bordes negros.

**Coste**: un icono más en la barra de tareas; la apariencia no queda completamente unificada con la ventana principal.

## B / C. La vía Waydroid

Waydroid es una solución basada en contenedores LXC (no una máquina virtual): reutiliza el kernel Linux del host para ejecutar directamente el
framework de Android y dibuja los gráficos directamente en Wayland, por lo que su rendimiento es claramente superior al de cualquier emulador.

**Requisitos estrictos** (todos obligatorios):

1. **Necesita un kernel Linux funcional**, compilado con binder / ashmem.
   - El kernel oficial de WSL2 de Microsoft **viene sin binder por defecto**; hay que compilar uno propio desde
     `microsoft/WSL2-Linux-Kernel` con opciones como `CONFIG_ANDROID_BINDER_IPC` y reemplazarlo.
2. **Necesita una sesión Wayland**. Waydroid no funciona sobre X11.
3. **Necesita nodos de renderizado GPU `/dev/dri/renderD*`**, y **no admite controladores propietarios de NVIDIA**.
4. **Necesita la infraestructura de Hyper-V / WSL2** (si se sigue la vía WSL2).

**Situación real de esta máquina**:

| Requisito | Estado |
|------|------|
| `HypervisorPresent` | `False` — Hyper-V no está activado |
| WSL | Solo está el stub `wsl.exe`, **no hay ninguna distribución instalada** |
| AEHD | En funcionamiento (el emulador se acelera con él) |
| GPU | AMD Radeon 780M (válida, no es NVIDIA) |
| CPU / RAM | 16 hilos / 31,3 GB (suficiente) |

**Conflicto clave**: ApkBuddyStart se apoya actualmente en **AEHD** (Android Emulator Hypervisor Driver)
para la aceleración. AEHD y Hyper-V son **mutuamente excluyentes**: al activar Hyper-V, AEHD deja de funcionar. Por tanto,
Waydroid no puede coexistir con la base del emulador actual en la misma máquina al mismo tiempo; hay que elegir una u otra.

**La opción C (VM Linux ligera) es más pesada que B**: consiste en ejecutar además una máquina virtual Linux completa en Windows
(QEMU/VirtualBox/Hyper-V) e instalar Waydroid dentro, lo que supone dos capas de virtualización +
la distribución y empaquetado de una distro Linux completa. El tiempo de arranque, el espacio en disco y la complejidad de la primera configuración superarían con mucho
el actual «haz doble clic en un APK y listo».

**A Waydroid también le falta compatibilidad con ARM**: en un entorno x86 solo se ejecutan aplicaciones x86; las apps que solo traen
`libhoudini`/`libndk` para ARM necesitan una capa de conversión adicional, con la consiguiente pérdida de rendimiento. Muchos APK de dramas cortos y
redes sociales son exclusivamente arm64, lo cual es un punto débil para el posicionamiento de «el usuario suelta cualquier APK aquí».

## D. Edición de PC de Yingyongbao

Producto comercial de código cerrado, sin API pública: no se puede incrustar, ni distribuir con nosotros, ni garantizar su disponibilidad a largo plazo.
**No viable.**

## E. WSA de Microsoft

Microsoft finalizó su soporte en marzo de 2025 y cerró el canal oficial de distribución; además depende de Hyper-V, lo que entra en conflicto con
AEHD. Las versiones reempaquetadas por terceros plantean riesgos de cumplimiento. **No viable.**

## F. Cambiar de sistema operativo (FydeOS / PhoenixOS / Bliss OS)

Estos son **sistemas operativos completos**, no componentes para «ejecutar apps de Android en Windows». Adoptarlos implicaría
obligar al usuario a reinstalar el sistema, lo cual choca frontalmente con el posicionamiento de «doble clic en un APK en Windows y listo». Además,
PhoenixOS prácticamente ha dejado de recibir mantenimiento. **No se considera una dirección de producto.**

## Recomendaciones de cara al futuro

1. **Corto plazo**: el modo de ventana independiente (A) ya resuelve los problemas de experiencia más importantes; hay que pulirlo y
   observar los comentarios de los usuarios. Es el paso con mejor relación beneficio/coste.
2. **Medio plazo**: la capa de abstracción de bases intercambiables en `src/core/backends/` ya está lista (`Backend` +
   bits de capacidad `CAPS`); si en el futuro se quiere integrar Waydroid, bastará con añadir una implementación de backend,
   sin tocar el flujo principal.
3. **Si Waydroid se llega a hacer de verdad**, la única forma pragmática es: **un instalador independiente / una rama separada**,
   informando claramente al usuario de que «esta versión requiere activar Hyper-V y no puede coexistir con la versión de emulador», en lugar de
   pretender una conmutación fluida con la base actual.
