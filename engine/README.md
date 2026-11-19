# Directorio del motor de runtime (colocación manual, opcional)

**Desde la 0.2, ApkBuddyStart es totalmente autosuficiente por defecto**: adb, QEMU y la imagen
del sistema los descarga y despliega la aplicación automáticamente en
`%APPDATA%\apkstart\runtime\`, sin necesidad de preparar nada manualmente.

Este directorio solo se usa en las dos situaciones siguientes:

## 1. Colocar QEMU manualmente (la fuente de descarga está bloqueada / se quiere una versión concreta)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ … (el resto de archivos de QEMU)
```

Dirección de las compilaciones oficiales de QEMU para Windows: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` es un instalador NSIS; ApkBuddyStart lo instalará silenciosamente en el
directorio del runtime con `/S /D=`; también puedes descomprimir el instalador directamente con
7-Zip y colocarlo en la ubicación de arriba)

## 2. Colocar adb manualmente

```
tools/platform-tools/
└─ adb.exe
```

Dirección de descarga: https://developer.android.com/tools/releases/platform-tools

## Imagen del sistema

- Recomendada: Android-x86 9.0-r2 (x86_64), se puede descargar directamente desde la aplicación
  (varios mirror y descarga reanudable)
- O importar: cualquier imagen de disco con Android ya instalado (qcow2 / raw / vmdk), eligiéndola
  en «Runtime → Importar»
- Tras importarla, ApkBuddyStart arranca directamente desde el disco, sin necesidad de instalación

## Aceleración por hardware

QEMU usa aceleración WHPX: Panel de control → «Activar o desactivar las características de Windows»
→ marcar «Plataforma de máquina virtual» → reiniciar. Si no está activada, ApkBuddyStart recurre
automáticamente a la emisión pura por software (TCG) y el primer arranque es más lento.
