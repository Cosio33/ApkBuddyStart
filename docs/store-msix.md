# Versión de Microsoft Store (MSIX)

Los scripts y los cambios en la aplicación de este directorio tienen como objetivo producir un paquete de Microsoft Store
«que se descarga una vez y funciona nada más instalarlo»: ya incluye el emulador de Android, platform-tools y la imagen del sistema, y el usuario no necesita ningún despliegue con conexión a red.

> Situación en pocas palabras: **la cadena de empaquetado está lista; que se pueda publicar de verdad solo depende de que tengas una cuenta de Partner Center.**
> Todo lo que se puede automatizar (manifiesto, iconos, empaquetado, autofirma, verificación) está en este documento;
> lo que hay que hacer a mano en la web (registrar la cuenta, subir el paquete, rellenar el listing, enviar a certificación) se enumera como lista de tareas al final.

---

## 1. En qué se diferencia del instalador NSIS actual

| | NSIS (`npm run build:exe`) | MSIX (versión de tienda) |
|---|---|---|
| Ubicación de instalación | `%LOCALAPPDATA%\Programs\ApkBuddyStart` (escribible) | `C:\Program Files\WindowsApps\...` (**solo lectura**) |
| Directorio de datos del usuario | `%APPDATA%\apkstart` | `%USERPROFILE%\ApkBuddyStart\data` |
| Ubicación de la ejecución | Se instala en el directorio de instalación, escribible | Se ejecuta directamente desde el paquete en solo lectura; la imagen se despliega en el directorio de datos |
| Actualización automática | Admite (descargar → reemplazar el exe → reiniciar) | **Desactivada**, las actualizaciones van por la tienda |
| Aceleración por hardware | WHPX, o descarga e instalación automática del controlador de kernel AEHD | **Solo WHPX** (MSIX no permite instalar controladores ni elevar privilegios) |
| Firma | No hace falta (el usuario asume SmartScreen) | No hay que firmar al enviar; la tienda vuelve a firmar |

Por qué se sacó el directorio de datos de `%APPDATA%`: las aplicaciones full-trust de MSIX redirigen las
**escrituras** bajo `%APPDATA%` / `%LOCALAPPDATA%` a `%LOCALAPPDATA%\Packages\<nombre-de-familia-del-paquete>\LocalCache\...`, mientras que las variables de entorno y las
API siguen devolviendo la ruta real previa a la redirección. Nosotros hacemos spawn de `emulator.exe` / `adb.exe` desde el directorio de datos,
y si el proceso hijo y el padre tienen visiones distintas de esas rutas, aparece el caso de «el archivo está ahí pero no se encuentra».
Al poner el directorio de datos en `%USERPROFILE%\ApkBuddyStart` (fuera de AppData, sin virtualización), el padre y el hijo ven
los mismos archivos reales y este tipo de problemas desaparecen de raíz. El código está en `STORE_BUILD` de `src/core/store.js`.

---

## 2. Cómo generar este paquete

### 2.1 Tres caminos; elige uno

**A. Completamente sin conexión (recomendado, el más fiable)**

```powershell
node build/pack.js      # genera dist/ApkBuddyStart-win64-portable (la carcasa, unos 228 MB)
node build/msix.js      # copia automáticamente build/runtime al paquete y luego crea el MSIX
```

`build/msix.js` prioriza `dist/ApkBuddyStart-win64-portable` como carga útil (sin necesidad de red) y
copia por su cuenta `build/runtime` a `app\resources\runtime`: equivale a los `extraResources` de electron-builder,
pero sin ir a buscar el conjunto de herramientas a una CDN. Si `build/runtime` no existe, ejecuta primero
`node build/prepare-runtime.js` (o `npm run runtime`).

**B. Un solo comando (mediante electron-builder)**

```powershell
npm run build:appx
```

Esto ejecuta `electron-builder --win appx --x64 --config electron-builder.yml` y genera
`dist/release/ApkBuddyStart-<versión>.appx`. ⚠️ Este paso descarga el propio conjunto de herramientas de electron-builder desde una CDN,
y **si no hay red o la conexión es inestable puede extraerse solo a medias** (`win-unpacked` se queda solo con `electron.exe`,
sin copiar `resources/runtime`), de modo que los paquetes generados después carecerán de la ejecución. En ese caso, vuelve al camino A.

**C. Armar el paquete uno mismo (máximo control)**

```powershell
npx electron-builder --win dir --x64 --config electron-builder.yml
node build/msix.js --payload dist/release/win-unpacked

# si quieres instalarlo localmente para probar, añade --sign (genera un certificado autofirmado y firma)
node build/msix.js --sign
```

El resultado está en `dist/store/ApkBuddyStart_<versión-de-cuatro-partes>_x64.msix`. Al final, el script se comprueba a sí mismo con ZipFile
que el paquete contiene `AppxManifest.xml` / `AppxBlockMap.xml` / `[Content_Types].xml` (si falta cualquiera de los tres, no se puede instalar),
e imprime la confirmación «ejecución integrada».

### 2.2 Qué hay que tener instalado en la máquina

- Node ≥ 20 (ya disponible)
- **`makeappx.exe`**: Windows 11 **no lo incluye**. El script `build/msix.js` prueba tres caminos en orden:
  1. `PATH`
  2. `C:\Program Files (x86)\Windows Kits\10\bin\<versión>\x64\makeappx.exe`
  3. El directorio de caché de electron-builder (disponible en cuanto se ha ejecutado `--win appx` una vez)

  Para instalarlo por separado: <https://developer.microsoft.com/windows/downloads/windows-sdk/>
  (marca solo Windows SDK; no hace falta instalar Visual Studio).

  Si no lo encuentra, el script deja el directorio de staging en `dist/store/.stage` e imprime un comando
  `makeappx pack` que se puede copiar y ejecutar directamente, para que el trabajo no se pierda.

---

## 3. Dos valores que hay que cambiar antes de enviar a la tienda

`Identity/@Name` e `Identity/@Publisher` en el manifiesto MSIX deben ser **exactamente, carácter por carácter**, iguales a los
`Package/Identity/Name` y `Package/Identity/Publisher` que muestra Partner Center → **Product management → Product identity**;
si difiere una sola letra, el paquete se rechaza.

Valores actuales por defecto (son marcadores de posición; para publicar de verdad hay que cambiarlos):

```
Identity Name      = RoutineMiku.ApkBuddyStart
Identity Publisher = CN=RoutineMiku
PublisherDisplayName = RoutineMiku
```

Tres formas de cambiarlos; elige una:

```powershell
# 1) modificar appx.identityName / appx.publisher en electron-builder.yml
# 2) modificar los valores por defecto IDENTITY / PUBLISHER al inicio de build/msix.js
# 3) sobrescribirlos con variables de entorno o parámetros de línea de comandos (recomendado, sin tocar el código)
node build/msix.js --identity "12345RoutineMiku.ApkBuddyStart" --publisher "CN=1a2b3c4d-1111-2222-3333-444455556666"
$env:APKSTART_MSIX_IDENTITY="12345RoutineMiku.ApkBuddyStart"
$env:APKSTART_MSIX_PUBLISHER="CN=1a2b3c4d-1111-2222-3333-444455556666"
```

---

## 4. Instalación local de prueba (solo autocomprobación, no hace falta para publicar)

> ⚠️ La firma local **requiere el Windows SDK completo**. El conjunto `winCodeSign` de la caché de electron-builder está recortado,
> y su `signtool.exe` da el error `A required function is not present` al firmar un MSIX (le falta el proveedor SIP de MSIX).
> Con el Windows SDK instalado, usa `C:\Program Files (x86)\Windows Kits\10\bin\<versión>\x64\signtool.exe`
> y no hay problema.

```powershell
node build/msix.js --sign          # genera un certificado autofirmado e intenta firmar
# si el paso anterior dice que signtool no está disponible, firma a mano con el del SDK:
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" `
  sign /fd SHA256 /a /f dist\store\ApkBuddyStart-test.pfx /p 'ApkBuddyStart!test' `
  dist\store\ApkBuddyStart_0.5.8.0_x64.msix

# en PowerShell de administrador, confía en el certificado (una sola vez)
Import-PfxCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' `
  -FilePath 'dist\store\ApkBuddyStart-test.pfx' `
  -Password (ConvertTo-SecureString 'ApkBuddyStart!test' -Force -AsPlainText)
Add-AppxPackage -Path 'dist\store\ApkBuddyStart_0.5.8.0_x64.msix'
```

Desinstalar: `Get-AppxPackage *ApkBuddyStart* | Remove-AppxPackage`

El Subject del certificado autofirmado debe coincidir con el `Publisher` del manifiesto; si no, salta `0x800B0109` / `0x80073CF3`.

---

## 5. Limitaciones conocidas (ponlas en el listing para que el usuario no se las encuentre)

0. **Tras la instalación no se descarga absolutamente nada por red**. El emulador, platform-tools y la imagen del sistema están todos en el paquete;
   la única acción única es «desplegar en el mismo sitio el `system.img.xz` incluido» en
   `%USERPROFILE%\ApkBuddyStart\data\system-images` (unos 1 minuto y unos 3,3 GB, solo descompresión local).
   La animación del primer arranque indicará que «los componentes de ejecución se incluyen en el instalador y no se descarga nada».
   Restricción en el código: `provision.systemImageInfo()` / `playImageInfo()` cuentan también la imagen comprimida como «lista»,
   y `autoDeploy()` en `main.js` omite directamente la red con la ejecución integrada (véase `bundledRuntimeDir`).
1. **Actualización del paquete completo**: MSIX no tiene descarga incremental, así que en cada versión el usuario vuelve a bajar ~852 MB.
2. **El primer inicio debe desplegar la imagen**: el `system.img.xz` del paquete (472 MB) se expande a ~3,3 GB, unos 1 minuto.
   El destino es `%USERPROFILE%\ApkBuddyStart\data\system-images`, no el directorio del paquete en solo lectura.
   Para lograr «cero espera al instalar» se podría distribuir la imagen ya desplegada, a costa de que el instalador pase de 852 MB a unos 4,4 GB
   (`build/msix.js` opta actualmente por «descarga pequeña + una descompresión local»).
3. **Solo funciona WHPX**: la versión de tienda no puede instalar el controlador de kernel AEHD. El usuario debe marcar «Plataforma de máquina virtual»
   en «Activar o desactivar las características de Windows»; si no, se cae a emulación por software TCG (muy lenta).
4. **Sin actualización automática**: las actualizaciones las gestiona Store (Ajustes → Aplicaciones → Actualizaciones).
5. **Los datos de Android se borran al desinstalar el paquete**: los datos están en `%USERPROFILE%\ApkBuddyStart\data`; desinstalar el MSIX no los
   elimina automáticamente (lo cual es bueno), pero «Restablecer la aplicación» sí lo hace.

---

## 6. Partes que hay que hacer a mano (los scripts no las sustituyen)

1. **Registrar una cuenta de desarrollador**: <https://storedeveloper.microsoft.com>
   (la entrada antigua de Partner Center para cuentas personales costaba 19 $ una vez; según la documentación de Microsoft, el nuevo proceso de arriba es gratuito,
   a costa de verificar la identidad con documento y selfie. Confía siempre en el importe que muestre la página de registro en ese momento.)
2. **Reservar el nombre de la aplicación** → obtén `Package/Identity/Name` y `Package/Identity/Publisher`.
3. **Subir el paquete**: se aceptan `.msix` / `.appx` / `.msixbundle`; en Win10+ se recomienda `.msixupload`
   (con archivos de símbolos para el análisis de fallos), pero también se permite subir directamente un `.appx` x64 suelto.
   Store acepta hasta **25 GB por paquete**; el nuestro es de ~1,3 GB.
4. **Preparar el listing**:
   - Al menos 1 captura (se recomiendan 4), de **1366×768 o superior**, en PNG, ≤50 MB, máximo 10
   - Descripción en español (las 3 primeras frases son las más importantes), categoría «Utilidades»
   - URL de la política de privacidad (esta aplicación no recopila datos personales, pero se recomienda publicar una página que explique el comportamiento de red)
5. **Cuestionario de clasificación por edades (IARC)**.
6. **Notes for certification** (explicación para el revisor): este apartado es **especialmente importante** para esta aplicación;
   te conviene copiar el texto siguiente y añadir tus propios datos:

   > ApkBuddyStart es un ejecutor de aplicaciones Android. Incluye el emulador oficial de Android de Google
   > (qemu-system-x86_64.exe) y un juego de imágenes de sistema AOSP, todos distribuidos con el instalador; en tiempo de ejecución no se descarga
   > ningún contenido ejecutable. El usuario hace doble clic en su propio archivo .apk para ejecutar esa aplicación Android como una ventana de Windows.
   > La aplicación no instala por su cuenta ningún APK procedente de la red. En el primer inicio despliega unos 3,3 GB de imagen del sistema en
   > %USERPROFILE%\ApkBuddyStart\data (necesario para que el emulador funcione).
   > La aceleración por hardware depende del WHPX incluido en Windows; no se instala ningún controlador ni servicio.
7. **Un punto que no se puede automatizar**: la Store submission API (autenticación Azure AD) permite enviar mediante programa, pero una vez
   creado un submission con la API ya no se puede volver a editar desde la web de Partner Center (entra en un estado de error irrecuperable).
   Por eso se recomienda «CI genera el paquete → subir y rellenar el formulario en la web → enviar», en lugar de conectar la API desde el principio.

---

## 7. Ubicaciones de código relacionadas

| Archivo | Función |
|---|---|
| `build/msix.js` | Prepara el stage, genera las 5 iconos de tienda, escribe `AppxManifest.xml`, llama a `makeappx` y firma de forma opcional |
| `electron-builder.yml` | Sección `appx` (identity / publisher / capabilities / idiomas / versión mínima del sistema) |
| `src/core/store.js` | Detección de `STORE_BUILD` (`process.windowsStore`) y redirección del directorio de datos |
| `src/core/provision.js` | Gestión del directorio de ejecución en solo lectura: los ejecutables se quedan en el paquete y los datos escribibles se redirigen |
| `src/main.js` | Desactiva la actualización automática en la versión de tienda y cambia el aviso de AEHD por el de activar WHPX |
