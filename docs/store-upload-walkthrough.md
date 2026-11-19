# ApkBuddyStart — Guía de subida a la tienda (versión para copiar)

> Ordenada según el orden de las páginas de Partner Center. Los bloques marcados **[Copiar]** se pegan directamente; en los marcados **[Subir]** se selecciona el archivo local.
> Todo el proceso lleva unos 15 minutos. El único punto en el que hay que pensar es el paso 2, copiar dos valores de identidad.

---

## 0. Comprobación previa

- [ ] `dist/store/ApkBuddyStart_0.5.8.0_x64.msix` existe y ocupa unos 850 MB
- [ ] La identidad del paquete ya se ha cambiado por tus valores reales (véase el paso 2; actualmente sigue siendo la de marcador de posición `RoutineMiku.ApkBuddyStart`)
- [ ] La política de privacidad tiene una URL de acceso público

---

## 1. Crear un producto nuevo

1. Inicia sesión en <https://partner.microsoft.com/dashboard>
2. **Apps and games → New product → MSIX or PWA app**
3. Nombre del producto: `ApkBuddyStart`
   - Si está ocupado, cámbialo por `ApkBuddyStart — ejecutor de apps Android` (solo afecta a lo que se muestra, no a la identidad del paquete)

---

## 2. Obtener los valores de identidad (**clave**)

**Product management → Product identity**, copia la fila completa:

```
Package/Identity/Name       = RoutineMiku.ApkBuddyStart
Package/Identity/Publisher  = CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D
```

> Confirmado (2026-11-16): **estos dos valores ya son los predeterminados de `build/msix.js` y `electron-builder.yml`**;
> basta con ejecutar `node build/msix.js` para obtener directamente un paquete con la identidad correcta.
> Además, `build/msix.js` incorpora una guarda: si Publisher no contiene `58CA1DED`, sale (código de salida 3),
> para evitar volver a sobrescribir un paquete ya correcto con la identidad de marcador de posición (antes, `dist/release/ApkBuddyStart 0.5.0.appx`
> acabó convertido precisamente en un paquete inútil con identidad de marcador).
> Si en el futuro Partner Center muestra otros valores, vuelve a ejecutar:
>
> ```powershell
> node build/msix.js --identity "RoutineMiku.ApkBuddyStart" --publisher "CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D"
> ```

Una vez empaquetado, comprobaré que la identidad del manifiesto coincide carácter por carácter, que `Version="0.5.8.0"` y que los md5 de las 7 imágenes Assets coinciden con los de `build/store-assets`.
**No subas nada antes de completar el paso 2**: un paquete con identidad de marcador se rechaza directamente.

---

## 3. Packages — Subida

**Packages → Upload package**

- **[Subir]** `D:\apkstart-dsh\apkstart\dist\store\ApkBuddyStart_0.5.8.0_x64.msix`
- La subida pesa unos 891 MB y, según tu ancho de banda de subida, puede tardar de 5 a 20 minutos; no actualices la página
- Cuando pase la validación aparecerá «Package accepted»

Errores habituales:
| Error | Causa |
|---|---|
| `0x800B0109` | Publisher no coincide con la firma → identidad copiada mal; vuelve al paso 2 |
| `0x80080204` | Estructura del manifiesto no válida → vuelve a empaquetar con el `build/msix.js` actual (`Square71/310` debe estar en `DefaultTile`) |
| `Invalid package identity name` | `Name` contiene espacios o mayúsculas/minúsculas incorrectas |

---

## 4. Store listing — Inglés (idioma predeterminado)

**Short description** (≤100 caracteres) **[Copiar]**
```
Run Android apps on Windows by double-clicking an APK. Each app gets its own window.
```

**Description** **[Copiar]**
El bloque English de la sección 3 de `docs/store-listing.md` (desde `ApkBuddyStart turns Android apps...` hasta `No network access is needed afterwards.`)

**Product features** (máximo 20, pega uno a uno) **[Copiar]**
```
Double-click an APK to install it — no emulator UI, no setup
Each app gets its own Desktop and Start menu shortcut with its real icon
Apps run in their own window, with full-screen and resizable window mode
Portrait and landscape apps are detected and filled to the correct aspect ratio
Windows Search finds installed Android apps by name
A shared folder syncs both ways between Windows and /sdcard/ApkBuddyStartShared
The full runtime ships in the package — nothing executable is downloaded at runtime
Shell has zero third-party dependencies; the runtime starts on demand and is reclaimed when idle
No virtual network adapter and no kernel driver — Android uses the host connection
Runtime permissions are granted automatically; crashed apps are retried
```

**Screenshots** (≥1, de 1366×768 o superior) **[Subir]**
1. `docs/store-shots/1-main.png`
2. `docs/store-shots/2-window.png`

**Store logos**: se puede omitir (los iconos ya están en `Assets/` del MSIX, con las 7 imágenes completas)

---

## 5. Store listing — Español

Añade **Spanish (Español)** a los idiomas del producto y después:

**Descripción corta** **[Copiar]**
```
Ejecuta apps de Android en Windows con doble clic en un APK: ventanas independientes, iconos en el escritorio y ejecución integrada, listo nada más instalar.
```

**Descripción detallada** **[Copiar]**
El bloque Español completo de la sección 3 de `docs/store-listing.md`

**Lista de funciones** **[Copiar]**
Las 10 entradas de la sección 4 de `docs/store-listing.md`

**Capturas de pantalla**: las mismas dos de arriba (se pueden reutilizar)

---

## 6. Properties

- **Category**: Developer tools → **Utilities & tools**
- **System requirements** **[Copiar]**
```
Windows 10 version 2004 (build 19041) or later, x64. "Virtual Machine Platform"
(Windows Hypervisor Platform) must be enabled for hardware acceleration.
8 GB RAM recommended; ~4 GB free disk space for the system image.
```
- **Privacy policy URL** **[Copiar]**
  ```
  https://github.com/RoutineMiku/apkstart/blob/main/docs/privacy.md
  ```
  (ya está fusionado en `main`; no hay que ocuparse de la visibilidad de la rama)
- **Support contact**: rellena tu correo + `https://github.com/RoutineMiku/apkstart/issues`

---

## 7. Age ratings (cuestionario IARC)

- La aplicación en sí no contiene contenido, pero **puede ejecutar apps Android de terceros** → marca «el usuario puede acceder a contenido de terceros»
- No contiene contenido generado por usuarios, ni funciones sociales, ni uso compartido de ubicación, ni compras integradas
- Normalmente se obtiene 3+ / Everyone

---

## 8. Submission options → Notes for certification **[Copiar]**

El bloque completo en inglés de la sección 6 de `docs/store-listing.md`; lo esencial es explicar que el emulador y la imagen se distribuyen dentro del paquete,
que en tiempo de ejecución no se descarga contenido ejecutable, que el primer inicio solo hace una descompresión local y que WHPX procede del propio Windows.

---

## 9. Envío

**Review and publish → Submit for certification**

- El primer paquete suele tardar de 1 a 3 días hábiles
- Las causas más habituales de rechazo son: capturas que no coinciden con la interfaz, política de privacidad con error 404 y unas certification notes demasiado breves; esta guía ya cubre las tres
