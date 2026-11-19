---
title: Escribí un lanzador de Android para Windows: doble clic en .apk y listo, y además conseguí que corrieran las apps de ByteDance
cover: ./assets/wechat-cover.jpg
description: ApkBuddyStart v0.2.2 publicado: un lanzador de aplicaciones Android para Windows, de código abierto y gratuito. La nueva «versión completa» incluye el motor y una imagen compatible con Android 14: funciona nada más descomprimir y hacer doble clic, sin descargas ni ajustes.
author: RoutineMiku
source_url: https://github.com/RoutineMiku/apkstart/releases/tag/v0.2.2
sourceUrl: https://github.com/RoutineMiku/apkstart/releases/tag/v0.2.2
digest: Lanzador de aplicaciones Android para Windows, de código abierto y gratuito; la versión completa de v0.2.2 incluye el motor y una imagen compatible con Android 14, y funciona nada más descomprimir y hacer doble clic.
need_open_comment: 1
only_fans_can_comment: 0
---

# Doble clic en .apk y Android corre en el ordenador

Para abrir una app de Android en Windows, normalmente hay que pasar por: descargar un emulador de varios GB → configurar el entorno → buscar un APK → arrastrarlo al emulador → aguantar ventanas emergentes y el ventilador a tope. Y al final aún puede aparecer `INSTALL_FAILED_NO_MATCHING_ABIS`: este paquete solo trae bibliotecas nativas ARM y no se puede instalar.

Así que escribí uno yo mismo: **ApkBuddyStart**.

Es un lanzador de aplicaciones Android para Windows extremadamente ligero: asocia el archivo `.apk` con él, **haz doble clic y se instala**, se crea automáticamente el acceso directo en el escritorio, cada aplicación tiene su propia ventana independiente y hay una carpeta compartida entre el ordenador y Android para arrastrar archivos en ambos sentidos.

![Interfaz principal de ApkBuddyStart](./assets/app.png)

## Cuatro características, funciona al instalar

**① Instalación con doble clic.** Tras asociar `.apk`, basta con hacer doble clic: se instala, lee automáticamente el nombre y el icono de la app y crea el acceso directo del escritorio en un paso, sin abrir ninguna consola de emulador.

**② Ventanas independientes.** Cada app corre en su propia ventana redimensionable (`am start --windowingMode 5`), sin molestarse entre sí y disponiéndose como los programas nativos de Windows.

**③ Archivos compartidos.** `%USERPROFILE%\ApkBuddyStartShared` está conectado con el directorio compartido interno de Android: arrastra un archivo desde el ordenador y la app puede abrirlo directamente.

**④ Motor oficial + aceleración por hardware.** Por debajo están el Android Emulator oficial de Google y el controlador AEHD; descarga en paralelo desde la fuente oficial con 8 hilos, y el propio programa verifica y gestiona los componentes de ejecución. La carcasa no tiene dependencias de terceros.

## v0.2.2: esta vez hemos eliminado por completo los «problemas»

La nueva versión hace dos cosas.

**La primera: la versión completa funciona nada más abrirla.** Antes, el primer inicio requería pulsar «Despliegue con un clic» para descargar el motor y la imagen (unos 2 minutos). Ahora la versión completa incluye todo eso en el instalador: el motor de ejecución, platform-tools, el controlador AEHD y una imagen compatible con Android 14 con capa de traducción ARM. Descomprime y haz doble clic en `ApkBuddyStart.exe`: las cuatro comprobaciones salen en verde y entras directo en la interfaz principal: **sin descargas y sin ajustes**.

**La segunda: hemos conseguido que funcionen las apps de ByteDance.** Antes los paquetes como Hongguo Short Drama, que solo traen arm64-v8a, se cerraban al aceptar la política de privacidad en una imagen API 30 antigua (`DoBadTrampoline` de `libndk_translation`). Al pasar a la imagen de Android 14, la nueva capa de traducción resolvió el problema: en nuestras pruebas, instalación correcta, entrada en el flujo de recomendaciones, reproducción de vídeo normal y cambio de vídeo al deslizar sin fallos.

![Hongguo Short Drama reproduciéndose en ApkBuddyStart](./assets/compat-hongguo-playing.png)

Basta con activar con un clic el «modo de compatibilidad ARM» en los ajustes; las apps normales que solo son ARM también se benefician. Algunas aplicaciones con detecciones más profundas de emulación (que verifican sensores o banda base reales) pueden seguir teniendo limitaciones; lo decimos con total transparencia.

![Panel de ajustes y sección Acerca de](./assets/brand.png)

## Descarga: dos versiones, elige la que quieras

> El cuerpo de un artículo de la cuenta oficial de WeChat no admite adjuntar archivos de instalación, así que aquí va el **código QR que lleva directo al instalador**: mantén pulsado para escanearlo y descargar; también puedes ir al final del artículo y pulsar **«Leer el original»** para entrar en la página de Release de GitHub.

![Escanea para descargar ApkBuddyStart v0.2.2](./assets/download-qr.png)

| Versión | Tamaño | Para quién es |
| --- | --- | --- |
| Versión ligera `win64-portable.zip` | 0,11 GB | En el primer inicio, pulsa «Despliegue con un clic»: el motor y la imagen se instalan solos en unos 2 minutos |
| **Versión completa `win64-full.7z.001` (recomendada)** | 1,35 GB | Incluye todos los componentes y la imagen compatible con ARM; funciona al descomprimir y hacer doble clic, sin descargas ni ajustes |

La versión completa es un volumen 7z: basta con extraer `.001` con 7-Zip / WinRAR / Bandizip; la versión actual tiene un único volumen. Ambas versiones son portables (green), sin necesidad de instalación con permisos de administrador.

El proyecto es totalmente de código abierto: <https://github.com/RoutineMiku/apkstart>. Te invitamos a dar una estrella, abrir issues y enviar PR; para futuras versiones basta con crear un tag y GitHub Actions compila y publica automáticamente estos dos paquetes.

## Sobre el autor

**ApkBuddyStart es desarrollado y mantenido por RoutineMiku**, Powered by RoutineMiku.

Los códigos QR de la cuenta oficial de WeChat y de Douyin están abajo, y también dentro del programa en «Ajustes → Acerca de». Si tienes algún problema, no dudes en buscarme.

![Código QR de la cuenta oficial de WeChat](./assets/wechat-qr.jpg)

![Código QR de Douyin](./assets/douyin-qr.jpg)

Usuario de Douyin **RoutineMiku (DailyMIKU)**, enlace del perfil: <https://v.douyin.com/9TIIxVCANig/>

---

*El proyecto se distribuye bajo la licencia MIT. Los componentes de ejecución de la versión ligera los descarga el usuario en su propio equipo desde la fuente oficial de Google, según los necesita; la versión completa los incluye para mayor comodidad, y dichos componentes se rigen por sus respectivas licencias.*
