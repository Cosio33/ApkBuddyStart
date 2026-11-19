# ApkBuddyStart v0.5.2

Esta versión corrige una sola cosa: **la edición de Microsoft Store avisa de que «la aceleración por hardware no está habilitada» tras la instalación**.

## Por qué los usuarios de la Store se encuentran con esto siempre

El emulador de Android en Windows solo tiene dos caminos de aceleración:

| Método | Qué es | Necesita administrador | Necesita reinicio |
|---|---|---|---|
| **AEHD** | Driver de kernel propio de Google | Al instalar el driver | No |
| **WHPX** | Función integrada de Windows «Plataforma de hipervisor de Windows» | Al activar la función | Sí |

Los paquetes de Microsoft Store (MSIX) se lanzan mediante el modelo de despliegue AppX con mediumIL fijo: **no pueden instalar drivers de kernel ni obtener autorización de administrador**.
Por eso a la edición de la Store solo le queda el camino WHPX, y la función «Plataforma de hipervisor de Windows» viene **desactivada por defecto** en un Windows recién instalado; en cuanto terminas de instalar, aparece el aviso de que no hay aceleración por hardware y solo queda la emulación por software (arranque de varios minutos).

## Dónde estaba el error en la versión anterior

1. Pulsar «Reparar» usaba `Start-Process -Verb RunAs` para elevar privilegios, algo que una aplicación empaquetada no puede conseguir: estaba abocado al fracaso y el aviso nunca desaparecía.
2. El texto del aviso decía «se recomienda instalar el driver AEHD o activar la plataforma de máquinas virtuales»; la edición de la Store no puede instalar drivers, así que era un callejón sin salida.
3. Solo se mencionaba «plataforma de máquinas virtuales (VirtualMachinePlatform)», que es la función que necesita **WSL2**; el emulador necesita la **«plataforma de hipervisor (HypervisorPlatform)»**. Activar solo la primera deja `emulator -accel-check` diciendo que no está disponible.
4. Se usaba la existencia de `WinHvPlatform.dll` para decidir «si se toma la rama WHPX»; ese DLL está siempre presente en el Windows moderno (en esta máquina existe y se ejecuta con AEHD), así que la comprobación no servía para nada.
5. Tras activar la función con éxito no se limpiaba la caché de aceleración, y la interfaz seguía mostrando la conclusión antigua.

## Cómo se hace ahora

- **Edición de la Store**: pulsar «Reparar» ya no abre una autorización de administrador que nunca vas a conseguir, sino que **abre directamente el cuadro de diálogo «Activar o desactivar las características de Windows»** (`optionalfeatures.exe`, la única parte donde está esa opción) y te dice claramente que marques «Plataforma de hipervisor de Windows» y reinicies una vez al terminar.
- **Edición instalada / portable**: sigue siendo activación con un clic (UAC) y, si falla, se instala automáticamente el driver AEHD; si el usuario pulsa «No», se dice explícitamente «has cancelado la autorización», en lugar de un vago «no se pudo activar».
- Se activan ambas funciones de una vez (primero HypervisorPlatform y luego VirtualMachinePlatform) y se limpia la caché de aceleración al terminar.
- Al ejecutar con emulación por software, **la primera vez que se abre una aplicación aparece una notificación del sistema** que explica que la aceleración puede ir de 5 a 10 veces más rápido y dónde activarla. (La autocomprobación de los ajustes está escondida y quien está esperando a que arranque no la ve.)

## Activarla uno mismo en la edición de la Store (dos caminos equivalentes)

Interfaz gráfica: `Win+R` → escribe `optionalfeatures` → marca **Plataforma de hipervisor de Windows** → Aceptar → reinicia.

PowerShell como administrador:

```powershell
dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

## Otros detalles

- Se añade este texto a las Notes for certification de `docs/store-listing.md` para que el revisor no califique el aviso como «no se puede utilizar».
- El README incluye una sección «qué hacer si aparece el aviso de que la aceleración por hardware no está habilitada» (con los dos comandos de arriba).

---

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.2.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Actualización: `0.5.2.0 > 0.5.1.0 > 0.5.0.0`; puede sobrescribir directamente las versiones enviadas antes

Pruebas: 9 + 25 + 118 = 152 superadas.
