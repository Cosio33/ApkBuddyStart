# ApkBuddyStart v0.5.8

Esta versión responde a la pregunta «después de instalar, ¿funciona y qué hay que cambiar?»: añade **revisión local · configuración automática**. Tras instalar, pulsa una vez: comprueba la virtualización de la CPU, la plataforma de hipervisor de Windows, la tarjeta y la memoria gráficas, la memoria RAM y la versión del sistema; corrige directamente lo que se puede, ofrece un botón para lo que necesita privilegios de administrador y explica claramente qué cambiar en la BIOS cuando no hay otra opción.

---

## 1. Qué se comprueba y cómo

| Elemento | Método |
|---|---|
| Virtualización de la CPU (VT-x / SVM) | `Win32_Processor` + indicadores del lado de la BIOS |
| Hyper-V / VBS en ejecución | `Win32_ComputerSystem.HypervisorPresent` |
| Plataforma de hipervisor (WHPX) | `Get-WindowsOptionalFeature`; sin permisos, se recurre a la doble pista de `WinHvPlatform.dll` + Hypervisor |
| Si la aceleración por hardware funciona ahora | `emulator -accel-check` (reutiliza la conclusión en caché) |
| Driver AEHD | `System32\drivers\aehd.sys` |
| Tarjeta / memoria gráfica / fecha del driver | `Win32_VideoController` + el registro `qwMemorySize` (`AdapterRAM` se trunca por encima de 4 GB y no es fiable) |
| Memoria / versión del sistema | `Win32_ComputerSystem` / `os.release()` |

**Hay un escollo que había que documentar sí o sí**: cuando Hyper-V / integridad de memoria (VBS) toma el control de VT, `VMMonitorModeExtensions` y `SecondLevelAddressTranslationExtensions` devuelven `False`.
Esto es justamente lo que pasaba en esta máquina (AMD 8745HS + WHPX disponible) y la primera versión lo interpretó como «la CPU no admite virtualización», dando un falso negativo a una máquina que sí podía usar aceleración por hardware. Ahora solo se concluye que no hay soporte cuando «no hay Hypervisor **y** la aceleración tampoco está disponible»; en cualquier otro caso se marca como desconocido.

## 2. Qué se configura automáticamente

Tras pulsar «aplicar la configuración recomendada» solo se escriben estos valores (todos seguros y reversibles en cualquier momento):

| Ajuste | Regla |
|---|---|
| Memoria | 32 GB→8 GB / 16 GB→6 GB / 12 GB→4 GB / 8 GB→3 GB / menos→2 GB, y nunca más de la mitad de la memoria del anfitrión |
| Núcleos de CPU | más de 8 hilos→4 núcleos; de 4 a 7→2–3 núcleos; siempre se deja al menos 1 núcleo para Windows |
| Calidad gráfica | sin aceleración o memoria gráfica <512 MB→540×960; en caso contrario, automática |
| Backend de renderizado | con aceleración→se deja a la cadena de degradación automática; sin aceleración→`software` |
| Forzar emulación por software | sin aceleración→activado |

Además, los parámetros de esta máquina se **fijan en un driver** (`auto-<fabricante>-<build>.json`, priority 5), que se aplica automáticamente en cada arranque sin tener que repetir la revisión. El driver sigue sometido a la validación de listas blancas de la 0.5.7: lo que genera la revisión no puede saltarse los límites de parámetros.

## 3. Lo que requiere tu intervención

| Situación | Interfaz |
|---|---|
| VT-x / SVM no activado en la BIOS | Solo se dan los pasos (reiniciar y entrar en la BIOS → SVM Mode / Intel VT-x → Enabled); **no se finge que se puede con un clic** |
| Función de Windows desactivada (edición instalada) | «Activar con un clic (requiere administrador)» → eleva privilegios y activa HypervisorPlatform + VirtualMachinePlatform → pide reiniciar |
| Función de Windows desactivada (edición de la Store) | «Abrir la ventana de características de Windows» + instrucciones de marcado (MSIX tiene mediumIL fijo y no puede elevar privilegios por sí solo) |
| Sin aceleración pero CPU compatible (edición instalada) | Se ofrece además «instalar el driver AEHD (requiere administrador)» |
| Driver gráfico con más de 3 años | Se recomienda actualizarlo en la web del fabricante (no se instala automáticamente: una versión equivocada sería peor) |

## 4. Interfaz

La página de ajustes añade «Revisión local · configuración automática»: enumera cada conclusión (verde ok / amarillo warn / rojo bad), con una explicación concreta y un botón accionable en cada una; abajo, un resumen en una frase y la configuración recomendada.
La revisión tarda unos 2–3 s (una llamada a PowerShell obtiene toda la información del hardware y otra consulta las funciones del sistema; sin permisos, se degrada automáticamente).

## 5. Verificación

- Nuevo `test/preflight-test.js` con **22 pruebas**: límites de recomendación de recursos, sugerencia de backend de renderizado, las tres conclusiones (BIOS / Store / edición instalada), regresión del falso diagnóstico de WMI, «la configuración automática solo escribe valores seguros», que el driver generado pase la validación de drivers y que se pueda dar una conclusión aunque falle la detección;
- Suite completa de pruebas solo con Node: **309 pruebas superadas**;
- Prueba real en esta máquina: AMD 8745HS / Radeon 780M / 32 GB / WHPX disponible → `level=good`, recomendación de 6 GB + 4 núcleos + renderizado auto, y se genera el driver `auto-amd-26300` (swangle).

## Notas de actualización desde 0.5.7

- `0.5.8.0 > 0.5.7.0`; la Store puede sobrescribir la actualización directamente; se conservan aplicaciones, partidas e instantáneas ya instaladas.
- La revisión **no se ejecuta automáticamente**: si no pulsas «iniciar revisión», no se hace ninguna detección ni se cambia ningún ajuste.
- Quienes hubieran configurado memoria / núcleos a mano: los valores recomendados por la revisión sobrescriben esos dos ajustes (es justo lo que significa «aplicar la configuración recomendada»); si no quieres que se sobrescriban, no pulses aplicar y limitate a ver el informe.

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.8.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Materiales de envío: `docs/store-listing.md` (incluye el texto «What's new» de esta versión en español e inglés)
- Documentación: `docs/preflight.md` (revisión) y `docs/drivers.md` (drivers)
