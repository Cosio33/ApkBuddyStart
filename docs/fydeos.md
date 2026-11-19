# La base FydeOS de ApkBuddyStart (también funciona en Windows)

> En pocas palabras: **usar el entorno Android integrado de FydeOS en lugar del emulador de Google**.
> FydeOS se puede instalar en la propia máquina o ejecutarse en VMware / VirtualBox, y ApkBuddyStart en Windows se conecta a él.

---

## ⚠️ Lee primero esta sección: los riesgos reales de la vía FydeOS

He investigado a fondo la viabilidad de esta vía y la conclusión no es optimista; **deberías saberlo antes de decidir si merece la pena invertir en ella**:

1. **La imagen oficial de VMware es una preview**. La página de descarga dice literalmente: «diseñada para que los usuarios
   **prueben y previsualicen** FydeOS en entornos virtualizados» ([FydeOS for VMware](https://fydeos.com/download/vm/x86_64/)).
2. **En la versión para VMware, el subsistema Android a menudo no funciona**. La comunidad de FydeOS afirma claramente
   que «la versión de VMware es solo para previsualización y no se garantiza por ahora la plena funcionalidad»; hay usuarios que informan
   de que las apps Android no pueden acceder a la red y de que `adb` conecta pero la pantalla queda negra.
   ([Debate en la comunidad](https://community.fydeos.com/t/topic/47865))
3. **Hay quien dice que las versiones antiguas (v18) funcionan correctamente**, mientras que las nuevas se han roto. Es decir, esta vía depende de una versión concreta
   y podría dejar de funcionar cualquier día.

**Conclusión**: implementé la base FydeOS y funciona, pero **no debería considerarse la solución principal**.
Si solo buscas «algo más ligero que el emulador de Google y sin problemas de ventana»,
la conectividad corregida + el **modo de ventana independiente** ya lo resolvieron en v0.5.0; no hace falta cambiar de base.

---

## Dos formas de uso

### Uso A: ApkBuddyStart y FydeOS en la misma máquina (FydeOS instalado localmente)

Requisito: tienes instalado el propio sistema FydeOS (no Windows).

1. Lanzador de aplicaciones de FydeOS → abre «Ajustes de Android»
2. Sistema → Opciones de desarrollador → activa **Depuración ADB**
   (si no encuentras las opciones de desarrollador: Ajustes de Android → Información del dispositivo → pulsa 7 veces «Número de compilación»)
3. Ajustes de FydeOS → Linux → activa el subsistema Linux
4. En el terminal de Linux: `sudo apt update && sudo apt install -y adb`
5. ApkBuddyStart → Ajustes → Ejecución → selecciona como modo de motor **Subsistema Android de FydeOS** y deja la dirección **vacía**
   (se prueban sucesivamente `arc:5555`, `100.115.92.2:5555` y `127.0.0.1:5555`)

### Uso B: ApkBuddyStart en Windows, FydeOS en una máquina virtual

Esta es la forma que buscas. Pasos completos:

#### 1. Instala un software de virtualización

- **VMware Workstation Player** (gratuito): la imagen oficial de FydeOS para VM es un `.ova`, basta con importarla
- **VirtualBox**: también sirve, pero tras importar el `.ova` puede que haya que ajustar UEFI manualmente

> Atención: **no uses Hyper-V**. La ejecución integrada de ApkBuddyStart se acelera con AEHD, y AEHD y Hyper-V son mutuamente excluyentes;
> si activas Hyper-V, la ejecución integrada dejará de funcionar. Con VMware / VirtualBox no hay este problema.

#### 2. Importa la imagen de FydeOS

Descarga el `.ova` (unos 1,5 GB o más) desde la [página de descarga de FydeOS for VMware](https://fydeos.com/download/vm/x86_64/);
en VMware, «Abrir máquina virtual» → selecciona ese `.ova`.
Si aparece el aviso «No supera la comprobación de conformidad de la especificación OVF», pulsa **Reintentar** según se indica para relajar la validación; la importación seguirá funcionando.

Se recomienda asignar a la máquina virtual **más de 4 GB de memoria RAM** (el subsistema Android consume mucha memoria).

#### 3. Activa la depuración ADB en FydeOS

1. Inicia la máquina virtual y completa la configuración inicial de FydeOS (inicio de sesión / cuenta local)
2. Abre los ajustes de Android y activa el subsistema Android
3. Ajustes de Android → Sistema → Opciones de desarrollador → activa **Depuración ADB**

#### 4. Permite que Windows se conecte a esa máquina virtual

Dos caminos; elige uno:

**Camino 1 (recomendado, el más sencillo): redirección de puerto NAT**

VMware: ajustes de la máquina virtual → adaptador de red → selecciona NAT → «Configuración NAT» → Redirección de puertos → añade:

| Puerto del host | Tipo | IP de la VM | Puerto de la VM |
|---|---|---|---|
| 5555 | TCP | (déjalo vacío o 192.168.x.x) | 5555 |

VirtualBox: Configuración → Red → Avanzado → Redirección de puertos → añade una regla `127.0.0.1:5555 → 10.0.2.15:5555`

Después, en ApkBuddyStart, rellena la dirección con: `127.0.0.1:5555`

**Camino 2: usar directamente la IP de la máquina virtual**

Cambia la red de la VM a «puente» (bridged); en FydeOS abre `crosh` (Ctrl+Alt+T) → `shell` → `ip addr` para ver la IP,
y luego rellena `<esaIP>:5555` en ApkBuddyStart.

#### 5. Configura ApkBuddyStart

1. Ajustes → Ejecución → selecciona como modo de motor **Subsistema Android de FydeOS**
2. Rellena la dirección del paso anterior (p. ej. `127.0.0.1:5555`)
3. Pulsa en Detectar

**La primera vez que conectes, FydeOS mostrará un cuadro de autorización preguntando «¿Permitir la depuración?»: pulsa «Permitir» sin falta**,
o no se podrá instalar el APK.

---

## Diferencias respecto a la ejecución integrada

| | Ejecución integrada (QEMU) | Base FydeOS |
|---|---|---|
| De dónde sale Android | ApkBuddyStart descarga la imagen y la arranca él mismo | La proporciona el sistema FydeOS, ya en funcionamiento |
| Arranque tras apagar | Hay que arrancar (unos 18 s en v0.5.0) | Casi instantáneo (la VM ya está encendida) |
| Memoria adicional | Unos 3 GB | Depende de lo asignado a la VM |
| Espacio ocupado por la imagen | Varios GB | Ninguno (usa el disco propio de FydeOS) |
| Incrustación de ventana | ✅ Se puede incrustar en la ventana de ApkBuddyStart | ❌ FydeOS muestra la imagen por su cuenta |
| Una ventana por aplicación | ✅ | ❌ Todas las apps comparten el escritorio de FydeOS |
| Estabilidad | Alta (probado) | **Depende de la versión de FydeOS, véase la advertencia inicial** |

**Sobre «una ventana por aplicación»**: esta es la parte más valiosa de la experiencia de ApkBuddyStart, y la base FydeOS no puede ofrecerla.
El motivo es que la imagen Android se muestra dentro del escritorio de FydeOS (o en la ventana de esa máquina virtual), no en una
ventana independiente de una app Android, por lo que no hay ningún HWND al que se pueda `SetParent`.

Por tanto, con la base FydeOS, el papel de ApkBuddyStart pasa a ser: **lista de aplicaciones + instalación de paquetes + arranque + gestión de iconos/atajos**,
y la imagen la muestra FydeOS por su cuenta.

---

## Preguntas frecuentes

### Aparece «Introduce primero la dirección de FydeOS»

En Windows no existe un «Android local», así que ApkBuddyStart no tiene forma de adivinar dónde está esa máquina virtual. Configura el redireccionamiento de puerto del paso 4 o rellena la IP.

### Sigue apareciendo unauthorized y no salta el cuadro de autorización

Es un problema conocido de algunas versiones de FydeOS X (las claves adb del host y del subsistema Linux no coinciden). Sincroniza las claves manualmente:

```bash
# 1. En el terminal Linux de FydeOS
adb start-server
cat ~/.android/adbkey.pub      # copia el contenido

# 2. Crosh (Ctrl+Alt+T) → shell para entrar en el host
sudo mount -o remount,rw /
sudo mkdir -p /opt/google/containers/android/rootfs/android-data/data/misc/adb
sudo tee /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys <<'EOF'
<Pega aquí el contenido de adbkey.pub de arriba>
EOF
sudo chown 1000:1000 /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys
sudo mount -o remount,ro /
```

Después reinicia el subsistema Android y vuelve a conectar.

### Conecta, pero la aplicación instalada no se abre

Si aparece `INSTALL_FAILED_NO_MATCHING_ABIS`, significa que ese APK solo tiene versión arm64 mientras FydeOS
se ejecuta sobre x86. FydeOS incorpora una capa de compatibilidad ARM, pero no es completa: para este tipo de apps es más fácil tener éxito con la ejecución integrada
(que incluye la traducción ARM de Google).

### La interfaz de la aplicación queda en negro

Es un problema añejo de la versión de FydeOS para VMware (véase la advertencia inicial). Primero comprueba si las aplicaciones Android propias de FydeOS se abren correctamente;
si incluso las apps del sistema se quedan en negro, no es un problema de ApkBuddyStart: cambia de versión de FydeOS (hay usuarios que informan de que la v18 funciona) o usa la ejecución integrada.

---

## Detalles técnicos (para mantenedores)

- El backend está implementado en `src/core/backends/fydeos.js`
- Los bits de capacidad se declaran deliberadamente de forma muy conservadora: no `provision` (no instala imágenes), no `snapshot` (no tiene instantáneas propias),
  no `rotatePanel` (el panel lo gestiona el sistema). Solo `shutdown`, y este se limita a desconectar adb,
  sin apagar realmente el Android del sistema, porque eso afectaría a otras aplicaciones del usuario.
- `embedCapable = false`. La capa superior (`attachAppWindow` en `main.js`) ve esta marca y omite la toma de control de la imagen,
  en lugar de dar una vuelta fallando `SetParent` y llenar el registro de mensajes `attach failed`.
- En Windows se usa el adb incluido con ApkBuddyStart (`runtime/platform-tools/adb.exe`),
  sin exigir que el usuario instale platform-tools por su cuenta.
