# ApkBuddyStart v0.5.3

Esta versión gira por completo en torno a los **iconos**: conseguir que cada aplicación Android muestre de verdad su propio icono en el escritorio y la barra de tareas.

## 1. Los accesos directos de aplicaciones Android vuelven a usar «el icono de la propia aplicación»

La versión anterior, al ordenar los iconos, puso el icono de marca de ApkBuddyStart en todos los accesos directos relacionados con ApkBuddyStart, con lo que los accesos de Hongguo y Moread en el escritorio se convirtieron en el botón de reproducción verde.

Ahora se reescriben con el propio `shortcut.writeShortcut()` de la App (la misma ruta de código que «Ajustes → Recrear accesos directos»):

| Acceso directo | Icono |
|---|---|
| Hongguo, cortos gratis (escritorio + menú Inicio) | `%APPDATA%\apkstart\icons\com.phoenix.read.ico` |
| Moread (escritorio + menú Inicio) | `%APPDATA%\apkstart\icons\cn.moread.app.ico` |
| ApkBuddyStart / Demo (el propio ejecutor) | Icono de marca |

> El código del producto ya usaba `app.icoPath`; esto es una reparación de un entorno que se había estropeado, más una capa adicional de identidad en la barra de tareas.

## 2. La identidad de la barra de tareas cambia según la aplicación

Windows solo fusiona la ventana en ejecución con el elemento fijado en la barra de tareas y reutiliza el icono del acceso directo cuando «el AUMID del proceso en ejecución == el AUMID del acceso directo». El acceso directo de cada aplicación escribe
`RoutineMiku.ApkBuddyStart.<nombre del paquete>`, pero la identidad a nivel de proceso era `RoutineMiku.ApkBuddyStart`: al no coincidir aparecía «el elemento fijado muestra el icono de la aplicación, pero la barra de tareas crea otro botón de ApkBuddyStart».

Ahora, antes de abrir una aplicación, se cambia la identidad del proceso al AUMID de esa aplicación, y se vuelve a la de ApkBuddyStart al regresar a la ventana de gestión.

## 3. Marca del exe del ejecutor (desde 0.5.2)

`ApkBuddyStart.exe` antes era simplemente `electron.exe` renombrado: FileDescription=Electron, CompanyName=GitHub, Inc., versión 33.4.11 y el icono de Electron. Ahora, al empaquetar, se escribe:

```
FileDescription  ApkBuddyStart ejecutor de aplicaciones Android
ProductName      ApkBuddyStart
CompanyName      RoutineMiku
FileVersion      0.5.3.0
ProductVersion   0.5.3
```

y se incrusta `appicon.ico` (9 fotogramas, de 16 a 256).

---

## Notas de actualización desde 0.5.2

- `0.5.3.0 > 0.5.2.0`; la Store puede sobrescribir la actualización directamente.
- Quienes ya instalaron 0.5.1 / 0.5.2: tras actualizar **no hace falta reinstalar las aplicaciones Android**, pero se recomienda pulsar una vez «Ajustes → Recrear accesos directos» para actualizar los iconos antiguos a los de cada aplicación (los accesos de las aplicaciones instaladas con 0.5.2 ya son correctos; solo los que se estropearon a mano necesitan recrearse).

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.3.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Materiales de envío: `docs/store-listing.md` (incluye el texto «What's new» de esta versión en español e inglés)
- Pasos: `docs/store-upload-walkthrough.md`

Pruebas: 9 + 25 + 121 = 155 superadas.
