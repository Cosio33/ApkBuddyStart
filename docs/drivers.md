# Controladores (parches de compatibilidad)

> A partir de ApkBuddyStart 0.5.7 se admite la extensión mediante «controladores»: un controlador = un archivo JSON que declara
> **a qué máquinas coincide** + **qué parámetros de arranque se cambian al coincidir**.
> El propio usuario puede escribir un parche para «su máquina» sin esperar a que ApkBuddyStart publique una versión.

---

## 1. Qué problema resuelve

Un mismo conjunto de parámetros por defecto no puede funcionar en todas las máquinas:

- La GLES de una iGPU antigua solo llega a 3.1; con `-gpu host`, el guest arranca y se cae a los pocos segundos;
- si la máquina no tiene activada la «plataforma de hipervisor», la aceleración por hardware fallará irremediablemente y hay que pasar directamente a emulación por software;
- cierta versión del controlador de GPU presenta pantalla negra en cuanto se activa Vulkan, y con `swangle` se soluciona;
- algunas combinaciones de proporción de pantalla / DPI requieren cambiar `hw.lcd.density` para que no se vea borroso.

Estas diferencias son **propiedades de la máquina**, no errores del programa. Codificar las decisiones en el código implica tener que publicar una versión cada vez;
haciéndolo en un archivo de datos, el usuario (o la comunidad) que encuentra una combinación válida puede compartirla escribiendo un JSON.

## 2. Dónde se colocan

| Directorio | Uso |
|---|---|
| Ajustes → Controladores → **Abrir directorio de controladores** | Tus propios controladores, `%APPDATA%\apkstart\drivers\*.json` (en la versión de tienda, `%USERPROFILE%\ApkBuddyStart\data\drivers`) |
| Directorio de instalación `resources/app/src/drivers/` | Ejemplos integrados, solo lectura, con `enabled: false` por defecto |

Con el mismo `id`, **el directorio del usuario prevalece sobre el integrado**: para modificar un ejemplo oficial, expórtalo/cópialo al directorio del usuario y edítalo, sin tocar el directorio de instalación.

## 3. Cómo es un controlador

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD iGPU: usar renderizado swangle",
  "version": "1.0.0",
  "author": "Tu nombre",
  "description": "Explica por qué se aplica este cambio en esta máquina, para que otros lo entiendan de un vistazo",
  "priority": 0,
  "match": {
    "platform": ["win32"],
    "gpuVendor": ["amd"],
    "totalMB": { "min": 8192 },
    "accel": ["whpx"]
  },
  "effect": {
    "gpuMode": "swangle",
    "forceTcg": false,
    "emulatorArgs": ["-feature=Vulkan"],
    "configIni": { "hw.gpu.mode": "swangle" },
    "env": { "ANDROID_EMUGL_VERBOSE": "1" },
    "notes": ["Si sigue en pantalla negra, cambia gpuMode a software"]
  }
}
```

### 3.1 Campos de nivel superior

| Campo | Obligatorio | Descripción |
|---|---|---|
| `format` | ✅ | Valor fijo `apkstart-driver/1` |
| `id` | ✅ | Alfanuméricos y `. _ -`, de 3 a 64 caracteres; se usa como nombre de archivo al importar |
| `name` | ✅ | Nombre mostrado en la interfaz (≤80 caracteres) |
| `version` | ✅ | Con forma `1.0.0`; recuerda subir la versión al modificar el parche |
| `author` / `description` / `homepage` | | Para las personas, para que otros puedan juzgar si les sirve |
| `enabled` | | Interruptor por defecto en el archivo; los ejemplos integrados son `false`. El interruptor de la interfaz prevalece sobre este |
| `priority` | | `-100~100`, por defecto 0. **A mayor valor, más tarde se aplica** (sobrescribe lo aplicado antes) |
| `match` | ✅ | Condiciones de coincidencia, véase 3.2 |
| `effect` | ✅ | Qué se cambia al coincidir, véase 3.3 |

### 3.2 `match`: si esta máquina debe usar el controlador

Todas las condiciones deben cumplirse (AND); no escribir ninguna condición equivale a no coincidir; para «todas las máquinas», escribe `{"any": true}`.

| Clave | Valores | Descripción |
|---|---|---|
| `any` | `true` | Coincide con todas las máquinas (útil como línea base de respaldo) |
| `platform` | `win32` / `linux` | |
| `arch` | `x64` / `arm64` | |
| `gpuVendor` | `nvidia` / `amd` / `intel` / `unknown` | Clasificación burda por nombre de GPU; admite array |
| `gpuName` | Cadena regex (≤200 caracteres) | Por ejemplo `"radeon\\s+780m"`, sin distinción de mayúsculas |
| `cpuVendor` | Cadena o array | Coincide con el texto del modelo de CPU |
| `accel` | `whpx` / `aehd` / `none` | Estado actual de aceleración por hardware; `none` = solo emulación por software |
| `osBuild` | Número o `{min,max}` | Número de compilación interna de Windows, p. ej. 22631 |
| `totalMB` | `{min,max}` | Memoria física (MB) |
| `cores` | `{min,max}` | Número de núcleos lógicos |
| `emulatorVersion` | `{min,max}` | Comparación numérica, `36.4.9 < 36.4.10` |

En la página de ajustes, cada controlador muestra «Coincide: gpu=amd / accel=whpx» o «No coincide con esta máquina»,
sin tener que adivinar por qué no se aplicó.

### 3.3 `effect`: qué se cambia al coincidir

| Campo | Descripción |
|---|---|
| `gpuMode` | Backend de renderizado fijo: `auto` / `host` / `swangle` / `swiftshader` / `swiftshader_indirect` / `software`. `auto` = no intervenir |
| `forceTcg` | `true` = desactiva la aceleración por hardware y usa emulación por software (equivalente a `-accel off`) |
| `emulatorArgs` | Argumentos adicionales para el emulator, en forma `-flag=valor`; solo se permiten los de la lista blanca |
| `configIni` | Sobrescribe el `config.ini` del AVD; solo se permiten claves de la lista blanca |
| `env` | Variables de entorno adicionales; solo se permiten los prefijos `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` |
| `notes` | Texto explicativo; se muestra en el registro de arranque y en la página de ajustes |

`gpuMode` y `forceTcg` se aplican en **cada ronda** de arranque (incluidos los reintentos de degradación automática):
si el controlador dice «esta máquina solo puede usar swangle», no tiene sentido probar primero el backend que ya falló.

## 4. Lista blanca: qué se puede cambiar y por qué

Los archivos de controlador se pueden descargar de Internet y compartir, por lo que ApkBuddyStart limita sus permisos de forma estricta:

**No se permite ejecutar ningún código**. El controlador es JSON puro: sin hooks de script, sin `eval` y sin `require` de archivos escritos por el usuario.

**`emulatorArgs` solo acepta**

| Parámetro | Valores permitidos |
|---|---|
| `-gpu` | Backends de renderizado conocidos (véase la tabla anterior) |
| `-accel` | `auto` / `off` / `on` / `whpx` / `hax` / `haxm` / `aehd` / `tcg` |
| `-feature` | Alfanuméricos y `_,.-`, ≤160 caracteres |
| `-gltransport` | `pipe` / `asgpu` / `virtio` |
| `-qemu` | Un único parámetro qemu, conjunto de caracteres limitado, ≤120 caracteres |
| Tipo interruptor | `-no-audio` `-no-boot-anim` `-no-metrics` `-no-snapshot` `-no-snapshot-load` `-no-snapshot-save` |

Se rechazan explícitamente: `-wipe-data` (borra aplicaciones y datos guardados), `-partition-size`, `-datadir`, `-sysdir`,
`-avd`, `-port`, `-http-proxy`. Estos últimos destruyen datos o rompen las ubicaciones que ApkBuddyStart gestiona por su cuenta.

**`configIni` solo acepta**: `hw.gpu.mode`, `hw.gpu.enabled`, `hw.gltransport`, `hw.keyboard`,
`hw.audioInput`, `hw.audioOutput`, `hw.camera.back`, `hw.camera.front`, `hw.gps`,
`vm.heapSize`, `hw.lcd.density`.
`disk.dataPartition.size`, `hw.ramSize`, `hw.cpu.ncore`, `image.sysdir.*` se rechazan siempre:
ApkBuddyStart ya los escribe según los ajustes, y mezclar cambios solo genera conflictos.

**`env`**: `ANDROID_*`, `QEMU_*`, `LIBGL_*`, `MESA_*`, `EMUGL_*`; valores ≤200 caracteres y sin saltos de línea.
`PATH`, `SystemRoot`, `NODE_OPTIONS` y similares se rechazan directamente.

## 5. Cómo crear tu propio controlador

1. Ajustes → Controladores → **Exportar plantilla de esta máquina** (`match` ya está rellenado según la máquina actual y se guarda en el directorio de controladores);
2. Ábrelo con el Bloc de notas / VS Code y modifica `effect`:
   - pantalla negra / artifacts → prueba primero `"gpuMode": "swangle"`, y si no funciona cambia a `"software"`;
   - la máquina no tiene aceleración por hardware → `"forceTcg": true`;
   - guarda los cambios;
3. Vuelve a la página de ajustes y pulsa **Actualizar**; deberías ver «Coincide con esta máquina / En vigor»;
4. Abre una aplicación una vez para verificarlo y apaga y enciende de nuevo para confirmar la estabilidad;
5. Para compartirlo: envía el JSON a otra persona, que solo tiene que usar «Importar controlador…».

Hacerlo mal no afecta al arranque: los archivos que no pasan la validación solo aparecen en la lista de errores de la página de ajustes,
y los controladores que no coinciden no tienen ningún efecto.

## 6. Resolución de problemas

- El registro de arranque (Ajustes → Diagnóstico / `%APPDATA%\apkstart\logs\emulator.log`) indica:
  `drivers: amd-igpu-swangle@1.0.0`, además del `-gpu` / `-accel` realmente usados en cada ronda;
- la página de ajustes indica para cada controlador «coincide / no coincide / desactivado» y qué condiciones se cumplieron;
- si falla la carga de un archivo (error de sintaxis JSON, campo mal escrito, más de 256 KB), se enumeran el archivo concreto y el motivo;
- para excluir temporalmente un controlador: basta con desactivar el interruptor en la interfaz (se escribe en los ajustes, sin borrar el archivo).

## 7. Ejemplos integrados

Hay tres ejemplos bajo `src/drivers/`, **desactivados** por defecto:

| Archivo | Escenario |
|---|---|
| `example-amd-igpu-swangle.json` | iGPU AMD + controlador antiguo; se cae tras arrancar con `-gpu host` |
| `example-no-hypervisor-tcg.json` | Sin aceleración por hardware; se usa directamente emulación por software |
| `example-intel-igpu-software.json` | iGPU Intel antigua; falla la inicialización de GLES |

También sirven de documentación: modificar `match` los convierte en un parche «que solo afecta a esta máquina».
