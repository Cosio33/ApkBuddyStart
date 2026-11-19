# Recorrido del código de la pila de ejecución (sources / download / provision / updater / store / layers / utilidades)

> Versión del código: `package.json` = **0.3.5**, `main` = `src/main.js`.
> Los números de línea corresponden a la copia de trabajo actual (`D:\apkstart-dsh\apkstart`); los archivos pueden haber cambiado, así que antes de citar, comprueba el número de línea a partir del nombre de la función.
> Alcance de lectura: `src/core/{sources,download,provision,updater,store,layers,logfile,notify,android,display}.js`,
> además de los llamadores `src/main.js` / `src/core/{engine,emulator,installer}.js` y `test/`.
> Este documento solo describe hechos del código; «✓» = hay prueba, «✗» = sin cobertura.

Dirección de las dependencias (importante para evitar requires circulares):

```
main.js ──> engine.js ──> provision.js ──> sources.js ──> version.js
   │            │              │  │
   │            │              │  └──> download.js
   │            │              └─────> store.js / doctor.js / zip.js
   │            ├──> emulator.js ──> provision.js / logfile.js
   │            └──> layers.js ──> store.js (require diferido dentro de summary)
   ├──> updater.js ──> sources.js / download.js / zip.js / version.js
   ├──> installer.js ──> store.js / provision.js (a través de runtime.provisioner)
   └──> android.js / notify.js / display.js / logfile.js
```

La razón de que `version.js` exista por separado está escrita en `version.js:2-4`: evitar que `updater ↔ sources` se hagan require mutuamente y formen un ciclo.

---

## 1. `src/core/sources.js` — doble fuente GitHub / Gitee + espejos + medición de velocidad + caché de cortocircuito

### Responsabilidades
Abstraer «leer información de versiones» y «obtener URLs de descarga» como un grupo de URLs candidatas ordenadas por **velocidad real de bytes**, y aplicar un cortocircuito de corta duración a las fuentes limitadas o con errores.

### Interfaz pública

| Exportación | Firma | Descripción |
|---|---|---|
| `Sources` | `new Sources(settingsFn)` | `settingsFn: () => settings`; se lee en cada decisión (no se cachean los ajustes) |
| `Sources#blockedReason` | `(id: 'github'\|'gitee') => string\|null` | `null` = disponible; si no, devuelve el motivo «omitida temporalmente (no se volverá a intentar durante N minutos)» (230-234) |
| `Sources#fetchReleases` | `() => Promise<Array<{source,name,web,rel?,error?}>>` | Según `sourcePreference`, pregunta a una o a ambas; `Promise.all` en paralelo (237-271); se puede sobrescribir en pruebas |
| `Sources#latest` | `({force=false}) => Promise<Merged>` | Información de versión combinada (véase más abajo), caché de 10 minutos (277-364) |
| `Sources#candidates` | `(assetOrUrl: string\|{url}\|{urls:[]}) => string[]` | Primero la fuente original, después los espejos; deduplica conservando el orden (371-393) |
| `Sources#rank` | `(urls, {onProgress}) => Promise<string[]>` | Orden descendente por velocidad medida en los últimos 30 minutos; con ≤1 dirección devuelve directamente (399-432) |
| `Sources#reset` | `() => void` | Limpia la caché de velocidad + la de versión + el cortocircuito (435-439) |
| `SOURCES` | `{github:{id,name,api,web}, gitee:{...}}` | Constante; el owner está escrito a mano en 22-24 |
| `measure` | `(url, {bytes=256*1024, timeoutMs=9000}) => Promise<{url,ok,got,ms,ttfb,speed,error?}>` | Descarga realmente 256 KB para medir el rendimiento (108-157) |
| `withMirror` | `(url, prefix) => string` | Añade una barra final al prefijo; si no es `http(s)://`, devuelve `''` (160-164) |
| `mirrorList` | `(settings) => string[]` | Si hay un prefijo personalizado, solo ese; si no, los espejos integrados cuando `autoMirror!==false` (207-213) |
| `KNOWN_MIRRORS` | `['https://ghfast.top/','https://gh-proxy.com/']` | 42-45 |

Estructura devuelta por `latest()` (350-361):

```js
{
  version, tag, name, notes, htmlUrl, publishedAt,
  assets: [{ name, size, url, urls: string[], sizes: { [url]: bytes },
             parts?: [{index,size,urls:[]}], partial?: bool, source }],
  sources: [{ source, name, tag }],      // fuentes que participan en la combinación
  unreachable: [{ source, name, error }],
  bySource,                              // fuente ganadora
  stale?: true, staleReason?             // todas las fuentes cayeron pero hay un resultado anterior (296)
}
```

### Implementación clave

**1) Obtención de versión = preguntar a ambas en paralelo + degradar al endpoint de lista (248-269)**
- Primero `${api}/releases/latest`; si falla, `${api}/releases?per_page=10` y se toma la primera entrada que no sea `draft`;
- Un repositorio privado de Gitee responde **404 "Not Found Project"** (no 401); en ese caso se puede rellenar `runtime.giteeToken` de solo lectura (243-246 añaden `access_token`);
- Solo `403/429` activa el cortocircuito, con `_blockMs = 15min` (226, 263). **El cortocircuito también se registra una vez más en `latest()`** (286-290); el comentario explica que es para que «quién aporta el resultado» se pueda sustituir en pruebas (así lo inyecta auto-test).

**2) Estrategia de combinación**
- La versión se elige con `cmpVer` (299) y después **solo se conservan los assets de esa misma versión** (307-310);
- Lista blanca de assets: `/^ApkBuddyStart/i` (316), para excluir los paquetes de código fuente que Gitee adjunta automáticamente;
- Los assets con el mismo nombre de distintas fuentes se combinan en `urls[]` y se **registra `sizes{}` para cada dirección** (334-348): las dos fuentes comprimen a bytes distintos, así que nunca se pueden promediar;
- Si para la misma versión hay paquete completo y fragmentos, **se prefiere el paquete completo** (326-327);
- Si todas las fuentes fallan pero existe `_relCache.value`, se devuelve el resultado anterior marcado como `stale` (292-298), para que la interfaz no muestre un error directo.

**3) Tres capas de caché**

| Caché | Campo | TTL | Invalidación |
|---|---|---|---|
| Velocidad | `_rankCache: Map<url,{at,ok,speed}>` | 30 min (219) | `reset()`; `ok=false` también se cachea y cuenta como -1 al ordenar (418-421) |
| Versión | `_relCache: {at,key,value}` | 10 min (223) | `key` distinto (cambió `sourcePreference`) / `force` / `reset()` |
| Cortocircuito | `_blocked: Map<sourceId, untilMs>` | 15 min (226) | `reset()` |

**4) La medición de velocidad es «secuencial» (408-417)**: el comentario indica explícitamente que hacerla en paralelo hace que las conexiones compitan por el ancho de banda y el resultado pase a medir «quién pelea más fuerte». El coste es, en el peor caso, `número de candidatos × 9 s` (el `timeoutMs` de `measure`).

**5) El rendimiento solo cuenta el tiempo «después de recibir el primer byte» (120-122)**: `span = now - (firstAt || t0)`, para excluir el coste fijo de TLS/DNS; si no, una fuente «con mucha latencia pero mucho ancho de banda» se clasificaría erróneamente como lenta.

**6) Reconstrucción de fragmentos `groupParts` (172-204)**: `xxx.zip.part1/.part2` → asset lógico `{name, size=Σ, parts:[{index,size,urls:[]}], partial:true}`; si falta una dirección o los números no son consecutivos → `broken`, filtrado por `list`; la lista de `broken` se devuelve, pero `latest()` **no la expone hacia fuera**.

### Puntos delicados e invariantes

- **Gitee: 100 MiB por archivo** (comentarios de 172-204 y `.github/release.yml:36-44,78-100`): al superarlo se divide en `.part1/.part2`; `updater._downloadParts` se encarga de volver a unirlos.
- **Los assets de Gitee no tienen `size`** (198-201): por eso la «integridad» solo exige «fragmentos consecutivos + cada fragmento tiene dirección», y no se puede pedir `size>0`; cuando el tamaño es desconocido, el progreso se muestra con los bytes recibidos.
- **Los paquetes de código fuente `v1.2.3.zip` / `.tar.gz` se cuelan entre los assets** (313-316): los bloquea la lista blanca `^ApkBuddyStart`; una coincidencia por sufijo como `\.zip$` descargaría el paquete de fuentes como si fuera el de actualización.
- **Los espejos solo se pueden aplicar a URLs de GitHub** (366-369, 385-390): ghfast / gh-proxy solo proxyan GitHub; concatenarlos con Gitee da 403 y solo malgasta una medición.
- **Los assets con el mismo nombre deben conservar todas las direcciones** (329-333): antes se deduplicaban por nombre «el primero que llegue gana», como GitHub iba primero se perdían las direcciones de Gitee y la selección automática degeneraba en usar solo GitHub.
- `SAMPLE_BYTES = 256KB` (52), pero el comentario de `provision.installRuntimePack:532` todavía dice «128KB»: **el comentario está obsoleto, la implementación es 256 KB**.
- En `measure`, `openUrl` devuelve `res` (el flujo) y `done()` hace `req.destroy()` sobre el flujo, no sobre el objeto de la petición (115-132, donde `req = res`); funciona, pero el nombre es engañoso.
- `groupParts` también marca como `broken` el `part0` (numeración desde cero): en 196 se exige `index === i+1`.
- Invariante: el primer elemento de `candidates()` siempre es la **URL original de la fuente** (380-382) y `rank()` solo ordena cuando `length>1` (401): es la red de seguridad para «en el peor caso se puede descargar en directo».

### Quién lo llama
- `src/core/provision.js:16` (require), `:145` (`new Sources(() => store.getSettings())`), `:149-151` (`get sources`), `:535` (`rank`), `:588` (`candidates`, `_downloadUrls`).
- `src/core/updater.js:23,47` (`new Sources(this.settings)`), `:74` (`latest`), `:140-141` (`candidates`+`rank`), `:191-196` (cada fragmento con su `candidates`+`rank`).
- `src/main.js:819-825`: al cambiar en ajustes `sourcePreference/mirrorPrefix/autoMirror` → `updater.sources.reset()` + `provisioner.sources.reset()`. **Ojo**: aquí no se limpian `provisioner._cache.pack / emulatorUrl / sysimgUrl / playUrl` (véase los puntos delicados de §3).

### Cobertura de pruebas (`test/auto-test.js`)
- ✓ `:843` las URLs candidatas incluyen el prefijo del espejo; el prefijo personalizado prevalece sobre los espejos públicos
- ✓ `:864` los resultados de velocidad se ordenan por velocidad; si todo falla se conserva el orden original sin perder direcciones útiles (y se verifica `reset()`)
- ✓ `:878` el paquete de fuentes que Gitee adjunta automáticamente (`v1.2.3.zip`) nunca se puede tomar por paquete de instalación
- ✓ `:901` los assets de Gitee no tienen `size`: el grupo de fragmentos debe seguir formándose
- ✓ `:926` los assets fragmentados deben llegar enteros hasta `updater.asset`
- ✓ `:949` al combinar versiones solo se conservan los assets de la misma versión
- ✓ `:976` cuando el paquete completo está en ambas fuentes se conservan las dos direcciones
- ✓ `:1282` el resultado de versión se guarda en caché 10 minutos; `force` fuerza una nueva consulta
- ✓ `:1300` cortocircuito por 403 + texto de `blockedReason` + liberación con `reset()`
- ✓ `:1323` si todas las fuentes están inalcanzables se vuelve al último resultado (`stale`)

---

## 2. `src/core/download.js` — un solo flujo / fragmentos / paralelismo multificiente + reanudación + perro guardián

### Responsabilidades
Un descargador de cuatro capas que solo depende de `http/https/fs`: flujo único con reanudación → fragmentos de una sola fuente → fragmentos de varias fuentes (suma de ancho de banda) → cambio de fuente secuencial; todo con perro guardián de inactividad y protección de «finalización garantizada».

### Interfaz pública

| Exportación | Firma | Retorno |
|---|---|---|
| `openStream` | `(url, {method='GET', headers={}, redirects=0}) => Promise<IncomingMessage>` | Sigue 301/302/303/307/308 (≤6 saltos); tiempo de inactividad del socket 30 s (15-36) |
| `head` | `(url) => Promise<{status,size,type,error?}>` | Nunca lanza; si falla, `status:0` (38-50) |
| `sha256File` | `(file) => Promise<hex>` | 52-60 |
| `download` | `(url, dest, opt) => Promise<{file,size}>` | `opt = {onProgress,signal,expectSha256,retries=2,idleMs=30000}` |
| `downloadParallel` | `(url, dest, opt) => Promise<{file,size,parallel:n}>` | `opt += {connections=8,minChunk=1MB,retries=3}` |
| `downloadAny` | `(urls, dest, opt) => Promise<{file,size,url}>` | Prueba en orden; si todo falla, lanza un error agregado (314-326) |
| `downloadMulti` | `(urls, dest, opt) => Promise<{file,size,parallel,sources,multi,resumed}>` | `opt += {minChunk=2MB,retries=6,idleMs=20000,slowAfterMs=45000,slowBps=120*1024}` (338-548) |
| `downloadAnyParallel` | `(urls, dest, opt) => Promise<{file,size,url}>` | Usa `downloadParallel` en orden (551-563) |

Cuerpo del callback `onProgress`: `{got,total,percent,speed,eta}` (`downloadMulti` añade `sources`).

### Implementación clave

**1) `download()`: flujo único + reanudación (68-173)**
- Antes de cada intento, `statSync(dest).size` → `Range: bytes=existing-` (75-77);
- `416` se considera «ya está completo» y se hace `break` (82-86);
- `200` con `existing>0` = el servidor no admite reanudación → `rmSync` y se reescribe (97-100);
- Para respuestas que no son 200/206: se reintenta como máximo `retries=2` veces, con **retardo fijo de 1500 ms** (87-90);
- Perro guardián de inactividad `idleMs` (30 s por defecto): `kick()` se reinicia con cada dato recibido; al agotarse, `res.destroy()` + `finish(Error('conexión estancada (sin datos durante mucho tiempo)'))` (112-130). El comentario (109-111) documenta que, cuando la conexión se queda muda, `res` no emite ni `end` ni `error`, `pipe` nunca termina `finish` y toda la descarga se cuelga sin ningún error;
- `signal.abort` → `res.destroy(new Error('cancelado'))` (132-133);
- Al finalizar se fuerza `onProgress({percent:100})` (162-163); si `expectSha256` no coincide → borra el archivo y lanza error (165-171).

**2) `downloadParallel()`: fragmentos de una sola fuente (180-311)**
- Si ya hay un archivo no vacío → se degrada directamente a `download()`, para no perder el estado de los fragmentos (188-191);
- Sondeo de Range: `Range: bytes=0-0`; solo se paraleliza con 206 + `content-range`; si `total < minChunk*2` también vuelve al flujo único (193-210);
- `n = min(connections, ceil(total/minChunk))` y `per = ceil(total/n)` (212-213);
- Primero `ftruncateSync(fd,total)` crea el archivo vacío y después cada fragmento escribe en su posición con `fs.writeSync(fd, buf, 0, len, pos)` (219-220, 268);
- Cada fragmento se reintenta como máximo `retries=3` veces, con retardo de `800 * tries` ms (285-300);
- Al terminar se comprueba `size === total`; si no, lanza «descarga incompleta» (307-310).

**3) `downloadMulti()`: fragmentos de varias fuentes (338-548)**
1. `list = deduplicar(urls)`; si solo queda una → `downloadParallel` (350-352);
2. `Promise.all` sondea en paralelo el `content-range` de cada dirección para obtener el tamaño total (355-365); si ninguna admite Range → `downloadAnyParallel` (367-370);
3. **El tamaño total de referencia se toma de `usable[0].total`**, es decir, el primero que devolvió `rank()` (la fuente más rápida), no `Math.max` (371-377); solo se mezclan fuentes con `total === ese valor` (378-381);
4. `n = clamp(2..connections, ceil(total/minChunk))`; los fragmentos se reparten entre las fuentes de forma rotativa con `i % same.length` (384, 409-416);
5. **Archivo auxiliar de reanudación de fragmentos `${dest}.chunks.json`** (391-405): solo se acepta si `m.total===total && m.n===n && el tamaño de dest === total`; si no, se borran el archivo y el auxiliar y se empieza de cero. Los fragmentos completados se registran con `doneSet.add(c.start)` + `saveMeta()` (518-520);
6. Al reanudar, los fragmentos ya completados se cuentan en `got`, para que el progreso no vuelva a 0 (425-427);
7. **Cambio de fuente por velocidad baja**: si un fragmento lleva más de `slowAfterMs=45s` y su media es inferior a `slowBps=120KB/s`, y `c.rotates < 2` → `res.destroy()` y se lanza «esta fuente va demasiado lenta… cambiar de fuente y reintentar», conservando `c.pos` (446-451, 492-503). El comentario nombra el síntoma: **«se queda clavado en el 95 %»**;
8. Cada fragmento tiene `retries=6` (el comentario explica que 3 no bastan cuando «dos de tres fuentes se paran de vez en cuando»); al fallar se hace `c.src += 1` para cambiar de fuente, con retardo `600 * tries` (523-534);
9. Al salir por error se llama a `saveMeta()` antes de lanzar (526-528); al terminar con éxito se borra el auxiliar con `rmSync(meta)` (542).

**10) Doble seguro de «finalización garantizada»**: dentro de `fetchChunk` se mantienen `settled` y `finish()` propios; el perro guardián llama directamente a `finish`, porque `res.destroy(err)` a veces solo emite `close` y no `error` (466-480).

### Puntos delicados e invariantes

- **Solo se pueden mezclar fuentes que «declaren el mismo tamaño total»** (371-381), o se arma un archivo corrupto; cuando los tamaños difieren (GitHub y Gitee comprimen por separado) se usa solo la más rápida.
- **`c.rotates` debe inicializarse explícitamente a 0** (comentario en 415): `undefined < 2` es `false` y la lógica de cambio de fuente nunca se dispara (bug histórico).
- **En cada petición solo se permite cambiar de fuente una vez** (459-463): tras `destroy`, una conexión puede seguir recibiendo paquetes ya en buffer y disparar el cambio varias veces, saltándose fuentes.
- **La reanudación solo funciona en `download()` y `downloadMulti`**; `downloadParallel` degrada a flujo único al ver un archivo a medias (188-191): es una decisión de diseño, no un bug.
- `provision.installQemu:1100` pasa `{ resume: true }`, pero `download()` no tiene ninguna opción `resume` (69); la reanudación es automática: **ese parámetro es innecesario/un resto histórico**.
- `downloadMulti` no atiende `opt.signal` (solo lo hace `download()`); cancelar una descarga multifuente hoy solo se puede por tiempo de espera o error.
- La rama `416` de `download()` hace `break` y trata «el archivo existente» como completo (82-86); si `existing > total` (ultima escritura fallida) no se autorrepara: solo `expectSha256` lo puede detectar.
- El `timeout: 30000` de `openStream` es un tiempo de inactividad del socket, **no hay un tiempo de conexión separado**; si DNS se cuelga, se depende del temporizador de `measure/rank` en la capa superior.
- El UA en `download.js:13` es `ApkBuddyStart/0.2` y en `sources.js:64` es `ApkBuddyStart/0.3`: las dos difieren (sin impacto funcional, solo en logs y estadísticas del servidor).
- Invariante: el `onProgress` de todas las funciones de descarga llama una vez a `percent:100` antes de terminar con éxito (163, 308, 545); la UI no se queda en el 99 %.

### Quién lo llama
- `src/core/provision.js:14` (require), `:434` `downloadAny` (adb), `:541` `downloadMulti` (paquete completo de ejecución), `:912` `downloadAnyParallel` (emulator), `:1010` (imagen play), `:1052` (aehd), `:1143` (ISO), `:628-629`/`:1071-1072` `openStream` (obtener índices/páginas de directorio), `:1226-1228` `head` (`probeSources`).
- `src/core/updater.js:20,150` (`downloadMulti` del paquete de actualización), `:198` (`downloadAnyParallel` para cada fragmento).
- `test/engine-test.js:32`; `test/boot-test.js:23,38` (descarga real de ISO, se ejecuta con `test:boot`).

### Cobertura de pruebas
`test/engine-test.js`
- ✓ `:83` descarga completa + seguimiento de redirecciones
- ✓ `:89` reanudación (archivo a medias existente)
- ✓ `:101` sondeo HEAD + SHA256
- ✓ `:108` un fallo en la verificación SHA256 limpia el archivo
- ✓ `:118` descarga por fragmentos en paralelo: el contenido unido es idéntico
- ✓ `:133` si la fuente no admite Range se degrada automáticamente a flujo único

`test/auto-test.js` (levanta un servicio http local y usa bytes reales)
- ✓ `:995` descarga multificiente en paralelo: cuando los dos fuentes tienen tamaños distintos se sigue a la más rápida
- ✓ `:1068` fragmentos distintos se descargan de fuentes distintas y los bytes unidos deben ser exactamente iguales
- ✓ `:1108` tras un fallo, reintentar solo rellena los fragmentos que faltan (archivo auxiliar)
- ✓ `:1155` si la conexión se establece pero no llega ni un byte, debe agotar el tiempo y cambiar de fuente en lugar de colgarse
- ✓ `:1198` si una fuente solo da decenas de KB/s, cambiar de fuente en lugar de quedarse clavado en los últimos %
- ✓ `:1251` con una sola dirección disponible, degradar a fragmentos de una sola fuente
- ✓ `:1033` los fragmentos de una actualización se unen en orden y se aborta enseguida si el tamaño no cuadra (`updater._downloadParts`)

---

## 3. `src/core/provision.js` — arranque de la ejecución (adb / emulator / imagen del sistema / qemu / aehd)

### Responsabilidades
Sin depender de emuladores de terceros, se encarga de «descargar → verificar → descomprimir/instalar → escribir en disco» de adb, emulator, la imagen del sistema, AEHD, QEMU y el disco virtual, y gestiona de forma centralizada dónde van esos archivos (`paths()`), si hay espacio suficiente (`guardDisk`) y si la instalación salió bien (`checkEnv`).

### Interfaz pública (`class Provisioner`, exporta `{Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf}`)

| Miembro | Firma | Descripción |
|---|---|---|
| `constructor` | `(appRoot)` | 140-146; internamente `_sources = new Sources(() => store.getSettings())` |
| `get sources` | `Sources` | 149-151, comparte con updater la misma configuración de espejos/velocidad |
| `get root` | `string` | `settings.runtime.dir` o `%APPDATA%\apkstart\runtime` (192-195) |
| `paths()` | `Paths` | 197-245, véase la tabla siguiente |
| `ensureDirs()` | `Paths` | Crea root/qemu/platform-tools/images/_tmp/avdHome (247-253) |
| `guardDisk` | `(component, targetDir) => Promise<freeMB>` | Si no hay espacio, lanza un error directamente en español (262-277) |
| `hypervisor` | `() => Promise<{whpx,dll,hypervisorPresent,note}>` | Solo comprobaciones de archivo del orden de milisegundos (281-296) |
| `adbVersion` / `qemuVersion` / `emulatorVersion` | `() => Promise<{ok,path,version}>` | Cada uno con caché en memoria de 30 s (298-338, 687-714) |
| `inspectIso` | `(file) => {ok,iso9660,rawImage,size,reason,magic}` | Lee `CD001` en `0x8001` (341-365) |
| `checkEnv` | `() => Promise<Env>` | 367-424; de él depende por completo el «estado» de la UI |
| `installAdb` | `(onProgress) => {ok,path,version}` | 428-456 |
| `resolveRuntimePack` | `() => {url,name,size,tag,page,from}` | 476-516; busca en Gitee/GitHub en paralelo `ApkBuddyStart-runtime-*.zip` |
| `installRuntimePack` | `(onProgress) => {ok,name,tag}` | 522-580, despliegue con un clic de la versión ligera |
| `extractZip` | `(zipPath,destDir,{onEntry}) => destDir` | 591-622; >64 MB usa la versión por archivo y los fragmentos grandes van por flujo |
| `resolveEmulatorUrl` / `resolveSysimgUrl` / `resolvePlayUrl` / `resolveQemuUrl` | `() => Promise<string>` | Resolución dinámica desde índices/páginas de directorio de Google, con constantes de respaldo |
| `materializeImages` | `(onLog) => Promise<count>` | 722-794, `.img.xz/.gz` → `.img` (solo una vez) |
| `systemImageInfo` / `playImageInfo` | `() => {ok,dir,size,api,tag?,note?}` | 797-839 / 972-980 |
| `emulatorAccel` | `() => Promise<{ok,kind,note,...}>` | 845-902, `-accel-check` + caché en disco |
| `installEmulator` | `(onProgress) => {ok,path,version}` | 905-937 |
| `ensurePlatformTools` / `adbVersionPath` | `() / () => bool / string` | 940-955 / 957-963 |
| `installSystemImage` | `(onProgress)` | 966-969, equivalente a `installPlayImage` (solo hay una imagen base) |
| `installPlayImage` | `(onProgress) => playImageInfo` | 1004-1044, aprovecha para limpiar `android-30` |
| `installAehd` | `(onProgress) => {ok,dir,installer}` | 1047-1062, solo descarga, no instala |
| `installQemu` | `(onProgress) => {ok,path,version}` | 1090-1130, instalación silenciosa NSIS `/S /D=` |
| `downloadIso` / `inspectImage` / `importIso` / `importDisk` | | 1134-1195 (vía QEMU) |
| `createDisk` | `(sizeGB=24, onProgress)` | 1199-1220, `qemu-img create -f qcow2` |
| `probeSources` | `() => {adb,qemu,iso}` | 1224-1231, sondeo HEAD de tres URLs fijas |
| `envCacheGet/Set`, `invalidateEnvCache`, `_envKey` | | 154-188, caché en disco de la detección de entorno |

`paths()` devuelve (225-245):

```js
{ root, qemuDir, qemuExe, qemuImg,
  adbDir, adbExe,
  emulatorDir, emulatorExe,
  sysImgRoot,                       // ★ véanse las tres ramas más abajo
  sysImgDir: <sysImgRoot>/android-34/google_apis_playstore/x86_64,
  avdHome, aehdDir,
  imagesDir, iso, disk, tmp,
  sysTag:'google_apis_playstore', sysApi:'34', sysAbi:'x86_64' }
```

`checkEnv()` devuelve (387-423):

```js
{ adb:{ok,path,version,required}, emulator:{ok,path,version,required,note},
  sysimg:{ok,dir,size,api,required,note}, playImage:{ok,dir,size,...},
  accel:{ok,kind,note}, qemu:{ok,...}, iso:{ok,path,size,iso9660,reason,...},
  disk:{ok,path,size,note}, hypervisor:{...},
  ready, engine:'emulator'|'qemu'|'none', paths }
```
`ready = adb.ok && (emulatorReady || qemuReady)`; `emulatorReady = emulator.ok && (sysimg.ok || playImage.ok)` (384, 420).

### Implementación clave

**1) Las tres reglas de rutas de `paths()` (197-245): es la única autoridad sobre «en qué disco acaba la imagen»**

- `root`: `settings.runtime.dir`; si está vacío, `%APPDATA%\apkstart\runtime` (192-195).
- `avdHome` (237): `settings.runtime.avdDir`; si no, **si root no está bajo `DATA_DIR`**, se usa `<DATA_DIR>/avd`; si no, `<root>/avd` (202-209). El motivo (202-206): en la distribución de un solo archivo la ejecución se extrae en un directorio temporal, y poner el AVD ahí equivaldría a perder las aplicaciones cada vez que se sale.
- Tres ramas para `sysImgRoot` (217-224):
  1. Si ya existe `<root>/system-images` → se usa (resultado de descomprimir el paquete completo);
  2. Si no, pero existe `<DATA_DIR>/system-images` → se usa (usuarios antiguos / distribución de un solo archivo);
  3. Si no existe en ninguno de los dos sitios → **se crea en `<root>/system-images`** (instalación nueva; el comentario indica que CI cuenta con esto para ensamblar la ejecución y que `DATA_DIR` podría estar redirigido a un directorio temporal).

**2) `materializeImages()` (722-794)**
- El directorio de origen es siempre `<root>/system-images` (723) y el **directorio de destino es `this.paths().sysImgRoot`** (726); el comentario exige que ambos usen el mismo conjunto de reglas, o aparece el caso «el paquete se extrae en D: y la imagen se despliega de nuevo en C:\AppData» (medido: 1,2 GB + 3,3 GB conviviendo).
- Recorrido: `.img.xz` antes que `.img.gz` (`found` Map, 729-741); los demás archivos (`kernel-ranchu`, `ramdisk.img`, `.img` sin comprimir) **deben copiarse también** (728, 751-760), o el emulador dice que «falta la imagen del sistema».
- Criterio de «ya desplegada»: `fileSize(dest) > 32MB` → se omite (765).
- Descomprimir `.xz` requiere eludir el punto de entrada ESM del paquete (771-781): `require.resolve('@napi-rs/lzma')` para obtener el directorio y luego `require(dir/index.js)`; el comentario explica que el Node 20 de Electron no admite `require('stream-polyfill.mjs')` y que `exports` no permite escribir directamente `/index.js`.
- Si falla una sola imagen, solo se hace `onLog('falló al desplegar la imagen: …')` (790), **sin propagar el error hacia arriba**.

**3) `installRuntimePack()` (522-580): el «un clic» de la versión ligera**
- `resolveRuntimePack()`: primero la URL personalizada `settings.runtime.runtimePackUrl` (477-478, con `size:0`); el resultado se guarda en `this._cache.pack` y **nunca se invalidó** (479, 514);
- Pregunta en paralelo a GitHub/Gitee `releases?per_page=15`, busca en `assets` la expresión `/^ApkBuddyStart-runtime-.*\.zip$/i` y toma el tag más alto según `cmpVer` (487-515);
- `guardDisk('runtime', p.root)` (525) → **`'runtime'` no está en la tabla `need`**, así que cae en el valor por defecto de 512 MB + 1024 MB de buffer = 1536 MB (264-266);
- `rank(this._downloadUrls(pack.url))` para medir velocidad (534-536); si falla, se vuelve a los candidatos originales;
- `downloadMulti(urls, tmp/runtime-pack.zip, {connections: settings.runtime.downloadConnections||8})` (529, 541-555); **la progresión se reasigna como `percent = clamp(1..90, pct*0.9)`** (551);
- Compuerta de tamaño: `< 200MB` → lanza «el paquete completo de ejecución está incompleto, se puede reintentar la reanudación» (556);
- `extractZip(zip, p.root, {onEntry})` (559-565), progreso de 91 a 99;
- Escribe la marca `<root>/.runtime-pack.json` (`{name,tag,at,from}`) y borra el zip (566-571);
- **Inmediatamente después**, `materializeImages(...).catch(() => 0)` (573-576): el comentario explica que, si no, el `checkEnv()` que viene a continuación pensaría que no hay imagen instalada y bajaría otro paquete de 1,4 GB de Google;
- Devuelve `{ok,name,tag}`, progreso 100.

**4) `extractZip()` (591-622)**
- Si `fileSize > 64MB` → `new ZipFile(path)` (sin meter todo en memoria); si no → `new ZipArchive(fs.readFileSync(...))`;
- Una entrada con `uncompSize > 64MB` usa `zip.pipeTo()` por flujo; las demás se escriben con `fs.writeFileSync(zip.read())`;
- `finally { zip.close() }` (618-620).

**5) `checkEnv()` (367-424)**: `Promise.all` lanza 5 detecciones (adb/qemu/hypervisor/emulator/accel) y además `inspectIso`, `fileSize(disk)`, `systemImageInfo()` y `playImageInfo()`; `sysimg.ok` se define como `systemImageInfo().ok || playImageInfo().ok` (381-399).

**6) Caché en disco de la detección de entorno (126-188)**
- Archivo: `%APPDATA%\apkstart\cache\env.json` (129-131);
- key = `ruta del exe + exe(size:mtime) + aehd.sys(size:mtime) + existencia de WinHvPlatform.dll` (154-162);
- TTL: las conclusiones favorables 6 h (126); **las desfavorables solo se creen durante 10 minutos** (127, el usuario podría haber activado la virtualización hace poco);
- En caso de fallo de arranque, emulator llama a `invalidateEnvCache()` (`emulator.js:848,886`).

**7) `emulatorAccel()` (845-902)**: interpreta el texto de `-accel-check`; tres reglas de respaldo: falta `emulator-check` pero existe `aehd.sys` → se considera disponible (879-883; el comentario indica que «evita clasificar erróneamente que no hay aceleración y forzar `-accel off`, porque la emulación por software se cae directamente en algunas máquinas»); `hasAehdFile && /aehd/` → disponible (884); `hv.dll && /whpx/` → disponible (886); en cualquier otro caso `viaTcg: true` (888-897).

**8) Guarda de disco `guardDisk()` (262-277)**

| component | need(MB) | + buffer 1024MB |
|---|---|---|
| adb | 64 | 1088 |
| emulator | 600 | 1624 |
| sysimg / playimg | 1800 | 2824 |
| qemu | 320 | 1344 |
| iso | 1100 | 2124 |
| aehd | 64 | 1088 |
| No listado (p. ej. `'runtime'`) | 512 | **1536** |

Si no hay suficiente espacio, lanza: «espacio insuficiente en el disco de destino: este componente necesita unos N MB… cambia el «directorio de datos de ejecución» a una unidad con más espacio (Ajustes → Integración del sistema → Directorio de datos de ejecución → Examinar)».

### Puntos delicados e invariantes

- **El destino de la imagen debe coincidir con `paths().sysImgRoot`**: `installPlayImage` extrae en `p.sysImgRoot` (1023), `materializeImages` tiene como destino `paths().sysImgRoot` (726) y `playImageInfo` consulta `p.sysImgRoot` (974). Cualquier código nuevo que monte por su cuenta `<DATA_DIR>/system-images` reproducirá el caso «configuré el directorio de ejecución pero sigue descargando en AppData».
- **La estimación de `guardDisk('runtime')` se queda corta**: 512+1024=1536 MB, mientras que en realidad son «paquete de 1,5 GB + zip en disco + system.img de 3,3 GB extraído + descompresión .xz». En máquinas con poca espacio falla durante la extracción y deja archivos a medias (`installRuntimePack` no tiene lógica para limpiar el zip a medias; depende de la siguiente reanudación).
- **`this._cache.pack` / `emulatorUrl` / `sysimgUrl` / `playUrl` no tienen punto de invalidación**: `main.js:819-825` solo hace `sources.reset()`. Si el usuario cambia `sourcePreference` o la URL del paquete completo en ajustes, el mismo proceso sigue usando la dirección antigua (`runtimePackUrl` es la excepción, porque se lee de los ajustes cada vez, 477).
- **El fallo de `materializeImages` se traga en dos sitios**: su propio `.catch(e => onLog(...))` (790) más el `.catch(() => 0)` del llamador (576). Si falta `@napi-rs/lzma` o el antivirus lo bloquea → la imagen nunca se despliega → `checkEnv().sysimg.ok === false` → cada arranque vuelve a seguir la ruta «descargar ejecución» (típico «se queda en preparando la ejecución»).
- **`emulatorVersion()` no cachea los fallos** (687-714): con `ok:false` se sale directamente, sin `envCacheSet` ni caché en memoria de 30 s; cada `checkEnv()` vuelve a ejecutar `execFile(emulator.exe -version)` con hasta 20 s. Solo la ruta correcta escribe caché (707-710).
- **La caché de `emulatorVersion` solo vive en memoria/en disco, y `_cache.emulatorVerAt` solo se asigna si tiene éxito**: la ruta de fallo hace que el sondeo de estado arranque el proceso una y otra vez.
- **`extractZip` no valida zip-slip**: `path.join(destDir, name)` se compone directamente (606); en cambio `updater._extract` sí protege con `startsWith(path.resolve(dest))` (updater:237): las dos están desincronizadas. Tanto el paquete completo de ejecución como el de actualización vienen de los releases del proyecto y el riesgo es bajo, pero quien se haga cargo no debería usar `extractZip` con entradas no confiables.
- **La dirección personalizada de `resolveRuntimePack()` tiene `size: 0`**: el progreso de descarga solo se puede estimar por sondeo o por bytes recibidos; `total` también es 0 en `installRuntimePack` y el texto `mb` carece de «/ tamaño total».
- **`installAdb` extrae en `p.root`** (446) y el zip ya trae `platform-tools/` en el nivel superior; `installEmulator` hace lo mismo (926). Por eso root es a la vez `ANDROID_SDK_ROOT` (comentarios en 232-234).
- **`ensurePlatformTools()` (939-955)**: el emulator exige que haya `platform-tools` bajo la raíz del SDK o sale FATAL; esta función copia 3 archivos (`adb.exe` + dos dll) desde `engine/platform-tools`, `tools/platform-tools` o el directorio donde esté `settings.adbPath`.
- **`installAehd` solo descarga** (1047-1062); instalar requiere administrador: `main.js:1121-1200` usa `silent_install.bat` + UAC.
- **Instalación de QEMU**: NSIS `/S /D=<dir>`; `/D` debe ir al final y sin comillas (1112-1116); a los 600 s se mata el proceso con `setTimeout` (1119).
- **`systemImageInfo()` (797-839)**: primero busca en `paths().sysImgDir` y después enumera todos los `android-*/tag/abi` bajo `sysImgRoot`, `<root>/system-images` y `<appRoot>/engine/system-images` (en orden descendente de API); cualquier juego con `system.img > 300MB` y `kernel-ranchu` se considera válido. Es el punto de compatibilidad para que «la versión completa pueda traer solo una imagen AOSP más pequeña».
- **Relación entre `playImageInfo()` y `sysimg.ok`**: `checkEnv().sysimg.ok` las combina con OR (390-399), pero `engine.ensure()` usa `env.sysimg.ok` (`engine.js:852`), así que con solo la imagen play también se puede arrancar.
- **Invariante**: el `onProgress` de todos los `install*` informa con la forma `{stage:'download'|'extract'|'install'|'done', percent}`; `main.js:317` añade `component` de forma centralizada y, en la UI, `app.js:357 updateStepProgress` solo lee `percent/message`.
- Las versiones de respaldo escritas a mano en `SOURCES` se quedan obsoletas (`emulator-windows_x64-16847572.zip`, `x86_64-34_r14.zip`, 27-41); solo se usan cuando no se puede obtener el índice.

### Quién lo llama
- `src/core/engine.js:16,54` (`new Provisioner(appRoot)`), `:79,202,393,995` (`paths()`), `:109,235,368,635,849,996` (`checkEnv`), `:264,761` (`emulatorAccel`), `:639` (`createDisk`), `:848` (`materializeImages`), `:1017,1021` (`paths().root` → layers), `:873` (`needsSetup`).
- `src/core/emulator.js:17,29`, `:53,225` (`paths`/`ensureDirs`), `:56,63` (`systemImageInfo`), `:62,723` (`playImageInfo`), `:659` (`adbVersionPath`), `:761-762` (`emulatorAccel`+`emulatorVersion`), `:848,886` (`invalidateEnvCache`).
- `src/core/installer.js:95-99` (`playImageInfo` + `installPlayImage`, se descarga bajo demanda al encontrar la primera app ARM); `:159,169,190,489` (decisiones con `playImageInfo`).
- `src/main.js`: `:314-354` (flujo principal de `autoDeploy`), `:707` (`paths().root` para la UI), `:824` (`sources.reset`), `:898,932,939,946,953,964,977` (autocomprobación/diagnóstico), `:1076-1269` (varios IPC `provision:*`), `:1330,1542` (`avdHome`/`root`), `:1631` (`checkEnv` antes del precalentamiento).
- `test/engine-test.js:146-220,391-401`, `test/auto-test.js:1347-1350`, `test/boot-test.js:44`.

### Cobertura de pruebas
`test/engine-test.js`
- ✓ `:149` el directorio de ejecución por defecto está bajo el directorio de datos
- ✓ `:156` comprobación con entorno vacío: adb no está listo, la estructura de componentes es completa
- ✓ `:166` la descompresión ZIP integrada funciona
- ✓ `:197` las URLs relativas del índice del SDK se completan a absolutas (`absUrl`/`baseOf`)
- ✓ `:211` las URLs resueltas de emulator/imagen del sistema son URLs absolutas descargables
- ✓ `:244` verificación de imagen: distingue ISO9660 válida / dañada / sin descargar (`inspectIso`)
- ✓ `:391` `playImageInfo` verifica la integridad de la imagen compatible con API 34

`test/auto-test.js`
- ✓ `:1339` **destino de la imagen del sistema: una instalación nueva debe caer en el directorio de ejecución** (cubre las tres ramas de `paths().sysImgRoot`)

`test/boot-test.js:44` ejecuta `checkEnv` real + arranque en equipo real (`npm run test:boot`; funciona sin red pero necesita la ISO).

**Sin cubrir**: `installRuntimePack`, `resolveRuntimePack`, `materializeImages`, `installAdb/installEmulator/installPlayImage/installAehd/installQemu` y `guardDisk` no tienen ninguna prueba unitaria (todas requieren red real/archivos grandes).

---

## 4. `src/core/updater.js` — actualización en línea (check / prepare / apply)

### Responsabilidades
Obtener la última versión de los Releases de GitHub/Gitee de este repositorio, elegir el asset según la forma de instalación, descargarlo y ensamblar la carga útil, y generar un script de PowerShell de sobrescritura que ejecuta «reemplazar + reiniciar» después de que el proceso salga.

### Interfaz pública (exporta `{Updater, cmpVer, OWNER, REPO}`)

| Miembro | Firma | Descripción |
|---|---|---|
| `constructor` | `({currentVersion, exePath, isPackaged, dataDir, settings?, onProgress?})` | 38-50; `this.installDir = dirname(exePath)`, `this.sources = new Sources(settings)` |
| `get flavor` | `'setup' \| 'portable'` | 53-59: si en `installDir` hay `Uninstall *.exe` → `setup` |
| `get updateDir` | `<dataDir>/update` | 61-63 |
| `check` | `({force=false}) => Promise<Latest>` | 73-115, véase más abajo |
| `prepare` | `(info?) => Promise<{mode:'zip'\|'setup', payload, version}>` | 121-176 |
| `_downloadParts` | `(asset, target, conns, total)` | 182-227, descarga de fragmentos + unión ordenada |
| `_extract` | `(zipPath, dest)` | 229-251, con protección zip-slip y streaming por entrada |
| `apply` | `(job, {waitPid?, spawn?}) => true \| script` | 258-325; con `spawn:false` solo devuelve el script (para pruebas) |
| `static repoUrl()` | `() => 'https://github.com/RoutineMiku/apkstart/releases'` | 328-330 |
| `cmpVer` | reexportado desde `version.js` | 333 |

`check()` devuelve (82-112):

```js
{ version, tag, name, notes, htmlUrl, publishedAt,
  asset: { name, size, url, urls[], sizes{}, source, parts?, partial? } | null,
  assets, sources, unreachable,
  flavor, hasUpdate, current, canAutoApply }
```
Selección de `asset` (77-80):
- `setup`: `/Setup\.exe$/i` → respaldo `/win.*\.exe$/i`
- `portable`: `/portable.*\.zip$/i` → `/win64.*\.zip$/i` → **`/\.zip$/i`**
`hasUpdate = cmpVer(merged.tag, current) > 0` (109); `canAutoApply = !!asset && (asset.url || asset.parts?.length)` (111).

### Implementación clave

**1) `check()` (73-115)** solo hace «metadatos + elegir asset»; las URLs de descarga no se miden hasta `prepare()`. `force` se reenvía a `sources.latest`.

**2) `prepare()` (121-176)**
- Directorio de carga útil `<dataDir>/update/<version>/`;
- Si hay `asset.parts` → `_downloadParts` (133-134);
- Si no → `candidates(asset)` → `rank()` → `downloadMulti(ranked, file, {connections})` (136-163);
- **Cómo se toma el tamaño total del progreso**: `sizes[url]` se recorre en orden de `ranked` y se usa el primer valor conocido (142-147); el comentario advierte que elegir el equivocado hace que «se muestre 92 % todo el rato y de repente salte a completado»;
- `.zip` → se extrae en `payload/` → `{mode:'zip',payload:out}`; cualquier otro → `{mode:'setup',payload:file}` (166-175).

**3) `_downloadParts()` (182-227)**: cada fragmento tiene su propio `candidates + rank` (puede ir parte por Gitee y parte por un espejo), se descarga con `downloadAnyParallel` a `<name>.<index>.tmp`, se valida `part.size` (si se conoce, 211-216), se escribe en orden con `fs.writeSync(fd, buf, 0, len, doneBytes)` y al final se comprueba `doneBytes === total` (224-226). Cada fragmento se lee entero en memoria con `readFileSync` (213); como mide ≤100 MiB, es aceptable.

**4) `apply()` (258-325): el tramo más crítico de la cadena de actualización**
El script generado (`lines`, 265-307) hace, en orden:
1. `$ErrorActionPreference='SilentlyContinue'`; `Note()` escribe en `<updateDir>/update.log`;
2. `Wait-Process -Id <waitPid> -Timeout 90` + `Sleep 700ms` (270-272);
3. Si `mode==='zip'`: `Copy-Item -Recurse -Force` **hasta 12 rondas**, usando como sonda «si existe el exe de destino»; si falla, `Sleep 600ms` (275-290); después `Remove-Item $src` (el directorio descomprimido, 289);
4. Si `mode==='setup'`: `Start-Process -ArgumentList '/S' -Wait` y registra el código de salida (291-298);
5. Vuelve a lanzar el `exe` (300-301);
6. `Remove-Item <updateDir>/<version> -Recurse -Force` y, por último, **`exit 0`** (304-306; el comentario indica que un fallo en la limpieza no debe hacer creer al llamador que la actualización falló).

Forma de lanzamiento (309-324):
- El script primero se escribe en disco como `update/apply.log.ps1` para facilitar el diagnóstico (310);
- La ejecución real usa `-EncodedCommand` (UTF-16LE en base64, 313); el comentario explica que así se **evita que PS 5.1 decodifique como ANSI/GBK un script sin BOM** y corrompa las rutas en español;
- **No se puede usar `detached`** (315-318): cierto software de seguridad/sandboxes bloquean «los procesos de consola separados», y el síntoma es que el script ni siquiera se ejecuta (la interfaz se queda en «reemplazando el programa y reiniciando»); se usa un proceso hijo normal + `child.unref()`;
- `spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',b64], {stdio:'ignore', windowsHide:true})`.

### Puntos delicados e invariantes

- **La distinción entre versión instalada y portátil se hace mirando «si hay `Uninstall *.exe` en el directorio de instalación»** (53-59), no hay ninguna otra marca; NSIS sobrescribe en silencio y la versión portátil sobrescribe copiando.
- **La sobrescritura no elimina los archivos que sobraban de la versión anterior** (comentario 287-288), solo limpia el directorio descomprimido de esta vez; por eso los «dll sobrantes de una versión eliminada» podrían afectar a la nueva (ahora mismo se considera inofensivo).
- **Después de `apply()`, el llamador debe salir**: `main.js:594-596` llama a `apply(job)` y 900 ms después ejecuta `app.quit()`; el script espera como máximo 90 s.
- **Gitee 100 MiB → `.part1/.part2`** (comentarios 130-134); `sources.latest` ya combina los fragmentos en un asset lógico, y `check()` debe arrastrar `parts` hasta el final (88-101); auto-test:926 lo protege específicamente.
- **`sizes` se registra por dirección**, no se puede resolver con un único `asset.size` (142-147, sources:339-347).
- **Posible error: el respaldo por defecto `/\.zip$/i` puede tomar el paquete completo de ejecución por paquete de actualización** (80). En un mismo release hay tanto `ApkBuddyStart-vX-win64-portable.zip` como `ApkBuddyStart-runtime-vX.zip` (`.github/workflows/release.yml:44,187`); ahora mismo no pasa nada porque la regex de `portable` coincide primero, pero si el paquete portátil cambia de nombre, `/\.zip$/i` elegirá el paquete de ejecución de 1,5 GB y sobrescribirá el directorio del programa.
- **`prepare` no valida la integridad del zip descargado**: solo `_extract` revela el error; si el tamaño descargado no cuadra con `total`, `downloadMulti` lanza error (download:546).
- **La actualización solo se comprueba con la aplicación empaquetada**: `main.js:1665 if (app.isPackaged)`; en desarrollo no se comprueba.
- Invariante: `apply()` debe llamarse después de que `prepare()` haya tenido éxito (si `prepare` no produce carga útil lanza error y `main.js:592` lo captura para enviar `sendProgress({stage:'error'})`).
- `flavor` hace `readdirSync(installDir)` cada vez, sin caché (53-59): llamarlo con mucha frecuencia genera E/S de disco; ahora solo se usa en check/UI.

### Quién lo llama
- `src/main.js:38` (require), `:1503-1511` (construcción, inyecta `settings`/`onProgress`), `:579-604` (`runUpdate`: `check`→`prepare`→`apply`→`quit`), `:496,584,588` (comprobación manual/del bandeja + `repoUrl()`), `:1447` (`app:updateCheck`, `force` por defecto verdadero), `:1456` (`app:updateOpen`), `:1461` (`app:updateApply`), `:1667` (comprobación silenciosa a los 8 s del arranque).
- `src/preload.js:71-72` (`updateCheck` / `updateApply`); `src/ui/app.js`, página de ajustes «Actualización de software».

### Cobertura de pruebas (`test/auto-test.js`)
- ✓ `:820` la comparación de versiones es numérica segmento a segmento (`cmpVer`)
- ✓ `:828` la forma de instalación decide qué asset se elige + comprobación de `flavor`
- ✓ `:926` los assets fragmentados deben llegar enteros a `updater.asset` (si no, `prepare` dice «no hay direcciones de descarga disponibles»)
- ✓ `:1033` los fragmentos de una actualización se unen en orden y se aborta enseguida si el tamaño no cuadra (`_downloadParts`)
- Cobertura indirecta: `:843/:864/:878/:901/:949/:976` (`sources`), `:995/:1068/:1108/:1155/:1198/:1251` (`downloadMulti`)
- **Sin cubrir**: el contenido del script que genera `apply()` (no hay ninguna aserción que lea `apply.log.ps1`), el zip-slip de `_extract` y la selección de `sizes` en `prepare`.

---

## 5. `src/core/store.js` — persistencia de ajustes y del manifiesto de aplicaciones

### Responsabilidades
Un almacén JSON «fusiona valores por defecto al leer + escribe de forma atómica»: `%APPDATA%\apkstart\{settings.json,apps.json,icons/,apks/}`.

### Interfaz pública (`module.exports = store`)

| Miembro | Firma | Descripción |
|---|---|---|
| `DATA_DIR` / `ICON_DIR` / `APK_DIR` | `string` | 10-14; `DATA_DIR = %APPDATA%\apkstart` |
| `getSettings()` | `() => Settings` | 175-186: `deepMerge(DEFAULT_SETTINGS, contenido-en-disco)` + **migración forzada** |
| `saveSettings(patch)` | `(patch) => Settings` | 188-196: `deepMerge(actual, patch)`; si existe `engine.resourceMode`, se traduce a tres interruptores |
| `getApps()` | `() => App[]` | 198-201; un archivo corrupto cae a `[]` |
| `saveApps(apps)` | `(apps) => void` | 203-205 |
| `upsertApp(app)` | `(app) => app` | 207-214, fusiona por `package` |
| `removeApp(pkg)` / `getApp(pkg)` | | 216-223 |
| `iconPath(pkg)` / `apkPath(pkg,version='cur')` | `=> string` | 225-231 |
| `ensureDirs()` | `() => void` | 119-123 |
| `DEFAULT_SETTINGS` | objeto constante | 16-117; lo consultan directamente las pruebas y doctor |

### Implementación clave

- **Escritura atómica** (133-138): se escribe `<file>.tmp` → `renameSync`, para evitar JSON a medias.
- **`deepMerge` (140-150)**: solo recursa en objetos normales; los arrays y escalares se sobrescriben directamente; `base[k]` debe ser un objeto para que haya recursión.
- **Migración al leer (175-186): tres sobrescrituras forzadas, sin campo de versión**:
  - `s.engine.headless = false` (179): el modo sin cabeza de las versiones antiguas ≠ ganar ventanas;
  - `s.hideAfterLaunch = false` (181): antes, salir de la cáscara mataba toda la ejecución;
  - `s.freeform = false` (184): antes, la ventana freeform pequeña se convertía en «una ventana dentro de otra».
  Como se sobrescribe en cada lectura, los `true` de un settings.json antiguo dejan de valer para siempre (auto-test:455 lo asevera).
- **Traducción de la estrategia de recursos (160-170, 191-193)**: `save`→`liteMode:true/priorityMode:balanced/renderSize:540x960`; `smooth`→`false/performance/720x1280`; `balanced`→`true/balanced/auto`. Solo se dispara cuando aparece `patch.engine.resourceMode`, para no pelearse con los interruptores detallados.
- **«Restricciones de hecho» en los valores por defecto** (escritas en comentarios, no las borres al leer):
  - `engine.headless:false` (28-30): en modo sin cabeza, SurfaceFlinger no genera VSYNC; la app sigue viva pero sin imagen;
  - `engine.badGpu:''` (32-34): registra `<versión-de-emulator>|<gpu>` de los backends que «se caen al arrancar»; caduca automáticamente al actualizar la ejecución;
  - `runtime.dir:''` (68) = `%APPDATA%\apkstart\runtime`;
  - `runtime.downloadConnections:8` (88);
  - `runtime.sourcePreference:'auto'` (91), `autoMirror:true` (94), `giteeToken:''` (97);
  - `runtime.compatImage:false` (78): **prácticamente en desuso**: `provision.checkEnv:381-384` ya no depende de él y trata la imagen play como imagen principal;
  - `engine.logLimitKB:2048` (55), no hay `engine.prefetch`, `engine.prewarm:true` (65);
  - `display.portrait:'900x1600'` (112), pero `main.js:276` usa `d.portrait || '540x960'` (los valores por defecto no coinciden; en la práctica manda el 900x1600 que ya existe en settings).
- **A `DEFAULT_SETTINGS` le falta `runtime.avdDir`**: `provision.paths():207` lee `runtime.avdDir`, que en una instalación nueva vale `undefined`; solo existe después de que la UI lo escriba (`ui/app.js:1203`). Igual pasa con `runtime.installed`, que lee `engine.js:870` pero no está en los valores por defecto.

### Puntos delicados e invariantes

- **`getSettings()` hace `readFileSync + JSON.parse` en cada llamada, sin caché en memoria** (175-186). Y `provision.paths()` necesita leer los ajustes de 2 a 4 veces por llamada (193, 207, 209, etc.), y `checkEnv()` se invoca desde varios sitios por el sondeo de estado → lecturas frecuentes de archivos pequeños. Aquí está el primer punto donde optimizar el rendimiento.
- **`saveSettings` escribe «el objeto completo fusionado»** (189-194), así que settings.json arrastra todos los valores por defecto del momento; los valores por defecto añadidos en futuras versiones no se escriben, solo se fusionan al leer: por eso la migración puede estar en la lectura.
- La migración es **unidireccional y forzada** (179-184); si en el futuro se quiere permitir reactivar headless, hay que cambiar aquí y no en la UI.
- El `renameSync` de `writeJson` falla al cruzar volúmenes (no hay problema cuando `os.tmpdir` y `DATA_DIR` están en el mismo volumen; en las pruebas se cambia `APPDATA` pero se sigue en el mismo volumen).
- Aislamiento en pruebas: se cambia `process.env.APPDATA` y se **vuelve a hacer require** (`auto-test.js:11,1344-1347`); `DATA_DIR` es una constante evaluada al cargar el módulo, así que cambiar el env dentro del mismo proceso no surte efecto: tenlo en cuenta al escribir pruebas.

### Quién lo llama
- `src/core/provision.js:12,145,192,197-237,452,1159,1187,1193,1217`.
- `src/core/engine.js:15,1017-1021` (`store.DATA_DIR`), `src/core/emulator.js:16`, `src/core/installer.js:10`, `src/core/sharer.js:10`, `src/core/layers.js:162` (require diferido dentro de `summary`).
- `src/main.js`: en todo el flujo (migración al arrancar, `app:info`, `settings:get/set`, `bootstrabBundledRuntime:97-171` llama directamente a `saveSettings({runtime:{dir}})`).
- `test/engine-test.js:147`, `test/auto-test.js:456,700,1346,1374,1386`, `test/boot-test.js:21`.

### Cobertura de pruebas
- ✓ `auto-test.js:455` migración forzada de configuración antigua: el modo sin cabeza y «salir tras el arranque» dejan de aplicarse
- ✓ `auto-test.js:1373` un cambio en la estrategia de recursos se traduce automáticamente a vCPU/prioridad/resolución
- ✓ `auto-test.js:1385` el tamaño de la partición de datos es configurable y el valor por defecto ya no es un número fijo
- ✓ `engine-test.js:149` el directorio de ejecución por defecto está bajo el directorio de datos (depende de `DATA_DIR`)
- **Sin cubrir**: `upsertApp/removeApp/apkPath/iconPath` y la atomicidad de `writeJson`.

---

## 6. `src/core/layers.js` — inventario / reciclado de capas del contenedor

### Responsabilidades
Tratar el directorio de ejecución como capas de imagen para hacer un **inventario de solo lectura** y un **reciclado según una lista explícita** (con `dryRun` por defecto), y ofrecer a la página de ajustes un resumen de «cuánto disco ocupa en total».

### Interfaz pública (exporta `{analyze, prune, summary, walk, dirSize}`)

| Exportación | Firma | Descripción |
|---|---|---|
| `walk` | `(dir, out=[], depth=0) => [{path,size}]` | Lista recursiva de archivos, **profundidad máxima 6** (15-27) |
| `dirSize` | `(dir) => bytes` | 29 |
| `analyze` | `(root, {keepAvd='apkstart.avd', aggressive=false, keepSnapshots=false}) => {total,groups,candidates}` | 36-127 |
| `prune` | `(root, {apply=false, keepAvd, aggressive, keepSnapshots, onRemove}) => {…analyze, apply, removed, saved, after}` | 133-152 |
| `summary` | `(root) => {total,totalText,runtimeText,groups,reclaimable,reclaimableText,count}` | 155-184 |

Cada elemento de `candidates[]`: `{path, size, reason, kind:'file'|'dir'}`.

### Implementación clave

**1) Las 8 categorías de reciclado de `analyze()` (en el orden del código)**

| # | Líneas | Objetivo | reason |
|---|---|---|---|
| 0 | 48-51 | `emulator/`, `system-images/`, `avd/`, `platform-tools/` | Solo agrupan por tamaño (`groups`), no se borran |
| 1 | 53-61 | `emulator/qemu/windows-x86_64/qemu-system-{aarch64,armel,i386}*` | Objetivos QEMU que no son x86_64 |
| 2 | 63-68 | `system-images/**/{NOTICE.txt,source.properties}` y >1 MB | Archivos de texto grandes dentro del paquete de imagen |
| 3 | 70-77 | `system-images/android-30` (solo si existe el `system.img` de la API34 play), `<root>/x86_64` | Imágenes antiguas / directorios mal extraídos |
| 4 | 79-86 | `avd/*.avd` con `name !== keepAvd` | AVD inactivos (con 8-16 GB de datos de usuario) |
| 5 | 87-90 | `avd/**/*.lock` | Archivos de bloqueo residuales de una salida anómala |
| 6 | 91-100 | `avd/<keepAvd>/snapshots` o `snapshots.stale-N` (cuando `keepSnapshots=false`) | Instantáneas quickboot antiguas |
| 7 | 103-110 | `<root>/_tmp`, `<root>/images` | Archivos temporales de descarga / restos antiguos de QEMU·ISO |
| 8 | 112-123 | Con `aggressive`, `emulator/crashreport.exe` | Específico de la construcción de paquetes de lanzamiento |

**2) Restricciones de seguridad de `prune()` (139-141)**
```js
const p = path.resolve(c.path), rootAbs = path.resolve(root);
if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;   // no salir de root, no borrar root
```
Con `apply=false` **no se toca ni un archivo** (142-149), solo se devuelve la lista; si falla un borrado (archivo ocupado) se omite en silencio y se limpiará la próxima vez (148).

**3) `summary()` (155-184)**: ejecuta `analyze` sobre la ejecución más 4 directorios adicionales (`avd`, `APK_DIR`, `ICON_DIR`, `logs`), filtra los grupos de 0 bytes y convierte a GB cuando se supera 1 GB.

### Puntos delicados e invariantes

- **La lista negra de `aggressive` es una restricción dura** (comentarios 112-114): `Qt6WebEngineCoreAndroidEmu.dll` es dependencia de carga de `qemu-system-x86_64.exe` y **nunca se puede borrar**; `qsn/netsim` se conserva por prudencia.
- **`keepAvd` está escrito a mano como `'apkstart.avd'`** y debe coincidir con `AVD_NAME` de `emulator.js`; si se cambia, hay que sincronizar los dos sitios.
- **Con la ejecución en marcha hay que pasar `keepSnapshots:true`**: `engine.cleanup()` pasa `keepSnapshots: this.vmRunning` (`engine.js:1019-1023`); si no, borrar la instantánea de la sesión actual daña la máquina en funcionamiento.
- La profundidad 6 de `walk` evita bucles por enlaces simbólicos/directorios muy profundos que desbordan la pila; los archivos a más de 6 niveles no cuentan en el tamaño (se subestima).
- Los `candidates` de `analyze` **no incluyen** «los userdata/instantáneas del AVD activo (cuando `keepSnapshots=true`)»: esa es la garantía de que «las aplicaciones instaladas no se borran» (auto-test:174 lo asevera).
- El `after` de `prune` es solo `total - saved`, no vuelve a escanear, así que si un borrado falla de verdad difiere ligeramente de la realidad.

### Quién lo llama
- `src/core/engine.js:1017` (`usage()` → `summary`), `:1019-1023` (`cleanup()` → `prune`).
- `src/main.js:1004` (`runtime:usage` → `runtime.usage()` → `summary`), `:1056-1071` (`runtime:cleanup`: primero `apply:false` para obtener la lista → `dialog.showMessageBox` de confirmación → `apply:true`).
- `src/ui/app.js` (panel «Uso/Limpieza» de los ajustes, a través de `runtime:usage`/`runtime:cleanup`).
- `test/auto-test.js:25,157,167,171`.

### Cobertura de pruebas
- ✓ `auto-test.js:139` inventario de elementos reciclables: QEMU no x86_64, imágenes antiguas, AVD antiguos, archivos de bloqueo, instantáneas antiguas (incluye que dryRun no borra y que tras `apply` se conservan el AVD activo y el QEMU x86_64)
- **Sin cubrir**: los 4 directorios adicionales de `summary()`, la rama `aggressive` y el límite de profundidad.

---

## 7. Cuatro utilidades pequeñas

### 7.1 `src/core/logfile.js` — rotación de logs por tamaño

| Exportación | Firma | Descripción |
|---|---|---|
| `rotate` | `(file, limitKB) => bool` | 15-26: si `size < limit` devuelve false; si no, borra el `.1.log` anterior → renombra a `.1.log` |
| `append` | `(file, line, limitKB=2048) => bool` | 33-45: **en el primer uso de cada proceso y cada 200 líneas** se hace una rotación (39); `appendFileSync` añade el salto de línea |
| `trimNow` | `(file, limitKB=2048) => bool` | 48-50: comprobación única e incondicional al arrancar |

- Responsabilidad: las adiciones prolongadas a `app.log` / `emulator.log` llenarían el disco (cabecera 2-9); se conserva **una sola** copia `.1.log`.
- Puntos delicados: `limitKB` se limita con `Math.max(256, ...)` a ≥256 KB (39, 49); `counters` es un `Map` de nivel de módulo, que vuelve a cero al reiniciar el proceso; `rotate` usa `renameSync`, que en Windows falla si el archivo está ocupado y devuelve false (en silencio).
- Quién lo llama: `src/main.js:85` (`appLog`, `logs/app.log`), `src/core/emulator.js:577` (log del emulador).
- Pruebas: ✓ `auto-test.js:1404` el log rota automáticamente al superar el límite y conserva una sola copia.

### 7.2 `src/core/notify.js` — notificaciones de Android → notificaciones de Windows

| Exportación | Firma | Descripción |
|---|---|---|
| `parseRecords` | `(texto de dumpsys) => [{pkg,key,title,text}]` | 34-63 |
| `NotifyBridge` | `new NotifyBridge({getClient,getAppLabel,getAppIcon,onOpen})` | `start()/stop()`; internamente `setInterval(_tick, POLL_MS=2500)` (11, 77-89) |

Implementación clave:
- Cada 2,5 s, `client.shell('dumpsys notification --noredact', {timeout:12000})` (97), **primero `isOnline()`** (96);
- Filtros: lista blanca `SYSTEM_PKGS` + `com.android.providers.*` + `launcher` (18-32); se omiten `FLAG_ONGOING_EVENT(0x2)` y `FLAG_FOREGROUND_SERVICE(0x40)` (43-45);
- El primer `_tick` solo establece la línea base `primed`, para no disparar de golpe todas las notificaciones históricas al arrancar (99-104); `seen` se recorta de 500 a 300 entradas (113);
- Al hacer clic, `note.on('click')` → `onOpen(pkg)` (130);
- `require('electron')` en el nivel superior del módulo (9) → **las pruebas con Node puro no pueden ejecutarlo**, por eso `test/notify-test.js` se ejecuta con electron.

Quién lo llama: `src/main.js:36,682-697` (`startNotifier()`, solo se inicia con `onContainerActive(true)` cuando el contenedor tiene ventanas de apps, `:670-678` llama a `stop()` al cerrarse; `:1772` para al salir).
Pruebas: `test/notify-test.js` (usa un dump real `test/notif.txt` para probar `parseRecords`, **fuera de `npm test`**); el cuerpo de `NotifyBridge` no tiene cobertura.

### 7.3 `src/core/android.js` — interruptores de ajustes de Android (sin entrar en el escritorio)

| Exportación | Descripción |
|---|---|
| `ACTIONS` | 11 constantes de action `android.settings.*` (7-19) |
| `AndroidSettings` | `new AndroidSettings(runtime)`; métodos `status()`, `setWifi`, `setAirplane`, `setVolume`, `setAnimations`, `setFontScale`, `setDensity`, `tune({pkg})`, `open(action)`, `permissions(pkg)`, `grantAll(pkg)` |

Implementación clave:
- `client()` hace `await runtime.ensure()` en cada llamada (24-28) y lanza «la ejecución no está lista» si falla;
- `_sh(commands)` une varias órdenes con `; ` en **una sola** `adb shell` (30-34), con 20 s de tiempo de espera;
- `status()` obtiene 7 valores de una vez con `echo "k=$(...)"` y los analiza con regex (37-61);
- `tune()`: desactiva las tres animaciones + `max_cached_processes=32` + opcionalmente `deviceidle whitelist +pkg` (111-121);
- `permissions()` analiza el bloque `runtime permissions:` de `dumpsys package` y se detiene por la indentación (131-145); `grantAll()` hace `pm grant` uno por uno e ignora los fallos (147-156);
- Rangos: `fontScale 0.85~1.3`, `density 120~640`, `volume 0~100` (79-108).

Quién lo llama: `src/main.js:1501` (`androidSet = new AndroidSettings(runtime)`), `:1404-1434` (IPC `android:status/set/open/tune/permissions/grantAll`); `src/preload.js` lo expone a la página de ajustes.
Pruebas: **✗ sin cobertura** (requiere adb real).

### 7.4 `src/core/display.js` — cálculo puro de adaptación de pantalla

| Exportación | Firma | Descripción |
|---|---|---|
| `densityFor` | `(w,h,manual) => dpi` | Si `manual>0`, limita a 120~640; si no, `min(w,h)/2.57` limitado a 200~480 (7-10) |
| `portraitSize` | `(str) => {w,h}` | Analiza `900x1600`; si es inválido/horizontal vuelve a `{900,1600}` (12-18) |
| `defaultBounds` | `(area) => {x,y,w,h}` | Altura `area.h*0.84`, ancho 9:16, centrado (20-28) |
| `fullscreenBounds` | `(portrait, area) => {x,y,w,h}` | Llena la altura, calcula el ancho según la proporción vertical y centra horizontalmente (36-46) |
| `sizeFor` | `(mode, portrait, area) => {w,h}` | **Los dos modos devuelven la preconfiguración vertical** (55-57) |

Invariante clave (escrito en los comentarios): la relación de aspecto de la ventana del emulador **queda fijada por la LCD al arrancar**, así que un `SW_MAXIMIZE` directo solo da una ventana pegada a la izquierda y con el mismo ancho; por eso «pantalla completa» = maximizar la ventana **sin cambiar la resolución de Android** (48-54), y cambiar de modo no requiere reiniciar la ejecución.

Quién lo llama: `src/main.js:32` (require), `:274-277` (`portraitSize()` lee `display.portrait`) — **solo `portraitSize` se usa en el código de ejecución**; `densityFor/defaultBounds/fullscreenBounds/sizeFor` hoy solo los llaman las pruebas (`appwin.js:46` tiene su propia copia de `AppWindow.sizeFor`).
Pruebas: ✓ `auto-test.js:465` adaptación de pantalla: ventana y pantalla completa comparten la resolución vertical; la proporción 9:16 de la ventana se puede estirar (cubre 4 funciones).

---

## 8. Cadena total de descarga / despliegue / actualización

### 8.1 Diagrama de flujo en texto

```
【El usuario pulsa «Completar en un clic»】
src/ui/app.js:371  deployAll()
   ├─ setStepBusy('all',true)  → texto del botón «Preparando…» (app.js:334)
   ├─ api.autoDeploy()         → preload.js:45  invoke('runtime:autoDeploy')
   └─ IPC runtime:autoDeploy   → main.js:870
        └─ autoDeploy()        → main.js:314  (con bloqueo de exclusión deploying, main.js:313/315)

【Flujo principal de autoDeploy main.js:314-354】
 1. env = provisioner.checkEnv()                           main.js:319
 2. needEngine = !env.emulator.ok || !env.sysimg.ok        main.js:320
 3. if needEngine && settings.runtime.preferGithubRuntime:
      installRuntimePack(progress)                          provision.js:522
        ├─ resolveRuntimePack()                             provision.js:476
        │    ├─ ¿Hay runtimePackUrl personalizada? Se usa directamente   :477
        │    ├─ GET concurrente a GitHub / Gitee releases?per_page=15    :487
        │    └─ Buscar assets /^ApkBuddyStart-runtime-.*\.zip$/, cmpVer toma el más alto :497-515
        ├─ guardDisk('runtime', root)   [512+1024=1536MB]    :525 → :262
        ├─ sources.rank(sources.candidates(url))  medición secuencial   :534-536 → sources.js:399
        ├─ downloadMulti(urls, _tmp/runtime-pack.zip)        :541 → download.js:338
        │    ├─ Sondeo Range concurrente → solo se mezclan fuentes con «el mismo tamaño total» download.js:355-381
        │    ├─ 8 hilos de fragmentos repartidos por turno + archivo auxiliar .chunks.json  download.js:391-416
        │    └─ Perro guardián de inactividad 20 s / velocidad baja 45 s y <120KB/s → cambio de fuente  download.js:449-503
        ├─ Compuerta de tamaño <200MB → lanza «paquete completo incompleto»  :556
        ├─ extractZip(zip, root)   >64MB usa ZipFile por flujo     :559 → :591
        ├─ Escribe <root>/.runtime-pack.json y borra el zip        :566-571
        └─ materializeImages()  .img.xz/.gz → .img              :573-576 → :722
      afterPack = checkEnv()                                 main.js:328
      if emulator.ok && sysimg.ok → return {ok:true,source:'github'}
      else → sigue con la fuente oficial para completar (main.js:330)
 4. Respaldo componente a componente con la fuente oficial (solo si el paso anterior falló/no está completo):
      installAdb()          provision.js:428  → downloadAny  platform-tools.zip
      installEmulator()     provision.js:905  → downloadAnyParallel + extractZip + ensurePlatformTools
      installSystemImage()  provision.js:966  → installPlayImage(:1004) → downloadAnyParallel + extractZip
 5. after = checkEnv(); ok = adb.ok && emulator.ok && sysimg.ok   main.js:347-348
 6. finally deploying=false                                 main.js:351-353

【La UI arranca a continuación app.js:381-387】
 api.runtimeStart() → main.js:880 → runtime.ensure()        engine.js:787 en adelante
   ├─ provisioner.materializeImages(onLog).catch(()=>{})     engine.js:848
   ├─ checkEnv()                                             engine.js:849
   ├─ killOrphanEmulators()                                  engine.js:856
   └─ boot()  si falla, diagnóstico de doctor + reintento de variantes (GPU/accel/memoria degradando por niveles)

【Dos cadenas en segundo plano tras el arranque】
 A. Despliegue automático (retraso 20 s) main.js:1657-1661 → autoDeploy()   ← la misma función que usa la UI
 B. Comprobación de actualizaciones (retraso 8 s solo si está empaquetado) main.js:1665-1676
      updater.check()                     updater.js:73
        └─ sources.latest({force})        sources.js:277
             ├─ fetchReleases() GitHub/Gitee en paralelo       :237
             ├─ 403/429 → cortocircuito 15 min                :286-290
             ├─ Todo falla → último resultado + stale          :292-298
             └─ Combinar assets de la misma versión (urls[] + sizes{}), conservar parts :304-348
      info.hasUpdate → notificación + send('update:state')

【El usuario pulsa «Actualizar ahora»】
 main.js:579 runUpdate()  (bloqueo de exclusión updateBusy)
   ├─ updater.prepare(info)                              updater.js:121
   │    ├─ ¿parts?  _downloadParts()  cada fragmento mide su velocidad, descarga y se une en orden :182
   │    └─ si no     candidates→rank→downloadMulti        :140-163
   │    └─ .zip → _extract a update/<ver>/payload         :166-173
   ├─ updater.apply(job)                                  updater.js:258
   │    ├─ Genera el script PS (Wait-Process 90 s → copiar/instalar en silencio → reiniciar → limpiar → exit 0)
   │    ├─ Lo escribe en update/apply.log.ps1 (diagnóstico) :310
   │    └─ spawn powershell -EncodedCommand (**no detached**) + unref  :319-323
   └─ setTimeout(900ms) → quitting=true; app.quit()        main.js:596
        └─ El script espera a que el proceso salga → sobrescribe el directorio de instalación → Start-Process exe → borra update/<ver>
```

Números de tiempo clave (son constantes únicas; no las bajes a la ligera al hacerte cargo):
- `autoDeploy` con un retraso de **20 s** (`main.js:1661`; comentario: el disco/CPU ya están saturados en el arranque en frío);
- comprobación de actualizaciones con un retraso de **8 s** y solo si `app.isPackaged` (`main.js:1665-1675`);
- en `apply`: `Wait-Process -Timeout 90`, copia **12 rondas ×600 ms**, limpieza 400 ms tras el reinicio (`updater.js:271-306`);
- **900 ms** después de que `apply` devuelva el control, la aplicación sale (`main.js:596`);
- `downloadMulti`: inactividad de fragmento **20 s**, umbral de velocidad baja **45 s + 120 KB/s**, **6** reintentos por fragmento y máximo **2** cambios de fuente;
- `download` (flujo único): inactividad **30 s**, **2** reintentos ×1,5 s para respuestas que no son 2xx.

### 8.2 Los eslabones más propensos a fallar de esta cadena

| # | Síntoma (vista del usuario) | Ubicación en el código | Mecanismo / observación |
|---|---|---|---|
| 1 | **«Se queda en preparando la ejecución»**, la barra de progreso parada mucho rato en 1~3 % | `provision.js:531` (`percent:1` fijo) + `sources.js:412-417` (medición **secuencial**, ≤9 s por dirección) + `sources.js:52` (256 KB por medición) | 4 candidatos (directo + 2 espejos + Gitee) significan más de 30 s «sin ningún progreso de bytes». Cuanto peor sea la red, más candidatos y más parece un bloqueo |
| 2 | El progreso **se para en el 99 % mucho rato** y luego salta a «usar la fuente oficial para completar» | `provision.js:575-576` (`materializeImages(...).catch(()=>0)`) + `:790` (un fallo de imagen solo llama a onLog) | El fallo al desplegar `.xz` se traga en dos capas de catch → `checkEnv().sysimg.ok=false` → `autoDeploy` sigue por `main.js:330` y baja otro paquete de 1,4 GB; en el próximo arranque lo volverá a intentar |
| 3 | Errores raros relacionados con `@napi-rs/lzma` | `provision.js:771-781` (`require.resolve('@napi-rs/lzma')` y luego require de `index.js` por ruta de archivo) | Si al empaquetar no se incluyó el binario de lzma o quedó comprimido en asar → `Cannot find module`; el comentario explica por qué no se puede hacer `require('@napi-rs/lzma')` directamente (polyfill ESM) |
| 4 | **«Configuré el directorio de ejecución pero sigue descargando en AppData»** | `provision.js:217-224` (tres ramas de `sysImgRoot`), `:726` (destino de `materializeImages`), `:237` (`avdHome`), `store.js:67-98` (`runtime.dir` vacío por defecto), `main.js:97-171` (`bootstrapBundledRuntime` **sobrescribe** `runtime.dir`) | ① El usuario antiguo ya tiene `<DATA_DIR>/system-images` → la rama 2 sigue usándolo y no se mueve; ② cuando la versión portátil lleva `runtime/` junto al exe, `bootstrapBundledRuntime` hace directamente `saveSettings({runtime:{dir: bundled}})` en `main.js:165-168` y sobrescribe el directorio elegido por el usuario (solo respeta la configuración anterior si `sameTree && emulator.exe existe`, `:144-148`); ③ el AVD tiene su propio ajuste `avdDir`, que puede estar en otra unidad distinta de la ejecución |
| 5 | El disco está claro pero dice «espacio insuficiente», o al revés, falla la extracción a mitad | `provision.js:262-277` (la tabla `need` de 264-265 no tiene `'runtime'`), `main.js:940` (umbral de autocomprobación 8192 MB) | `guardDisk('runtime')` solo estima 1536 MB, mientras que paquete + despliegue requieren ~5 GB; pasar la guarda no garantiza no llenar el disco |
| 6 | El progreso **se queda clavado en el 95 %** (issue histórico) | Ya hay contramedidas: `download.js:446-451,492-503` (cambio de fuente por velocidad baja) y `:466-480` (finalización garantizada); la ruta de flujo único solo tiene `idleMs=30s` (`:112`) | Bloques finales de una fuente lenta; el archivo auxiliar (`.chunks.json`) garantiza que el reintento solo rellene los fragmentos que faltan, sin volver a bajar todo |
| 7 | Toda la descarga se anula tras un «corte / estancamiento de conexión» | `download.js:155` (`close` y `!complete` → reject) y `:526-528` (fragmento agota reintentos → lanza + guarda auxiliar) | Por diseño se puede reanudar; pero `downloadParallel` degrada a flujo único al ver un archivo a medias (`:188-191`) y el paralelismo se reduce a un hilo |
| 8 | La actualización se queda en «reemplazando el programa y reiniciando» | `updater.js:315-323` (comentario de compatibilidad: **no se puede detached**), `:271` (Wait-Process 90 s), `:280-285` (copia 12 rondas) | El software de seguridad bloquea los «procesos separados» → el script no se ejecuta; o la desinstalación/instalación es frenada por UAC; `update/update.log` es la única pista |
| 9 | Tras actualizar aparece un archivo raro de 1,5 GB en el directorio del programa | `updater.js:80` (respaldo portátil `/\.zip$/i`) | Si una versión solo trae `ApkBuddyStart-runtime-vX.zip` y no hay asset `portable`, se toma por paquete de actualización y se extrae dentro del directorio de instalación |
| 10 | En Gitee «hay una versión sin paquete de instalación» | `.github/workflows/release.yml:36-44,78-100` (compuerta de 100 MiB + fallo directo si falta `GITEE_TOKEN`); en el consumidor, `sources.js:172-204` y `updater.js:182-227` | Es un problema de compilación, pero el síntoma aparece aquí; los fragmentos deben ser `part1..N` consecutivos o se descarta todo el grupo (`sources.js:196-203`) |
| 11 | Tras cambiar de fuente o de prefijo de espejo se sigue usando la dirección antigua | `main.js:819-825` solo hace `sources.reset()`; los `_cache.*` de `provision.js:479,514,642,664,984` no tienen punto de invalidación | Hay que reiniciar el proceso para que surta efecto por completo |
| 12 | El sondeo de estado dispara la CPU/los procesos | `provision.js:687-714` (`emulatorVersion` no cachea los fallos), `:298-315` (adb con caché de 30 s), `:845-902` (accel con 30 s + caché en disco de 6 h/10 min) | Cuando no está instalado el emulator, cada `checkEnv` vuelve a ejecutar `execFile` sondeando varias rutas |
| 13 | El AVD se considera «ya en uso» y no arranca | `layers.js:87-90` (lista de archivos de bloqueo), `main.js:963-969` (autocomprobación detecta `.lock`), `engine.js:856` (`killOrphanEmulators`) | Quedan `*.lock` de una salida anómala; el panel de limpieza puede reciclarlos |
| 14 | En el primer arranque se pierden «las aplicaciones/datos ya instalados» | `store.js:179-184` (tres migraciones forzadas), `engine.js:848` (`materializeImages`), `doctor.snapshotKey`/`imageIdentity` (huella de la instantánea, `auto-test.js:88,98`) | La migración es unidireccional; la huella de la instantánea **no incluye el tamaño de la partición de datos** (`auto-test:1395`), así que ampliarla no borra los datos |
