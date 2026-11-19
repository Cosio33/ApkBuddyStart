# Comprobación local · Configuración automática

> A partir de la versión 0.5.8, la página de ajustes incluye «Iniciar comprobación»: primero determina si esta máquina puede ejecutar la aplicación y qué hay que cambiar;
> lo que se puede cambiar automáticamente se cambia, lo que requiere elevación de privilegios muestra un botón, y lo que solo se puede hacer en la BIOS se explica claramente.

## 1. Qué se comprueba

| Elemento | Cómo se comprueba | Si no se puede determinar |
|---|---|---|
| Virtualización de CPU (VT-x / SVM) | `VirtualizationFirmwareEnabled` / `VMMonitorModeExtensions` de `Win32_Processor` | Se registra como «desconocido» y se solicita confirmación manual |
| Si Hyper-V / VBS están activos | `Win32_ComputerSystem.HypervisorPresent` | Desconocido |
| Plataforma de hipervisor (WHPX) | `Get-WindowsOptionalFeature -FeatureName HypervisorPlatform`; sin permisos, se recurre a `WinHvPlatform.dll` + la existencia del hipervisor | Desconocido (para tratarlo como «función disponible» se requieren dos evidencias) |
| Si la aceleración por hardware está disponible actualmente | `emulator -accel-check` (reutiliza la conclusión en caché del provisioner) | Se considera no disponible |
| Controlador AEHD | `%SystemRoot%\System32\drivers\aehd.sys` | Se considera no instalado |
| GPU / VRAM / versión del controlador | `Win32_VideoController` + el registro `HardwareInformation.qwMemorySize` (`AdapterRAM` se trunca cuando supera los 4 GB y no es fiable) | GPU desconocida |
| Memoria / versión del sistema | `Win32_ComputerSystem`, `os.release()` | — |

**Trampa de WMI**: en cuanto Hyper-V / Integridad de memoria (VBS) toman el control de VT, `VMMonitorModeExtensions`
y `SecondLevelAddressTranslationExtensions` devuelven `False`, aunque la máquina perfectamente puede ejecutar aceleración por hardware.
Por eso, cuando estos dos campos son `False`, solo se determina «sin compatibilidad con virtualización» si «no hay hipervisor y la aceleración tampoco está disponible»; en caso contrario se tratan como desconocidos. De lo contrario, se clasificaría erróneamente una máquina sana como incapaz de ejecutarse.

## 2. Qué se cambia automáticamente

Tras completar la comprobación, haz clic en «Aplicar configuración recomendada»; solo se escriben estos elementos (todos son seguros y se pueden revertir en cualquier momento desde los ajustes):

| Ajuste | Regla |
|---|---|
| `memoryMB` | Equipo de 32 GB → 8 GB; 16 GB → 6 GB; 12 GB → 4 GB; 8 GB → 3 GB; menor → 2 GB. Y nunca supera la mitad del host |
| `cores` | Más de 8 hilos → 4 núcleos; 4~7 → 2~3 núcleos; se deja siempre al menos 1 núcleo para Windows |
| `renderSize` | Sin aceleración por hardware, o VRAM <512 MB → `540x960`; de lo contrario `auto` |
| `gpuMode` | Con aceleración `auto` (se deja a la cadena de degradación); sin aceleración → `software` |
| `forceTcg` | Sin aceleración por hardware → `true` |

Al mismo tiempo, los parámetros de esta máquina se fijan en un controlador (`%APPDATA%\apkstart\drivers\auto-<fabricante>-<build>.json`,
`priority: 5`), que se aplica automáticamente en cada arranque posterior sin necesidad de repetir la comprobación.
El controlador también debe pasar la validación de la lista blanca: lo generado por la comprobación no puede eludir los límites de parámetros.

## 3. Cosas que requieren la participación del usuario

| Situación | Qué ofrece la interfaz |
|---|---|
| VT-x / SVM no activado en la BIOS | **Solo instrucciones manuales** (reiniciar y entrar en la BIOS → Intel VT-x / SVM Mode → Enabled). Este paso no se puede realizar automáticamente |
| Funciones de Windows desactivadas (versión instalada) | «Activar con un clic (requiere administrador)» → elevación para ejecutar `dism` y activar HypervisorPlatform + VirtualMachinePlatform → se solicita reiniciar |
| Funciones de Windows desactivadas (versión de la tienda) | «Abrir la ventana «Funciones de Windows»»: MSIX está fijado a mediumIL y no puede elevar sus privilegios, por lo que solo se ofrece el acceso y las opciones a marcar |
| Sin aceleración y CPU compatible con virtualización (versión instalada) | Se ofrece además «Instalar el controlador AEHD (requiere administrador)» |
| Controlador de GPU demasiado antiguo (>3 años) | Solo se recomienda actualizar desde la web del fabricante; no se instala automáticamente (instalar una versión equivocada sería peor) |

## 4. Niveles de conclusión

- `ok`: este elemento no presenta problemas;
- `warn`: funciona, pero se recomienda optimizarlo (poca memoria, controlador antiguo, versión de sistema baja, no se pueden leer los datos del hardware);
- `bad`: si no se corrige, no se puede ejecutar (virtualización no activada en la BIOS, funciones de Windows desactivadas).

El nivel global de la comprobación es el peor de los elementos; cada uno tiene un punto de color y una explicación concreta en la interfaz, sin mensajes genéricos de «error desconocido».

## 5. Privacidad

Toda la detección se realiza localmente: solo se leen WMI / registro / existencia de archivos del sistema; no se envían solicitudes ni se sube información alguna.
El informe de diagnóstico exportado solo contiene campos necesarios para la resolución de problemas, como el modelo, la versión del controlador y la memoria.
