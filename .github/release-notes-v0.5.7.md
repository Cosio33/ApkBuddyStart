# ApkBuddyStart v0.5.7

Esta versión añade la extensión de **drivers (parches de compatibilidad)**: cuando una máquina no arranca, no hace falta esperar a que ApkBuddyStart publique una versión nueva; basta con escribir tu propio parche JSON para corregir los parámetros, y además puedes compartirlo.

El paquete sigue funcionando de forma autónoma y solo incluye su propio runtime: los drivers cambian **los parámetros de arranque de nuestro propio emulator** y no afectan a ningún emulador de terceros.

---

## 1. Por qué hacen falta los drivers

Un mismo juego de parámetros por defecto no puede cubrir todas las máquinas. Ejemplos reales encontrados:

- GPU integrada de AMD + driver antiguo: `-gpu host` pasa la autocomprobación del emulador, pero el proceso se cierra a los diez y pico segundos de arrancar el invitado (el registro solo dice `AEHD is operational`) → cambiar a `swangle` lo arregla;
- máquina sin la función «plataforma de hipervisor» activada: la aceleración por hardware fracasa inevitablemente, así que conviene usar `-accel off` desde el principio;
- GPU integrada de Intel antigua: falla la inicialización de GLES / salen colores raros → usar renderizado `software`;
- ciertas combinaciones de proporción de pantalla + DPI requieren cambiar `hw.lcd.density` para que no se vea borroso.

Estas son **propiedades de la máquina**, no bugs del programa. Escribirlas en el código obligaría a publicar una versión nueva cada vez; hacerlo un archivo de datos permite que quien encuentra una combinación que funcione escriba un JSON y ayude a las máquinas del mismo modelo.

## 2. Qué es un driver

Un driver es un JSON:

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD iGPU: usar renderizado swangle",
  "version": "1.0.0",
  "match": { "platform": ["win32"], "gpuVendor": ["amd"], "accel": ["whpx"] },
  "effect": { "gpuMode": "swangle", "notes": ["si sigue en negro, cambiar a software"] }
}
```

- `match`: si esta máquina debe usarlo (fabricante / regex del modelo de tarjeta / memoria / núcleos / versión del sistema / estado de aceleración / versión del emulator);
- `effect`: qué cambiar cuando encaja (`gpuMode`, `forceTcg`, `emulatorArgs`, `configIni`, `env`, `notes`);
- `priority`: cuando encajan varios drivers a la vez, se aplican primero los de menor prioridad y luego los de mayor, que sobrescriben a los anteriores.

La tabla completa de campos y las listas blancas están en **`docs/drivers.md`**, y tres ejemplos incluidos en `src/drivers/`.

## 3. Límites de seguridad (importante)

Los archivos de driver se pueden descargar de internet y compartir, por lo que:

1. **Solo se admite JSON y no se ejecuta ningún código**: no hay ganchos de script, ni `eval`, ni `require` de nada que venga en el driver;
2. **Lista blanca de parámetros**: se permiten `-gpu` / `-accel` / `-feature` / `-gltransport` / un único `-qemu` y unos pocos parámetros de interruptor;
   se rechazan `-wipe-data`, `-partition-size`, `-datadir`, `-sysdir`, `-avd` y `-port` (que borran datos o cambian dónde se guardan);
3. **Lista blanca de config.ini**: solo se permiten `hw.gpu.*` / `hw.gltransport` / `hw.keyboard` / `hw.audio*` / `hw.camera.*` / `hw.gps` / `vm.heapSize` / `hw.lcd.density`; la partición de datos, la memoria y el número de núcleos no se pueden cambiar desde fuera;
4. **Lista blanca de env**: solo pasan los prefijos `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_`; `PATH` / `SystemRoot` / `NODE_OPTIONS` se rechazan directamente;
5. Un solo archivo ≤256 KB; un archivo defectuoso solo registra el error y no afecta a los demás drivers; si no encaja, no surte ningún efecto.

## 4. Interfaz

La página de ajustes añade «Drivers · parches de compatibilidad»:

- Muestra el nombre, la versión, el autor, las condiciones de coincidencia y si está surtiendo efecto de cada driver;
- Interruptores: los ejemplos incluidos vienen desactivados y se activan con un clic (se escribe en los ajustes, sin modificar el directorio de instalación, que es de solo lectura);
- **Importar driver…**: seleccionas un JSON → se valida → se guarda en `%APPDATA%\apkstart\drivers\<id>.json` → se activa de inmediato;
- **Abrir directorio de drivers** / **Exportar plantilla de esta máquina** (`match` ya viene rellenado con los datos del equipo actual; basta con cambiar `effect`);
- Los archivos que fallan al cargar se explican uno por uno bajo la lista (sintaxis JSON, campo mal escrito, exceso de tamaño).

## 5. Integración en la cadena de arranque

- Se analizan una vez antes del arranque: los drivers que encajan se combinan en un único efecto (primero los de `priority` baja y luego sobrescriben los de mayor);
- `gpuMode` / `forceTcg` se aplican a **cada ronda** de intento de arranque (incluidos los reintentos de degradación automáticos): si el driver dice «esta máquina solo sirve con swangle», no tiene sentido volver a probar primero el backend que ya se cayó;
- `emulatorArgs` se añaden a la línea de comandos (`-gpu` / `-accel` los gestionan las dos opciones anteriores, para evitar parámetros duplicados);
- `configIni` sobrescribe sobre la marcha las claves del mismo nombre en `config.ini` y añade las que faltan;
- `env` se fusiona en el entorno del proceso del emulator;
- El registro de arranque escribe una línea `drivers: amd-igpu-swangle@1.0.0`, que también aparece en el informe de diagnóstico exportado.

## 6. Verificación

- Suite completa de pruebas solo con Node: **287 pruebas superadas**, de las cuales **29 son de drivers**: validación, coincidencia, combinación, interruptores, tolerancia al leer de disco, importación/exportación, rechazo por listas blancas (`-wipe-data` / `-partition-size` / `PATH` / inyección de salto de línea) y comprobación de que `buildArgs` / `env` / `config.ini` usan de verdad el efecto del driver;
- `scripts/selftest.js`: 9/9 (con `emulator-5554` real);
- El MSIX 0.5.7 se ha recompilado: la carga no contiene ningún archivo de emulador de terceros y el código fuente coincide con el del paquete.

## Notas de actualización desde 0.5.6

- `0.5.7.0 > 0.5.6.0`; la Store puede sobrescribir la actualización directamente; se conservan aplicaciones, partidas e instantáneas ya instaladas.
- Por defecto **no** se habilita ningún driver: los ejemplos incluidos tienen `enabled:false` y el comportamiento es idéntico al de 0.5.6.
- Para parchear tu máquina: Ajustes → Drivers → Exportar plantilla de esta máquina → cambiar `effect` → actualizar.

## Microsoft Store

- Paquete: `dist/store/ApkBuddyStart_0.5.7.0_x64.msix` (x64, unos 850 MB, runtime completo incluido)
- Identidad: `RoutineMiku.ApkBuddyStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Materiales de envío: `docs/store-listing.md` (incluye el texto «What's new» de esta versión en español e inglés)
- Documentación de drivers: `docs/drivers.md`
