# Recorrido del código de la pila de análisis sin conexión de ApkBuddyStart (WIP)

> Público objetivo: ingenieros que vayan a hacerse cargo del proyecto y continuar la cadena «APK → icono → acceso directo».
> Forma de lectura: solo se leyó código + grep de puntos de llamada; no se ejecutó ningún orden que cambie el estado.
> Versión de referencia: `package.json` version `0.3.5` (electron ^33.4.11, node >=20).
> Todas las referencias `archivo:línea` corresponden a la instantánea actual del espacio de trabajo; actualízalas si haces cambios.

Archivos analizados (`src/core/*.js`, 29 en total; aquí solo se cubre el grupo de análisis/iconos/asociación/versión/logs):

| Archivo | Líneas | Descripción en una frase |
|---|---|---|
| `src/core/zip.js` | 236 | Lector ZIP que solo usa `zlib` (versión en memoria + versión por flujo con fd) |
| `src/core/axml.js` | 167 | Analizador de XML binario de AndroidManifest.xml |
| `src/core/arsc.js` | 233 | Analizador reducido de resources.arsc (restaura referencias `@0x7f`) |
| `src/core/png.js` | 132 | Codificador PNG sin dependencias + icono de marca dibujado por programa |
| `src/core/apk.js` | 190 | Punto de entrada total de metadatos de APK: `parseApk()` |
| `src/core/shortcut.js` | 183 | Generación de ICO multitudamaño + escritura de .lnk |
| `src/core/assoc.js` | 68 | Asociación de archivos .apk bajo HKCU |
| `src/core/version.js` | 36 | Comparación de números de versión (módulo separado para evitar dependencias circulares) |
| `src/core/logfile.js` | 52 | Escritura por adición + rotación por tamaño (módulo pequeño de logs/utilidades) |
| `src/core/display.js` | 59 | Cálculo puro de adaptación de pantalla (adjunto: también es un módulo «de utilidad pura») |

---

## 1. `src/core/zip.js`

### Responsabilidades
Lector ZIP mínimo implementado con el `zlib` integrado de Node: solo analiza el directorio central y descomprime una entrada concreta bajo demanda; además hay una versión por flujo basada en descriptores de archivo, pensada específicamente para imágenes del sistema de nivel GB.

### Interfaz pública
```js
const { ZipArchive, ZipFile } = require('./zip');

new ZipArchive(buffer /*: Buffer, paquete completo */)
  .entries        // Map<string, {name, flags, method, compSize, uncompSize, localOffset}>  ← campo público, se lee directamente desde fuera
  .has(name)      // → boolean
  .names()        // → string[]
  .find(re)       // (RegExp) → string[] (nombres de entradas coincidentes)
  .read(name)     // → Buffer | null (null si la entrada no existe; lanza error si la cabecera local está dañada o el método de compresión no es compatible)
  .pipeTo(name, dest /*: Writable */)  // → Promise<number> (resuelve con el tamaño sin comprimir, para verificar los bytes escritos)

new ZipFile(filePath /*: string */)
  .size           // número de bytes del archivo
  .entries        // igual que arriba
  .has / .names / .find          // igual que arriba
  .close()        // idempotente; pone el fd a null
  .read(name)     // → Buffer (lanza error si no existe, no devuelve null: ¡incoherente con ZipArchive!)
  .pipeTo(name, dest)  // → Promise<number>
```
> Ojo: la interfaz es asimétrica: `ZipArchive.read` devuelve `null` si falta la entrada, mientras que `ZipFile.read` lanza el error «la entrada no existe`. En `apk.js`, el resultado de `zip.read(...)` se comprueba con `if (data && ...)` precisamente por el primero.

### Implementación interna clave

**ZipArchive — lee el paquete completo en memoria (no por flujo)**
- El constructor consume directamente el `Buffer` que le pasa quien lo llama (`zip.js:14`) y no toca el disco. Por tanto, «leer o no el paquete entero en memoria» depende del llamador: `apk.js:78` usa `fs.readFileSync` y `installer.js:27` también → **la ruta de análisis de APK residente en memoria al 100 %**.
- `_parse()` (`zip.js:20`): explora hacia atrás desde `buf.length-22` buscando `EOCD_SIG`, con límite inferior `buf.length - 65557` (`zip.js:23`, = EOCD de 22 bytes + comentario máximo de 65535 bytes). Al encontrarlo, `total` se toma de `+10` (u16) y el desplazamiento del directorio central de `+16` (u32).
- Bucle del directorio central (`zip.js:32-47`): avanza en pasos de 46 + nameLen + extraLen + commentLen; los desplazamientos de campo 8/10/20/24/28/30/32/42 coinciden con la especificación PKZIP; los nombres siempre se decodifican como UTF-8 (`zip.js:42`), **sin tratar el bit 11 de los GP flags**.
- `read()` (`zip.js:54`): valida primero la firma de la cabecera local de archivo `LOC_SIG` y después calcula el inicio de los datos con los nameLen/extraLen de la **cabecera local** (`zip.js:61-63`; no se pueden usar las longitudes del directorio central, pueden diferir); `method 0` devuelve `Buffer.from(raw)` (**hace una copia**, `zip.js:65`); `method 8` usa `zlib.inflateRawSync` (`zip.js:66`).
- `pipeTo()` (`zip.js:80`): divide `raw` en trozos de 1 MB y los alimenta a `createInflateRaw`; cuando `write()` devuelve false, continúa con `once('drain')` (`zip.js:105-116`); `dest.on('finish')` y `dest.on('error')` comparten `done`, y al terminar resuelve con `e.uncompSize` (el llamador puede usarlo para verificar el número de bytes). **Ojo: los datos ya están en memoria; el troceado solo evita que zlib trague GB de una vez, no ahorra memoria.**

**ZipFile — fd + ventana del final del archivo**
- Construcción: `fs.openSync(path,'r')` + `statSync` (`zip.js:134-135`); si `_parse()` falla, se llama automáticamente a `close()` antes de lanzar (`zip.js:137`, para evitar fugas de fd).
- Solo lee los últimos `min(size, 22 + 65557 + 4096)` bytes (`zip.js:152`, como máximo 69675 B) para buscar el EOCD; si el directorio central no está en esa ventana (comentario muy largo, etc.), hace una lectura aparte `readAt(cdOffset, min(eocdAbs-cdOffset, 64MB))` (`zip.js:166-172`).
- `_readAt` (`zip.js:145`): `Buffer.alloc(len)` + **una sola** `fs.readSync`. POSIX permite lecturas cortas y aquí no hay bucle de reintento → en teoría un directorio central de 64 MB podría truncarse en silencio (en archivos locales de Windows normalmente no ocurre; ten cuidado con unidades de red/virtuales).
- `read()` (`zip.js:206`) lee toda la entrada `compSize` en memoria antes de inflarla: **las entradas grandes siguen chocando con el límite de 2 GB**. `pipeTo()` (`zip.js:214`) sí es por flujo: `createReadStream(null,{fd, autoClose:false, start, end})`, donde `end` es un **intervalo cerrado** (`zip.js:203` ya es `start+compSize-1`).
- `_range()` (`zip.js:195`) lee 30 bytes de la cabecera local en cada acceso para verificar la firma y devuelve `{e,start,end}`.

**¿En qué líneas está exactamente el límite de 2 GB?**
| Ubicación | Significado |
|---|---|
| `zip.js:75-79` (comentario) | Documenta explícitamente que «las entradas de nivel GB no se pueden inflar de una vez y chocan con el límite de un único Buffer de 2 GB de Node»; esta es la razón de ser de `pipeTo` |
| `zip.js:37` / `zip.js:180` | `uncompSize` y `compSize` se leen con `readUInt32LE` → **no hay Zip64**; las entradas >4 GiB dan valores truncados/alias |
| `zip.js:29-30` / `161-162` | `total` es u16 (deja de ser válido con más de 65535 entradas) y `cdOffset` es u32 (bajo Zip64 vale `0xffffffff` y cae en la rama de «desplazamiento anómalo» de `zip.js:166`, que lanza error) |
| `zip.js:208` | `ZipFile.read()` asigna un Buffer para toda la entrada `compSize` → una sola entrada >2 GB lanza directamente `ERR_BUFFER_TOO_LARGE` |
| `apk.js:78` | `readFileSync` lee el paquete entero → un APK >2 GB (o >`buffer.constants.MAX_LENGTH`) falla ya en la fase de lectura y ni siquiera llega a la capa zip |

### Puntos delicados e invariantes
1. **Los nameLen/extraLen de la cabecera local y del directorio central hay que leerlos por separado** (`zip.js:61-63`, `198-202`). Pueden diferir (especialmente con data descriptor o relleno de alineación); usar los valores del directorio central para calcular el inicio de los datos locales es la forma más habitual de romper esto.
2. **El data descriptor (GP bit 3) no necesita tratamiento especial**: como el tamaño comprimido se toma del directorio central (`zip.js:36/179`), da igual que los tres campos de la cabecera local estén a 0. Esto es más robusto que muchos analizadores ZIP por flujo.
3. **No se comprueba el bit de cifrado**: `flags` solo se guarda (`zip.js:34`) y nunca se evalúa el bit 0; una entrada cifrada dará un error de «fallo al inflar» que no apunta a la causa real.
4. **Un directorio central truncado hace que falten entradas en silencio**: el `break` de `zip.js:176` sale directamente si `off+46 > cd.length` o la firma no cuadra, sin lanzar error. El síntoma es «el APK tiene lib/ pero las abis salen vacías».
5. `ZipArchive.entries` es un `Map` público; `apk.js:31`, `apk.js:44` y `provision.js:608` leen directamente `entries.get(name)` para obtener `uncompSize`, así que cambiar la estructura de datos afecta a tres sitios.
6. El `dest` de `pipeTo` debe ser un flujo de escritura creado por el llamador (`provision.js:611` y `updater.js:239` usan `fs.createWriteStream`); la función no cierra `dest`, solo espera a `finish`.
7. `ZipFile` hay que cerrarlo con `close()` al terminar (`provision.js:619` usa `finally`; `updater.js:249` también), o se fuga el fd.
8. Los nombres se decodifican siempre como `utf8`; los ZIP antiguos con nombres GBK salen corruptos, pero en el escenario APK las rutas son ASCII y no tiene impacto real.

### Quién lo llama
`ZipArchive`:
- `src/core/apk.js:8` (require), `apk.js:79` (ruta principal de `parseApk`)
- `src/core/installer.js:12`, `installer.js:27` (`parseBundle`, divide .apks/.xapk)
- `src/core/provision.js:15`, `provision.js:595` (paquetes pequeños usan la versión en memoria)
- `test/run-tests.js:29`, `57`; `test/run-tests.js:119`, `124` (fixtures reales)
- `test/engine-test.js:167`, `194`
- `test/auto-test.js:277`, `319`

`ZipFile`:
- `src/core/provision.js:15`, `595` (>64 MB usa la versión por archivo)
- `src/core/updater.js:21`, `230` (`_extract`, extracción del paquete de actualización)
- `test/auto-test.js:277`, `320` (comparación de coherencia con `ZipArchive`)

`pipeTo`:
- `src/core/provision.js:611`, `src/core/updater.js:239`, `src/core/zip.js:80` (él mismo)

### Cobertura de pruebas
- `test/run-tests.js:30` «puede analizar la estructura comprimida del package.json de su propio proyecto»: el nombre engaña; en realidad construye a mano un zip mínimo stored (`run-tests.js:32-57`) y solo cubre `has` + `read`.
- `test/engine-test.js:166` «la descompresión ZIP integrada funciona»: cubre indirectamente `ZipArchive` + `pipeTo` a través de `Provisioner.extractZip` (`provision.js:591`).
- `test/auto-test.js:275` «ZipFile y ZipArchive dan el mismo resultado para el mismo paquete (incluye deflate y pipeTo por flujo)»: único caso que cubre a la vez stored/deflate, `read`/`pipeTo` y ambas clases; `auto-test.js:278-315` arma los bytes por su cuenta.
- **Huecos**: no hay casos de Zip64, ni de «directorio central truncado», ni de bit de cifrado, ni de `find()`; la ruta de entradas grandes de `ZipFile.read()` no está cubierta.

---

## 2. `src/core/axml.js`

### Responsabilidades
Analizar el `AndroidManifest.xml` compilado dentro del APK (XML binario / AXML) y convertirlo en un árbol DOM normal, para que las capas superiores consulten por etiqueta/atributo.

### Interfaz pública
```js
const { parseAxml, attr, attrValue, children, ANDROID_NS, TYPE_REFERENCE } = require('./axml');

parseAxml(buffer /*: Buffer */)   // → node (la raíz es manifest; lanza error si no es AXML o si el manifiesto está vacío)
// node = { name: string, attrs: Attr[], children: node[], parent: node|null }
// Attr = {
//   ns: string,        // '' significa sin namespace (nsIdx = 0xffffffff)
//   prefix: string,    // mantenido por los eventos start/end de namespace; se toma el prefix «declarado por última vez»
//   name: string,      // nombre del atributo (string pool)
//   value: string|number|boolean|null,  // primero rawValue; si no, se interpreta según dataType
//   refId: number|null,   // solo tiene valor cuando dataType=TYPE_REFERENCE(0x01) (sin signo)
//   dataType: number,  // valor original de Res_value.dataType
//   typed: string|number|boolean|null,  // null si es reference; en los demás casos igual que value
// }

attr(node, name, ns = ANDROID_NS)   // → Attr | null; ns=null significa sin limitar el namespace
attrValue(node, name, ns = ANDROID_NS)  // → Attr.typed | null
children(node, name)                // → node[] (filtra por nombre de etiqueta, no recursivo)
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
TYPE_REFERENCE = 0x01
```

### Implementación interna clave

**`readStringPool(buf, start)` (`axml.js:26-62`)**
- Cabecera: `type@0`, `headerSize@2`, `chunkSize@4`, `count@8`, `flags@16`, `stringsStart@20`; `isUtf8 = flags & 0x100` (`axml.js:34`).
- La tabla de desplazamientos va justo después de la cabecera: `start + headerSize + i*4` (`axml.js:38`); la base de las cadenas es `start + stringsStart` (`axml.js:40`).
- El pool UTF-8 requiere leer **dos** longitudes de tamaño variable: primero la «longitud UTF-16» (1~2 bytes, `axml.js:47-48`) y después la «longitud en bytes UTF-8» (`axml.js:50-51`); el slice usa **la segunda**. En el pool UTF-16 la longitud son 1~2 u16 y la unidad es code unit (slice `len*2`, `axml.js:58`).
- Devuelve `{ strings, chunkSize }`; el llamador solo toma `strings` (`axml.js:88`).

**`parseAxml(buffer)` (`axml.js:67-150`)**
- Valida la cabecera `RES_XML_TYPE(0x0003)` (`axml.js:69`), `pos = readUInt16LE(2)` (headerSize) y `total = readUInt32LE(4)` (`axml.js:72-73`).
- Bucle de chunks `while (pos + 8 <= total && pos < buf.length)` (`axml.js:81`); lee `type/headerSize/chunkSize` y si `chunkSize <= 0` hace `break` directo para evitar bucles infinitos (`axml.js:85`).
- Namespaces: `nsStack` guarda las uris y `prefixByUri` registra uri→prefix (`axml.js:76-77`); en START se hace push + set a la vez y en END solo pop (`axml.js:89-97`). **Si una misma uri se declara varias veces, el prefix «gana el último»**; `prefixByUri` nunca se limpia.
- START_ELEMENT (`axml.js:98`):
  ```js
  nameIdx   = readUInt32LE(pos + 20)
  attrStart = readUInt16LE(pos + 24)   // desplazamiento relativo a ResXMLTree_attrExt
  attrSize  = readUInt16LE(pos + 26)   // tamaño de un atributo, normalmente 20
  attrCount = readUInt16LE(pos + 28)
  const attrBase = pos + 16 + attrStart;   // ★ axml.js:106
  ```
- Cada atributo ocupa 20 bytes: `ns@0`, `name@4`, `rawValue@8`, `value.size@12`, `value.res0@14`, `value.dataType@15`, `value.data@16` (`axml.js:109-113`).
- Orden de obtención del valor: **si existe rawValue, se usa la cadena del pool** (`axml.js:120-121`) → si no, `TYPE_STRING` toma `data` como índice del pool (`122-123`) → `TYPE_REFERENCE` solo guarda `refId` (`124-126`) → boolean (`127-128`) → dec/hex (`129-130`, con `| 0` pasa a entero de 32 bits con signo).
- Construcción del árbol: el `parent` del nuevo nodo apunta a la cima de la pila, se mete en el padre y después entra él en la pila (`axml.js:104`, `139-140`); END_ELEMENT solo saca un nivel (`141-142`).
- Cierre: busca en `root.children` un nodo llamado `manifest` y, si no lo hay, toma el primero (`axml.js:147`); si no hay ninguno, lanza «el manifiesto APK está vacío» (`148`).

### Puntos delicados e invariantes

1. **La base de `attributeStart` (`axml.js:105-106`) es la línea más fácil de romper de todo el archivo.**
   La cabecera `ResXMLTree_node` mide 16 bytes (type 2 + headerSize 2 + chunkSize 4 + lineNumber 4 + comment 4); `ResXMLTree_attrExt` empieza en chunk+16, y `attributeStart` es **un desplazamiento relativo a attrExt** (valor normal 20 = sizeof del propio attrExt). Así que la fórmula correcta es `pos + 16 + attrStart`.
   Cambiarlo por `pos + attrStart` o `pos + headerSize + attrStart` no hace que se cierre, solo **descodifica en silencio nombres de atributo/namespaces desplazados**; en la interfaz se ve como: el nombre de la app retrocede al nombre del paquete, el icono usa una heurística de respaldo y `package` pasa a `undefined`. Actualmente **no hay ninguna aserción ni caso de bytes sintéticos** que lo proteja.

2. **El atributo `package` no tiene namespace**: `apk.js:88` necesita `attrValue(manifest,'package',null)` para obtenerlo; la rama `ns===null` de `attr()` (`axml.js:154`) existe precisamente para esto.

3. **Hay que intentar tanto `rawValue` como `dataType`**: en `android:label` y `android:name` suele ocurrir que `rawValue = 0xffffffff` y `dataType = 0x03`; leer solo raw da null. A la inversa, algunas cadenas de herramientas escriben raw sin tipo, así que el orden no se puede invertir.

4. **La diferencia entre `typed` y `value` es intencionada**: cuando existe `refId`, `typed = null` (`axml.js:136`), para asegurar que `attrValue()` no devuelva «el número de id de recurso» como si fuera una cadena. Toda la lógica superior (`apk.js:111`, `apk.js:141`) mira primero `refId` y después `typed`.

5. **`chunkSize < 8` no está protegido** (solo `<= 0`, `axml.js:85`); un AXML malformado podría, en teoría, girar en el sitio; en el escenario APK no ocurre, pero si algún día se analizan archivos arbitrarios subidos por el usuario habría que añadirlo.

6. **Los chunks no compatibles se omiten en silencio**: CDATA(0x0104) no tiene rama y se salta con `pos += chunkSize` (`axml.js:144`). `RES_XML_RESOURCE_MAP(0x0180)` también se omite: por eso los nombres de atributo se toman del string pool y no de los ids attr del resource map. Esto basta para el proyecto (se busca por nombre), pero **al cambiar de idioma o de recursos los nombres de atributo pueden confundirse con `a`/`b`** (ocurre en APK ofuscados/reforzados; ahí solo queda buscar por id en el resource map).

7. Solo se analiza el subárbol `manifest`; los nodos hermanos posteriores al END del namespace se ignoran.

### Quién lo llama
- `parseAxml`: `src/core/apk.js:9` (require), `apk.js:86` (manifiesto), `apk.js:54` (el XML de iconos adaptativos reutiliza el mismo analizador)
- `attr`: `src/core/apk.js:62` (`attr(node,'drawable')`)
- `attrValue`: `apk.js:18`, `19` (action/category del intent-filter), `88`, `91`, `92`, `96`, `97`, `124`, `125`
- `children`: `apk.js:16`, `19`, `95`, `99`, `121`
- `ANDROID_NS`: **solo se importa en `apk.js:9` y no se usa** (importación muerta); quien realmente lo usa es el parámetro por defecto de `attr()` (`axml.js:152`)
- Pruebas: `test/run-tests.js:80` (require), `run-tests.js:120`
- Ningún otro módulo lo consume directamente (`arsc.js` escribió por su cuenta otra copia del string pool)

### Cobertura de pruebas
- `test/run-tests.js:118` «el nodo raíz AXML es manifest»: **depende de un fixture real de APK** (`run-tests.js:86-100` busca `APKSTART_TEST_APK` / `test/fixtures/sample.apk` / `Documents/*.apk`); si no lo encuentra, se omite toda la sección (`run-tests.js:130-132`).
- No hay casos de bytes AXML sintéticos → en máquinas sin fixture (CI), `axml.js` tiene cobertura cero y errores de desplazamiento como `attributeStart` no se detectan.
- Las exportaciones `attr` / `attrValue` / `children` / `ANDROID_NS` / `TYPE_REFERENCE` no tienen pruebas unitarias directas.

---

## 3. `src/core/arsc.js`

### Responsabilidades
Analizador reducido de `resources.arsc`: restaura las referencias a recursos `@0x7f...` del manifiesto en cadenas de nombre de app y rutas de archivos de icono.

### Interfaz pública
```js
const { ResTable, TYPE_REFERENCE } = require('./arsc');

new ResTable(buffer /*: Buffer, todo el resources.arsc */)
  .globalStrings   // string[]: string pool de nivel de archivo (value.data es el índice aquí)
  .packages        // Array<{ id:number, typeStrings:string[], keyStrings:string[],
                   //         types: Map<number /*typeId*/, Array<{id, config, entries: Map<number, {dataType,data} >}>> }>
  .resolve(ref /*: number, 0xPPTTEEEE*/, prefer /*: 'string'|'file'|'any' = 'any' */, depth = 0)
                   // → string | number | boolean | null
TYPE_REFERENCE = 0x01   // se exporta pero no hay ningún consumidor externo en el proyecto
```

### Implementación interna clave

**Estructura de tres niveles (`arsc.js:9-15`)**
`ResTable`(0x0002) → `ResTable_package`(0x0200) → `ResTable_type`(0x0201). `RES_TABLE_TYPE_SPEC_TYPE`(0x0202) tiene constante pero nunca se trata.

**`readStringPool(buf,start)` (`arsc.js:23-46`)**
Es **copia y pega de la misma lógica** de `axml.js:26` (doble rama UTF-8/UTF-16, dos longitudes varint). Hay que mantener ambos sitios sincronizados.

**`_parse()` (`arsc.js:87-106`)**
- Valida `RES_TABLE_TYPE` (`89`), `total@+4` y `pkgCount@+8` (se lee pero solo se usa `pos<total` para controlar el bucle; `pkgCount` en realidad no sirve para contar).
- Solo el **primer** string pool se toma como `globalStrings` (condición `this.globalStrings.length === 0` en `99-100`), de modo que los pools dentro de paquetes posteriores no se confundan con el global.

**`_parsePackage(start,size)` (`arsc.js:108-139`)**
- Campos: `id@+8`, `typeStrings@+268`, `keyStrings@+276`, `headerSize@+2` (`111-113`): es el diseño fijo de `ResTable_package` (name[128] en UTF-16 ocupa de 12 a 268).
- La lectura de los dos string pools del paquete está dentro de `try/catch` (`117-120`); un fallo solo pierde los nombres de tipos/claves, **no afecta a `resolve`** (es tolerancia a fallos intencionada; el invariante está más abajo).
- Bucle de chunks hijos `while (pos + 8 <= end)`, solo trata `RES_TABLE_TYPE_TYPE` (`125-137`) y agrupa por `typeId` en un `Map<number, chunk[]>` (cada config con el mismo typeId ocupa una entrada).

**`_parseType(start)` (`arsc.js:141-179`)**
- Cabecera: `headerSize@+2`, `id@+8` (u8), `flags@+9` (u8), `entryCount@+12` (u32), `entriesStart@+16` (u32), `config@+20`.
- La tabla de desplazamientos empieza en `start + headerSize` y los datos de las entradas en `start + entriesStart` (`151-152`).
- Tres codificaciones:
  - `FLAG_SPARSE(0x01)`: 4 bytes por entrada `{idx:u16, offset:u16}`, **la unidad de offset son 4 bytes** (el `*4` de `157-158`)
  - `FLAG_OFFSET16(0x02)`: `offset:u16`, `0xffff` significa vacío, **también `*4`** (`165-167`)
  - Normal: `offset:u32`, `0xffffffff` significa vacío (`172-173`)
- Los tres `*4` son la codificación compacta de entradas de Android; quitarlos desalinea todo.

**`_readValue(at)` (`arsc.js:181-192`)**
- `ResTable_entry`: `size@0` (u16) y `flags@2` (u16); `flags & 0x0001` = `FLAG_COMPLEX` (bag/map; aquí están estilos, arrays y attr) → **devuelve null directamente** (`186`).
- `valueAt = at + entrySize` (`187`; entrySize puede ser 8 o 16), con `dataType@+3` y `data@+4` de `Res_value` (`189-190`).
- No valida `Res_value.size` (se supone 8) ni hace comprobaciones de límites más allá de `at+8` (solo el punto `183`).

**`parseConfig` / `score`**
- Diseño de `ResTable_config`: `size@0`, `imsi@4`, `locale(language@8,country@10)`, `screenType(orientation@12,touchscreen@13,**density@14**)`, `input@16`, `screenSize@20`, `version(**sdkVersion@24**)`, `screenConfig(screenLayout@28,**uiMode@29**)` (`48-59`).
- `isDefault = !language && !country && density===0 && !sdkVersion` (`60`): **no incluye `uiMode`**, así que una config que solo tiene `uiMode` se trata como default.
- Puntuación (`65-77`):
  - `prefer='file'`: `s += density` (prefiere mayor densidad); `anydpi(0xfffe)` recibe además `-500` (miedo a acabar con un xml de icono adaptativo; comentario `69`)
  - Los demás: sin preferencia de densidad; `language` −40, `sdkVersion/1000`, `uiMode` −20 (es decir, prefiere la configuración por defecto: sin idioma, sdk bajo y sin uiMode)

**`resolve(ref,prefer,depth)` (`arsc.js:200-230`)**
- `depth > 6` o `ref` igual a 0 → null directo (evita referencias circulares, `201`).
- Descompone el paquete: `pkgId = ref>>>24`, `typeId = (ref>>>16)&0xff`, `entryIdx = ref&0xffff` (`202-204`).
- **Si no encuentra el paquete, cae a `packages[0]`** (`206`): los APK con varios paquetes (bibliotecas compartidas 0x02/0x03) pueden consultar el paquete equivocado.
- Entre todas las configs del mismo typeId elige la de `score` más alto (`211-217`).
- `TYPE_STRING` → `globalStrings[data]` (`220-222`; undefined devuelve null); `TYPE_REFERENCE` → recursión (`224-226`); boolean/dec/hex se devuelven directos (`227-228`); cualquier otro null (por ejemplo `TYPE_DIMENSION` o colores, que aquí no se analizan).

### Puntos delicados e invariantes
1. **`globalStrings` debe ser el pool de nivel de archivo**: `value.data` es un índice en el pool global; los `typeStrings/keyStrings` del paquete solo sirven para depuración/visualización. Por eso es seguro que el `try/catch` de `_parsePackage` trague el error: `resolve` no depende de eso. **No cambies `resolve` para que use `keyStrings`.**
2. **Las constantes de `score()` son valores empíricos**: `anydpi` resta 500 y `language` resta 40. El objetivo es «las apps en chino toman primero el recurso por defecto y los iconos toman la mayor densidad»; el coste es que **el nombre de la app puede salir en inglés** (`values/` es el default y `values-zh/` se penaliza). Actualmente solo se busca «que se pueda mostrar», sin ajustar al idioma del sistema.
3. **Los recursos `FLAG_COMPLEX` nunca se obtienen**: si `android:icon` apunta a un recurso bag como `<bitmap>`/`<shape>`, devuelve null y cae en la heurística de respaldo de `apk.js`.
4. **El `*4` de los offsets dispersos/16 bits no se puede quitar** (`158`, `167`).
5. **`pkgCount` se lee pero no se usa** (`92`): el recorrido de chunks de nivel superior se apoya en `pos<total`, así que aunque aparezcan chunks que no son de paquete no hay error, pero `pkgCount` es una variable muerta.
6. No hay `ResTable_typeSpec`, ni overlayable/staged alias, ni coincidencia de locale, ni paquetes dinámicos `0x00`.
7. La constante `TYPE_REFERENCE` se exporta pero nadie la usa (`arsc.js:233`); es ruido de API.

### Quién lo llama
- `ResTable`: `src/core/apk.js:10` (require), `apk.js:104` (construido dentro de `try/catch`; si falla, degrada a `res=null`)
- `resolve`: `apk.js:65` (drawable del icono adaptativo), `apk.js:111` (`label`, `'string'`), `apk.js:141` (`icon`/`roundIcon`, `'file'`), `arsc.js:225` (recursión interna)
- Pruebas: `test/run-tests.js:81` (require), `run-tests.js:126`
- `TYPE_REFERENCE`: sin consumidores en todo el proyecto

### Cobertura de pruebas
- `test/run-tests.js:123` «resources.arsc se puede analizar»: solo asevera `res.packages.length > 0`; también depende de un fixture real de APK y se omite si no hay.
- No hay casos de `resolve()` (ni una sola aserción de que «un ref dado resuelve a la cadena/ruta esperada»), ni casos de FLAG_SPARSE / FLAG_OFFSET16 / FLAG_COMPLEX.
- Conclusión: **en esta cadena, `arsc.js` es el que tiene las pruebas más delgadas**, aunque su lógica es la más difícil (tres codificaciones de entrada + puntuación de config).

---

## 4. `src/core/png.js`

### Responsabilidades
Codificador PNG **sin dependencias** + dibujo por programa del icono de marca de ApkBuddyStart (evita meter material binario en el repositorio y facilita cambiar el color del tema).

> Ojo con la dirección: solo hay codificación (RGBA → PNG), **no hay decodificación**. Decodificar WebP/PNG depende por completo de `nativeImage` / Chromium de Electron (véase la sección 6).

### Interfaz pública
```js
const { encodePng, drawAppIcon } = require('./png');

encodePng(width, height, rgba /*: Uint8Array, longitud = w*h*4, orden RGBA */)  // → Buffer(PNG)
drawAppIcon(size = 256)  // → Buffer(PNG), size×size
```

### Implementación interna clave
- **CRC32** (`png.js:8-22`): polinomio reflejado estándar `0xedb88320`, tabla de 256 entradas guardada en `Int32Array`; `crc32()` devuelve el valor sin signo con `>>> 0`.
- **chunk()** (`png.js:24-31`): `[len BE][type ascii][data][crc BE]`; el CRC cubre type+data.
- **`encodePng`** (`png.js:34-55`):
  - IHDR de 13 bytes: `width/height` BE, bitDepth=8, colorType=6 (RGBA), compression/filter/interlace a 0 (`png.js:36-40`)
  - datos en bruto `raw = (width*4+1)*height`; el primer byte de cada fila lleva filter 0 (None) y el resto se copia con `Buffer.from(rgba.buffer, byteOffset + y*stride, stride)` (`png.js:43-48`): **exige que `rgba.byteOffset` sea un desplazamiento válido**; también sirve una vista `Uint8ClampedArray`
  - un único IDAT, `zlib.deflateSync(raw, {level:9})` (`png.js:52`); con `level:9`, 256×256 tarda unas decenas de milisegundos
- **`drawAppIcon`** (`png.js:80-130`):
  - supersampling 4×: `SS=4`, `S=size*4`; `acc = Float32Array(size*size*4)` acumula colores (`png.js:83`)
  - formas: rectángulo redondeado con `pad = 6 %` y radio `24 %` (`85-86`), decidido con `roundRectAlpha()` (`59-65`, «fija el punto al rectángulo interior y calcula la distancia al centro más cercano»); triángulo con `pointInTriangle()` (`67-74`, tres productos cruzados del mismo signo)
  - colores: gradiente diagonal `t = (x/S)*0.6 + (y/S)*0.4` → `r 20..34 / g 26..44 / b 33..57`; triángulo en color plano `#3ddc84` = (61,220,132) (`105-111`)
  - el muestreo solo acumula muestra dentro de la caja (`102`, `if (!inBox) continue;`), fuera de la caja el alpha sigue en 0; al final se divide todo entre `n = SS*SS = 16` (`122-127`) → los bordes obtienen una cobertura de 0..255, es decir, antialiasing
- **Límite de rendimiento**: `size=256` → `S=1024`, 1.048.576 iteraciones con 1~2 comprobaciones geométricas cada una; una llamada está en el orden de 5–15 ms. `size=512` son 4 M de iteraciones (unas 4×). `main.js:175` calcula `ICON_PNG` una vez al arrancar y lo guarda en caché, así que no es una ruta caliente.

### Puntos delicados e invariantes
1. **`acc` debe ser `Float32Array`**: al sumar 16 muestras, un `Uint8Array` se desbordaría/recortaría a 255 y saldrían bloques de color. Se podría usar Uint16, pero la línea de la división tendría que cambiar igualmente.
2. `encodePng` supone que `rgba.length >= w*h*4` y **no valida la longitud**; si es más corto, `copy` lanza RangeError; si es más largo, se ignora el exceso.
3. Solo admite RGBA8 / filter 0 / un único IDAT: es un codificador «suficiente». Para añadir optimización de filtros (Paeth) habría que reescribir el bucle de relleno de `raw`.
4. Todas las coordenadas de `drawAppIcon` son relativas a `S` (espacio de supersampling); cambiar `SS` no afecta a la composición; cambiar `size` solo afecta a nitidez/tiempo.
5. Esta es la fuente del «icono de marca de marcador» y también la entrada de la tercera capa de respaldo de `iconToIco` (`shortcut.js:128-129`), así que en **cualquier fallo de extracción de icono** el usuario ve en su escritorio este triángulo verde.

### Quién lo llama
- `drawAppIcon`: `src/main.js:15` (require), `main.js:28` (respaldo de `loadBrandIcon()`, cuando no existe `LOGO_FILE`)
- `src/core/shortcut.js:128` (require), `129` (ICO de marcador)
- `encodePng`: solo `png.js:129` (dentro de `drawAppIcon`) + pruebas
- Pruebas: `test/run-tests.js:63` (require), `66`, `73`; `test/auto-test.js:496`, `497`; `test/electron-integration.js:22`, `27`

### Cobertura de pruebas
- `test/run-tests.js:64` «el codificador PNG produce una firma y un IHDR válidos»: comprueba la firma `0x89 0x50`, `IHDR` y longitud > 50; **no valida CRC ni píxeles**.
- `test/run-tests.js:71` «el icono de la app se puede dibujar a cualquier tamaño»: las salidas 16/32/64/256 tienen como ancho el parámetro de entrada.
- `test/auto-test.js:494` usa indirectamente `drawAppIcon(64)` como material PNG-dentro-de-ICO.
- Huecos: no hay ninguna aserción sobre la **corrección de píxeles** de `drawAppIcon` (solo se mide el tamaño); no se prueban entradas anómalas de tamaño/longitud en `encodePng`.

---

## 5. `src/core/apk.js` (punto de entrada total)

### Responsabilidades
Extraer sin conexión los metadatos del APK: nombre de paquete / versión / nombre de la app / Activity de arranque / icono / ABI. No depende de aapt, adb ni red.

### Interfaz pública
```js
const { parseApk, quickCheck } = require('./apk');

parseApk(filePath /*: string */) → {
  ok: true,
  filePath,          // se devuelve tal cual
  sizeBytes,         // size de fs.statSync
  package: string,   // obligatorio; si no, lanza error
  label: string,     // espacios en blanco colapsados + trim + truncado a 60 caracteres
  versionName: string,   // por defecto '1.0'
  versionCode: number,   // 0 si no es number
  minSdk: number,        // por defecto 0
  targetSdk: number,     // por defecto 0
  launchActivity: string|null,
  abis: string[],        // ['arm64-v8a', ...]; [] si no hay lib/
  iconPng: Buffer|null,  // bytes originales del icono (¡PNG o WebP!: el nombre del campo engaña)
  iconFile: string|null, // ruta dentro del APK, p. ej. 'res/mipmap-xxxhdpi-v4/ic_launcher.png'
}   // cualquier fallo lanza error (no devuelve ok:false)

quickCheck(filePath /*: string */) → boolean   // solo lee los primeros 4 bytes para ver 'PK'; cualquier excepción devuelve false
```

### Implementación interna clave (`parseApk`, `apk.js:75-175`)

1. `fs.statSync` → si `size < 1024`, lanza «archivo demasiado pequeño» (`76-77`).
2. `const buf = fs.readFileSync(filePath)` (`78`) → **paquete entero en memoria**: el paso más pesado de toda la cadena.
3. `new ZipArchive(buf)` (`79`).
4. Debe existir `AndroidManifest.xml`; si no, sugiere «podría ser un paquete dividido .apks/.xapk» (`81-83`).
5. `zip.read` + `parseAxml` (`85-86`).
6. `package`: **primero se busca sin namespace** (`88`, `attrValue(manifest,'package',null)`) y luego se cae al namespace por defecto (forma de respaldo).
7. `versionName` por defecto `'1.0'`; `versionCode` solo acepta number (`91-93`).
8. El `minSdkVersion` / `targetSdkVersion` de `uses-sdk` se normalizan con `| 0` (`95-97`): `null | 0 === 0`.
9. Se toma el primer nodo `application`, con un objeto vacío como respaldo (`99`).
10. Tabla de recursos: solo se construye `ResTable` si existe `resources.arsc`, **dentro de un try/catch general** (`103-105`) → si arsc está dañado, `res=null` y todas las resoluciones de `refId` fallan y caen automáticamente a los valores por defecto.
11. Nombre de la app (`108-117`): `attr(app,'label')` → `res.resolve(refId,'string')` → si no, se usa `typed` si es string → si no, **la primera letra en mayúscula del último segmento del nombre de paquete**.
12. Activity de arranque (`120-134`):
    - candidatos = `activity` + `activity-alias` (`121`)
    - `isLauncherActivity` (`15-25`): **dentro del mismo `intent-filter`** deben aparecer a la vez `android.intent.action.MAIN` y `android.intent.category.LAUNCHER` (no se combinan filters distintos)
    - completar el nombre: si empieza por `.` → `package + n`; si no contiene `.` → `package.n`; en cualquier otro caso tal cual (`127-129`)
    - si es `activity-alias` y trae `targetActivity`, se **sobrescribe** con el target (`130-132`; la comprobación usa el nombre de etiqueta `launcher.name === 'activity-alias'`)
13. Icono (`137-152`): primero `icon`, con `roundIcon` como respaldo (`138`) → `res.resolve(refId,'file')` o la cadena `typed` → se verifica con `zip.has(file)` → si termina en `.xml` se usa `iconFromAdaptiveXml`, si no, directamente `zip.read(file)` → por último, si `!icon`, se usa `pickIconFromZip`.
14. ABI (`155-158`): se toman las entradas con prefijo `lib/` y se deduplica el segundo segmento.
15. Se devuelve el objeto (`160-174`).

**`iconFromAdaptiveXml(zip, xmlBuffer, res)` (`apk.js:51-73`)**
- Analiza el XML del icono adaptativo y busca, en orden `['foreground','background','monochrome']`, los **hijos directos** (`58-60`); también acepta que el nodo raíz sea uno de ellos (segunda mitad de `60`)
- Toma `android:drawable`: si hay `refId` → `res.resolve(...,'file')`; si no, la cadena `typed` (`62-66`)
- **Solo acepta `.png`/`.webp`** (`67`) y exige que `zip.has(file)` (`68`); solo devuelve el dato si `data.length > 100` (`70`)
- No recursa dentro de `<inset>`, `<layer-list>` ni `<bitmap>`; si el XML falla al analizarse, devuelve null (`53-57`)

**`pickIconFromZip(zip)` (`apk.js:27-48`, heurística de respaldo)**
- Candidatos: `/^res\/.*\.(png|webp)$/i` (`29`)
- Puntuación = `uncompSize` de `entries.get(n)`, es decir, **bytes sin comprimir** (no tamaño en píxeles), multiplicado por un peso según el nombre:
  - `ic_launcher|app_icon|ic_app` ×6 (`33`)
  - `_round|_foreground|_background` ×0.4 (`34`)
  - `xxxhdpi` ×1.6 / `xxhdpi` ×1.4 / `xhdpi` ×1.2 (`35-37`)
- Ordena descendentemente y solo prueba los 30 primeros (`41`); acepta solo si `data.length > 100` (`44`), si no, null.

### Puntos delicados e invariantes
1. **`readFileSync` de todo el paquete (`apk.js:78`)**: analizar un APK de 500 MB hace que el proceso ocupe 500 MB más de memoria residente; con `>2 GB` salta directamente `ERR_FS_FILE_TOO_LARGE`. Con `.apks`/`.xapk` a través de `installer.parseBundle` es peor todavía (el ZIP exterior también se lee entero, luego cada split se escribe a disco y después cada uno se analiza con `parseApk`).
2. **El nombre `iconPng` engaña**: `apk.js:172` devuelve los **bytes originales del icono**, que pueden ser WebP (`res/mipmap-*/ic_launcher.webp`). Por eso `shortcut.iconToIco` necesita tres niveles de respaldo, y que `installer.js:208-209` lo guarde como `.png` da como resultado «archivo llamado .png con contenido quizá WebP»: Chromium/nativeImage lo reconoce por el magic number y lo muestra, pero al abrirlo con herramientas externas hay incoherencia.
3. **`launchActivity` es solo «lo que declara el APK»**: `installer.js:227-234` comenta explícitamente que «la Activity principal analizada del APK suele no ser la entrada LAUNCHER real»; tras instalar se sobrescribe con `client.resolveLauncher(pkg)`. **No añadas lógica de arranque aquí.**
4. **Tratamiento del target de `activity-alias`**: en `130-132` se usa `launcher.name` (el nombre de etiqueta); si una misma activity tiene alias y declaración real y ambas coinciden, se toma la primera que se encuentre; el orden es `activity` primero y `activity-alias` después (`121`).
5. **`apk.js:38` en `pickIconFromZip` es código muerto heredado**: `if (/\//.test(n.split('/')[1] || '')) { /* noop */ }`, no hace nada; se puede borrar sin riesgo.
6. **La puntuación usa `uncompSize`**: una imagen «muy comprimida y de píxeles enormes» (splash de color plano) puede quedar detrás por comprimirse poco; un icono de color plano también puede quedar detrás de una foto. Es el defecto natural de una heurística.
7. **Respaldo de `label`**: `a.b.c` → `C`, de modo que el paquete `com.example.game` se muestra como `Game`. Cuando falla el análisis arsc, una app en chino degrada a un segmento en inglés: es una degradación aceptable.
8. **Cuando `res` es null no se lanza ningún error**: `label` e `icon` caen al valor por defecto; esta ruta de tolerancia hace que «el analizador ARSC está roto» se manifieste como «icono feo y nombre en inglés» en lugar de un error. Al investigar, mira primero si `iconFile` fue elegido por la heurística de respaldo.
9. `quickCheck` (`178-188`) **no tiene ningún llamador en `src/`** (solo lo usan las pruebas): es código muerto; el canal IPC `apk:parse` (`main.js:756`) tampoco lo consume `src/ui/app.js` (la UI usa `installApk`, `ui/app.js:484`).

### Quién lo llama
- `parseApk`:
  - `src/main.js:14` (require), `main.js:756` (IPC `apk:parse`)
  - `src/preload.js:10` (`window.apkstart.parseApk`)
  - `src/core/installer.js:11` (require), `installer.js:40` (busca la base en el paquete dividido), `installer.js:149` (ruta principal de instalación)
  - `scripts/selftest.js:18`, `142`
  - Pruebas: `test/run-tests.js:82`, `106`; `test/electron-integration.js:24`, `55`
- `quickCheck`: **solo se usa en `test/run-tests.js:103-104`**
- Indirectamente (`installer.install`): `src/main.js:758` (IPC `apk:install`) ← `src/ui/app.js:484`

### Cobertura de pruebas
- `test/run-tests.js:103` «quickCheck reconoce la cabecera PK»
- `test/run-tests.js:107` «se analizan nombre de paquete / versión / Activity de arranque»: asevera que `package` coincide con `^[\w.]+$`, que hay `versionName` y que `launchActivity` contiene `.`
- `test/run-tests.js:113` «se extrae un icono usable»: `iconPng.length > 100` y `label` no vacío
- Las tres pruebas anteriores **dependen de un fixture real de APK**; sin él se omite toda la sección (`run-tests.js:130-132`) → en CI es como no probar nada
- `test/electron-integration.js:54-62` ejecuta con un APK real «icono APK → ICO multitudamaño»; si falla, el log escribe «el icono puede tener un formato distinto de webp/jpg»
- Huecos: `.apks`/`.xapk` (`installer.parseBundle`) no tienen ningún caso; tampoco los negativos de `activity-alias`, sin arsc y sin icono

---

## 6. `src/core/shortcut.js`

### Responsabilidades
Convertir el icono del APK en un ICO multitudamaño y escribir los `.lnk` del escritorio/menú Inicio de Windows; tres niveles de respaldo garantizan que el acceso directo **siempre** tenga icono.

### Interfaz pública
```js
const {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
} = require('./shortcut');

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]   // 9 tamaños; se exporta pero no hay consumidores externos

pngToIco(pngBuffer)                  // → Buffer(ICO, DIB multitudamaño) | null; ★ usa require('electron') internamente: en Node puro lanza TypeError
pngBytesToIco(png)                   // → Buffer(ICO, PNG-dentro-de-ICO de un tamaño) | null; funciona en Node puro
iconToIco(raw, { decode } = {})      // async → Buffer(ICO) | null; tres niveles de respaldo
writeShortcut({                      // → string (shortcutPath escrito correctamente)
  shortcutPath, target, args?, iconIcoPath?, description?, cwd?, appUserModelId?,
})                                   // si falla, lanza error (tres textos de error, véase más abajo)
removeShortcut(p)                    // → boolean; las excepciones se tragan
safeFileName(name)                   // → string; sustituye caracteres ilegales, colapsa espacios y trunca a 60; si queda vacío, 'Android App'
```

### Implementación interna clave

**`buildDib(bgra, size)` (`shortcut.js:13-33`)**
- `BITMAPINFOHEADER` de 40 bytes escrito a mano: `biSize=40`, `biWidth=size`, `biHeight=size*2` (dos segmentos XOR + AND), `biPlanes=1`, `biBitCount=32`, `BI_RGB`, `biSizeImage=size*size*4` (`14-21`)
- El mapa de bits XOR invierte el orden de las filas **de abajo arriba** (`25-28`; el eje y de ICO/DIB apunta hacia arriba)
- Máscara AND a 1bpp, filas alineadas a 4 bytes y **toda a 0** (`30-31`; el comentario indica que «se deja al canal alpha»)

**`pngToIco(pngBuffer)` (`shortcut.js:39-73`) — ruta DIB multitudamaño**
- `require('electron')` dentro de la función (`40`); `nativeImage.createFromBuffer`; si `isEmpty()` devuelve null (`41-42`)
- Para los 9 tamaños, `resize({quality:'best'})` → `buildDib(img.toBitmap(), s)` (`45-51`)
- `img.toBitmap()` en Windows devuelve **BGRA**, justo el orden que necesita DIB, sin intercambiar canales
- ICONDIR: `reserved=0, type=1, count=n`; cada entrada ocupa 16 bytes: `width/height` u8, `colorCount=0`, `reserved=0`, `planes=1`, `bitCount=32`, `bytesInRes`, `imageOffset` (`53-72`)
- **Los bytes de ancho/alto se ponen a 0 cuando `>=256`** (`61-62`): en el directorio ICO, un solo byte a 0 significa 256

**`pngBytesToIco(png)` (`shortcut.js:83-101`) — ruta PNG-dentro-de-ICO**
- Validación: `Buffer` con `length >= 24` y `[1,4)` igual a `'PNG'` (`84`); lee del IHDR `w@16`, `h@20` en BE, con `w/h` distintos de cero y `<= 1024` (`85-87`)
- ICONDIR fijo de 22 bytes (6 + 16), con `bytesInRes = png.length` y `imageOffset = 22` (`88-99`); la zona de datos **son directamente los bytes del PNG original** (sin recodificar, sin perder alpha)
- Válido desde Vista, por eso el comentario dice que «la ruta DIB antigua aquí fallaría con el paquete completo» (`80-82`)

**`iconToIco(raw, {decode})` (`shortcut.js:109-133`) — tres niveles de respaldo**
1. `nativeImage.createFromBuffer(raw)` puede decodificarlo (PNG/JPEG reales) → `img.toPNG()` → `pngToIco` (`111-118`). **`toPNG()` es necesario** porque raw puede ser JPEG y, aunque `pngToIco` admite PNG/JPEG, DIB necesita píxeles
2. Existe el callback `decode` → `await decode(raw)` produce un PNG → `pngBytesToIco` (`120-126`). Por aquí va WebP (lo decodifica Chromium)
3. Marcador de posición: `drawAppIcon(256)` → `pngBytesToIco` (`127-132`)
4. Si todo falla, devuelve null

**`writeShortcut(opt)` (`shortcut.js:144-169`)**
- Si el directorio no existe, `mkdirSync(recursive)`; si falla, lanza «el directorio de accesos directos no se puede escribir» (`146-151`)
- **Si el .lnk ya existe, primero se borra con `unlinkSync`** (`152-154`)
- `shell.writeShortcutLink(path,'create',{target,args,icon,iconIndex:0,description,cwd,appUserModelId})` (`155-163`); si no se da `icon`, se usa `target`
- Si devuelve false, lanza «falló la creación del acceso directo» (`164`)
- **Verificación de relectura**: si `fs.existsSync(shortcutPath)` es falso, lanza «el acceso directo no se ha escrito en disco» (`165-167`); el comentario (`138-141`) documenta esta trampa: con antivirus que intercepta o con el escritorio redirigido a una unidad en la nube sin sesión iniciada, «devuelve true pero el archivo no existe»

**`safeFileName` (`shortcut.js:75-77`)**
`[\\/:*?"<>|]` → `_`, `\s+` → espacio, trim, `slice(0,60)` y, si queda vacío, `'Android App'`. Los nombres reservados de Windows (CON/PRN/NUL…) **no se tratan**.

### Puntos delicados e invariantes
1. **`pngToIco` no se puede ejecutar en Node puro**: `require('electron')` en Node devuelve la **cadena de ruta** a electron.exe, por lo que el `nativeImage` desestructurado es `undefined` y `createFromBuffer` lanza TypeError directamente (la función no tiene try/catch). Por eso todos los casos de `pngToIco` están en `test/electron-integration.js` (se ejecutan con `electron test/...`) y `npm test` solo prueba `pngBytesToIco`/`iconToIco`.
2. **Las dos ramas del ternario en `shortcut.js:46-48` tienen exactamente el mismo código** (solo cambia el comentario), equivalente a un `resize` incondicional. Es un caso de «un comentario que explica una rama que no existe», se puede limpiar. La intención real que expresa el comentario es: **agrandar una imagen pequeña es mejor que no tener tamaño** (un icono de 64 px se interpola a 256 px: se ve borroso, pero no aparece un hueco vacío).
3. **El invariante de tamaño de `pngBytesToIco`**: los bytes de ancho/alto del directorio son de un solo byte y `>=256` se escribe 0 (=256). Si se pasa un PNG de 512×512, el directorio **anuncia 256 pero los datos son 512** y algunos shells se niegan a mostrarlo. Actualmente se garantiza desde el llamador: `decodeIcon` en `main.js:223` limita con `Math.min(256, ...)` y `pngToIco` tampoco supera 256. **Esta restricción es implícita y es justo donde se tropieza al añadir un llamador nuevo.**
4. **La máscara AND del DIB es toda 0**: depende del canal alpha de 32bpp. Los shells antiguos de estilo XP tratan el alpha 32bpp de forma inconsistente, pero Win10/11 no tienen problema.
5. **`writeShortcut` borra y luego crea**: se pierden atributos del .lnk original como «fijar a la barra de tareas» o «ejecutar como administrador». `installer.createShortcut` reconstruye en cada reinstalación, así que los elementos fijados manualmente pueden dejar de funcionar (se fija el AUMID, que normalmente se puede recuperar).
6. **`icon: opt.iconIcoPath || opt.target`**: si falla la generación del ico se usa el icono del exe, así que no aparece un icono «en blanco».
7. **`appUserModelId` es opcional** (`162`); a partir de `installer.js:299` se pasa «un AUMID por aplicación» para agrupar la barra de tareas: el comentario está en `installer.js:299`, `writeShortcut` solo lo reenvía.
8. `removeShortcut` traga todas las excepciones y devuelve false; `installer.uninstall` no comprueba el valor devuelto (`installer.js:373-374`).

### Quién lo llama
- `pngToIco`: `src/main.js:1310` (require), `1311` (se calcula al vuelo si falta el ICO de marca); `shortcut.js:115` (dentro de `iconToIco`); `test/electron-integration.js:23`, `29`, `56`
- `pngBytesToIco`: `shortcut.js:123`, `129`; `test/auto-test.js:495`, `498`, `502`
- `iconToIco`: `src/core/installer.js:13` (require), `212` (al instalar), `346` (al recrear iconos); `test/auto-test.js:495`, `505`, `507`
- `writeShortcut`: `installer.js:13`, `292` (`createShortcut`); `test/electron-integration.js:23`, `35`
- `removeShortcut`: `installer.js:13`, `373`, `374` (desinstalación)
- `safeFileName`: `installer.js:13`, `75` (ruta del escritorio), `88` (ruta del menú Inicio), `319` (ruta de respaldo)
- `ICO_SIZES`: solo lo usa `shortcut.js:45`; se exporta sin consumidores externos
- Contexto de llamada: `ctx.decodeIcon` lo define `main.js:213` y se inyecta en `Installer` en `main.js:1498`

### Cobertura de pruebas
- `test/auto-test.js:494` «PNG-in-ICO y el respaldo de iconos WebP producen ambos un ICO usable»: asevera la cabecera ICO `type=1/count=1`, que `bytesInRes` es igual a la longitud del PNG, que `ico.slice(22)` es exactamente igual al PNG original, que una entrada inválida devuelve null, que WebP sin decode cae al marcador y que con decode usa la imagen real. **Es el caso mejor cubierto de este archivo.**
- `test/electron-integration.js` (`electron test/electron-integration.js`, **fuera de `npm test`**): pasos «generar ICO», «crear .lnk», «borrar .lnk» e «icono APK → ICO multitudamaño»; el resultado se escribe en `test/out/result.json`.
- Huecos: la estructura de bytes DIB de `pngToIco` no tiene aserciones (solo «se genera y mide >1000 bytes» en la integración con Electron); `safeFileName` no tiene pruebas unitarias de nombres reservados/demasiado largos/caracteres ilegales; la rama «devuelve true pero no se ha escrito» de `writeShortcut` no se puede construir en una prueba.

---

## 7. `src/core/assoc.js`

### Responsabilidades
Registrar/desregistrar la asociación de archivos `.apk` bajo `HKCU\Software\Classes` (sin permisos de administrador): doble clic en APK → `apkstart.exe "%1"`.

### Interfaz pública
```js
const { registerAssociation, unregisterAssociation, PROGID } = require('./assoc');
PROGID = 'ApkBuddyStart.apk'

registerAssociation(exePath /*: string, obligatorio */, iconPath /*?: string */, extraArgs /*?: string */)
  // → { ok: true, progId: 'ApkBuddyStart.apk' }   ★ siempre ok:true, aunque todas las operaciones reg fallen
unregisterAssociation() → { ok: true }        // igual
```

### Implementación interna clave
- `reg(args)` (`assoc.js:11-18`): `execFileSync('reg', args, {windowsHide:true, stdio:'pipe'})`; **todas las excepciones se tragan y devuelven false**, sin propagarse. → Todas las escrituras en el registro son «a lo sumo lo posible» y el llamador no recibe información del fallo.
- `notifyShell()` (`assoc.js:20-33`): PowerShell `Add-Type` con P/Invoke llama a `SHChangeNotify(0x08000000=SHCNE_ASSOCCHANGED, 0, NULL, NULL)` para que el Explorador actualice iconos/asociaciones; `timeout: 8000` y los fallos se ignoran (comentario `32`).
- `registerAssociation` (`assoc.js:40-56`) escribe 6 entradas:
  1. Valor por defecto de `HKCU\Software\Classes\.apk` = `ApkBuddyStart.apk`
  2. `.apk\OpenWithProgids` añade `ApkBuddyStart.apk` (valor vacío `REG_NONE`; `46`: es la forma correcta de aparecer en la lista «Abrir con»)
  3. Valor por defecto de `ApkBuddyStart.apk` + `FriendlyTypeName` = «Paquete de aplicación Android»
  4. `DefaultIcon` = `"<icon>",0`
  5. Valor por defecto de `shell\open` = «Instalar en ApkBuddyStart»
  6. `shell\open\command` = `"<exePath>" <extraArgs> "%1"` (`43`)
- Composición de `command` (`assoc.js:43`): **el llamador es responsable de poner las comillas en `extraArgs`** (en modo desarrollo hay que pasar el directorio de la aplicación). Puntos de llamada reales: `main.js:1315` pasa `l.args` (`launcherInfo()` ya las pone) y `scripts/assoc.js:22` pasa `"<appDir>"`.
- `unregisterAssociation` (`assoc.js:58-66`): borra el valor de `OpenWithProgids` → borra todo el subárbol `ApkBuddyStart.apk` → deja el valor por defecto de `.apk` vacío **sin condiciones** → notifica al shell.

### Puntos delicados e invariantes
1. **★★ El comentario y la implementación no coinciden (defecto real)**: `assoc.js:62` dice «solo se borra el valor por defecto si .apk sigue apuntando a nosotros», pero `assoc.js:63` es `reg(['add', ...EXT, '/ve', '/d', '', '/f'])` **sin ninguna condición**. Consecuencia: si el usuario tenía `.apk` asociado a otra herramienta de descompresión (o al tipo «desconocido» del sistema), al desregistrar se borra el valor por defecto y se pierde la asociación original, sin copia de seguridad ni restauración. Arreglo: hacer primero `reg query` para leer el valor actual y borrarlo solo si es igual a `PROGID`.
2. **El valor devuelto no aporta información**: `registerAssociation` siempre devuelve `ok:true`, así que el IPC de `main.js:1315` no puede distinguir «éxito» de «todo bloqueado por política». Si la UI muestra un mensaje de éxito, es falso.
3. **`notifyShell` depende de PowerShell + `Add-Type`**: en máquinas sin PowerShell o con política restringida falla en silencio y la asociación no se actualiza (el usuario tiene que volver a iniciar sesión o actualizar a mano). Con `timeout: 8000` bloquea sincrónicamente el proceso principal y, en el peor caso, cuelga 8 segundos.
4. **La responsabilidad de las comillas de `extraArgs` es del llamador** (`assoc.js:43`): una ruta con espacios sin comillas produce una línea de comandos incorrecta.
5. Solo escribe HKCU y no toca HKLM: esa es la clave del «sin administrador», y también significa que **cada usuario tiene que registrarla por su cuenta en entornos multiusuario**.
6. `PROGID` está escrito a mano como `'ApkBuddyStart.apk'` y, junto con `EXT='.apk'`, forma el contrato del registro; cambiarlo deja restos de versiones anteriores que `unregisterAssociation` no puede limpiar (solo borra ese árbol `PROGID`).

### Quién lo llama
- `registerAssociation`: `src/main.js:30` (require), `main.js:1315` (IPC `assoc:register`); `scripts/assoc.js:10`, `21`
- `unregisterAssociation`: `main.js:1318` (IPC `assoc:unregister`), `main.js:1351` (flujo de desinstalación, dentro de `try/catch`); `scripts/assoc.js:26`
- `PROGID`: `main.js:1297` (`assoc:status` decide si está asociado mirando si la salida de `reg query` lo contiene)
- UI: `src/ui/app.js:754-755` solo consume el campo `registered` de `assoc:status`

### Cobertura de pruebas
**Ninguna.** `grep -r assoc test/` da cero resultados; `auto-test.js` / `engine-test.js` / `run-tests.js` no tienen casos de registro (porque cambian el estado). `scripts/assoc.js` es un interruptor manual. Es el único módulo del grupo **sin ninguna verificación automatizada**.

---

## 8. `src/core/version.js`

### Responsabilidades
Comparación de números de versión. Se separó en un módulo pequeño **para evitar la dependencia circular `updater` ↔ `sources`** (comentario en `version.js:3`).

### Interfaz pública
```js
const { parseVer, cmpVer } = require('./version');

parseVer(v)     // → Array<number|string>: quita el prefijo 'v', divide por [.+-], convierte los segmentos numéricos a Number y filtra los vacíos
cmpVer(a, b)    // → 1 (a>b) | -1 (a<b) | 0 (iguales)
```

### Implementación interna clave
- `parseVer` (`version.js:7-13`): `String(v||'')` → `replace(/^v/i,'')` → `split(/[.+-]/)` → los segmentos numéricos se convierten a `Number`, los no numéricos se conservan como cadena → `.filter(x => x !== '')`.
  - `'v0.3.2'` → `[0,3,2]`; `'0.3.2-preview'` → `[0,3,2,'preview']`; `'1.0.0+build'` → `[1,0,0,'build']`.
- `cmpVer` (`version.js:16-34`): toma la longitud del más largo y compara segmento a segmento; **si uno se agota primero, el más corto es menor** (`23-24`); si ambos son number se comparan numéricamente y, si no, con orden lexicográfico de `String()` (`25-31`).

### Puntos delicados e invariantes
1. **`cmpVer('1.0','1.0.0') === -1`, no 0** (semántica de `23-24`). Al usarlo en `updater.hasUpdate` (`updater.js:109`), «actual 1.0 / remoto 1.0.0» se considera que hay actualización: ahora mismo las versiones siempre tienen tres segmentos y no se ha dado, pero **no lo uses para comprobar igualdad**.
2. **No es semver**: los segmentos de prerelease se comparan como cadenas → `'preview' > 'beta'` (orden lexicográfico) y `'rc1' > 'rc'`; `1.0.0+build` es **mayor** que `1.0.0` por tener un segmento más (en semver, build metadata se ignoraría). Sufice para el uso que se le da: ordenar tags de release de GitHub/Gitee.
3. Los segmentos numéricos usan `Number()`, así que `'01'` y `'1'` son iguales; `'1.10' > '1.9'` funciona correctamente (comparación numérica).
4. Cadena vacía / `null` → `[]`, que comparado con cualquier versión no vacía da `-1`.
5. El módulo es deliberadamente de dependencia cero (solo exporta dos funciones puras); cualquier intento de añadir una dependencia reintroduciría el ciclo.

### Quién lo llama
- `cmpVer`:
  - `src/core/provision.js:17` (require), `513` (`cands.sort((a,b) => cmpVer(b.tag, a.tag))`, elige la versión de imagen)
  - `src/core/sources.js:20` (require), `299` (lista de releases en orden descendente de tag)
  - `src/core/updater.js:22` (require), `109` (`hasUpdate: cmpVer(merged.tag, this.current) > 0`) y `333` (**reexporta** `cmpVer`, de modo que los consumidores de `updater.js` pueden saltarse version.js)
- `parseVer`: solo `version.js:17-18` (dentro de `cmpVer`)
- Pruebas: `test/auto-test.js:821` lo importa desde `../src/core/updater` (a través de la reexportación), no directamente desde `version.js`

### Cobertura de pruebas
- `test/auto-test.js:820` «la comparación de versiones es numérica segmento a segmento; el prefijo v y los multinivel funcionan»: 4 aserciones: `v0.3.2 > 0.3.1`, prefijo `v` equivalente, `0.10.0 > 0.9.9` (evita la comparación de cadenas) y `1.0.0 < 1.0.1`.
- Huecos: `1.0` frente a `1.0.0`, segmentos de prerelease, `+build` y valores vacíos no tienen casos.

---

## 9. `src/core/logfile.js`

### Responsabilidades
Adición ligera de logs + rotación por tamaño (conserva solo una copia `.1.log`) para evitar que `app.log` / `emulator.log` crezcan sin límite y coman disco.

### Interfaz pública
```js
const { append, rotate, trimNow } = require('./logfile');

append(file, line, limitKB = 2048)   // → boolean (true=escritura correcta; cualquier excepción da false; el log nunca lanza)
rotate(file, limitKB)                // → boolean (true=esta vez se hizo la rotación)
trimNow(file, limitKB = 2048)        // → boolean (= rotate, pero salta el contador; ★ sin llamadores en src)
```

### Implementación interna clave
- Comentario de motivación (`logfile.js:4-9`): cada arranque del emulador escribe decenas de KB de log del kernel; abrir y cerrar una docena de veces al día + qemu verbose → cientos de MB en unos meses.
- `counters = new Map()` (`13`): cuenta por ruta de archivo **dentro del proceso**; no se comparte entre procesos.
- `rotate(file, limitKB)` (`15-26`):
  - Si `statSync` falla (archivo inexistente) → el catch devuelve false (`23-25`)
  - Si `size < limitKB*1024` → false (`18`), es decir, **solo se rota al superar el límite**
  - Nombre de la copia: `file.replace(/\.log$/i, '.1.log')` (`19`); primero `rmSync(bak,{force:true})` y después `renameSync(file,bak)` → siempre queda una sola copia
- `append(file, line, limitKB)` (`33-45`):
  - `mkdirSync(dirname, {recursive:true})` (`35`; incluso para escribir un log se garantiza que el directorio exista)
  - El contador +1; **solo se rota cuando `n===1` (primera vez en el proceso) o `n%200===0`** (`39`; comentario `38`: `statSync` es barato pero no hace falta hacerlo en cada línea)
  - `appendFileSync(file, line.endsWith('\n') ? line : line+'\n')` (`40`; añade el salto de línea automáticamente)
  - Límite inferior: `Math.max(256, Number(limitKB) || 2048)` (`39` / `49`): el umbral mínimo es 256 KB
  - Toda la función va dentro de try/catch y devuelve false si falla (`41-44`)

### Puntos delicados e invariantes
1. **★ Si el nombre de archivo no termina en `.log` se pierde el log**: `bak === file`, así que `rmSync(bak)` borra el archivo y `renameSync` falla porque el origen ya no existe (ENOENT) → devuelve false, **pero el log original ya se ha borrado**. Actualmente los dos puntos de llamada pasan `*.log` (`app.log` y `emulator.log`), así que no ha estallado; cualquier llamador nuevo debe respetar el contrato implícito de «el nombre termina en .log».
2. **La rotación ocurre antes de la adición** (`39` va antes que `40`): se rota y se escribe enseguida en el archivo nuevo, el log sigue siendo continuo y no aparece un «se rotó y se perdió esta línea».
3. **El contador es de proceso**: al reiniciar el proceso principal vuelve a empezar en 1 → en cada arranque se hace obligatoriamente un `statSync`, lo cual es correcto (y también implica que **si no se reinicia durante mucho tiempo** se pueden dejar de detectar hasta 199 líneas).
4. **Varios escritores sin bloqueo**: si el proceso principal y un futuro proceso hijo escriben el mismo archivo, `rotate` tiene una carrera (A borra bak, B también lo borra, A renombra con éxito, B falla al renombrar → el log de B va al archivo nuevo, lo cual en realidad es aceptable).
5. **`limitKB` significa «umbral de rotación», no «límite estricto»**: una sola línea añadida puede ser arbitrariamente larga (el emulador escribe a la vez decenas de KB de salida de arranque), así que justo después de rotar el archivo puede seguir muy por encima del umbral hasta la siguiente comprobación.
6. **`trimNow` es código muerto** (`48-50`, cero llamadas en todo el proyecto): estaba pensado para «limpiar al arrancar», pero la rama `n===1` de `append` ya lo cubre.
7. El `limitKB` que pasan los llamadores no es uniforme: `main.js:84` usa `settings.engine.logLimitKB`; `emulator.js:576` usa `logLimitKB * 4` (y además `Math.max(2048, ...)`): el mismo ajuste se amplifica ×4 en dos sitios; tenlo en cuenta al leer el número en la página de ajustes.

### Quién lo llama
- `append`:
  - `src/main.js:85` (`appLog()`, `limit = store.getSettings().engine.logLimitKB || 2048`, véase `main.js:84`)
  - `src/core/emulator.js:577` (`_logWrite()`, `limit = max(2048, logLimitKB*4)`, véase `emulator.js:576`)
  - Ojo: en ambos casos se hace `require('./logfile')` **dentro de la función** (carga diferida), no arriba del módulo
- `rotate`: `logfile.js:39` (él mismo), `test/auto-test.js:1408`
- `trimNow`: nadie
- Pruebas: `test/auto-test.js:1405`

### Cobertura de pruebas
- `test/auto-test.js:1404` «el log rota automáticamente al superar el límite y conserva una sola copia»: escribe 300 KB, llama a `rotate(f,256)` y asevera que el archivo pasa a ser `rot.1.log`.
- Huecos: la ruta de contador/rotación automática de `append` (`n===1`, `n%200`) no tiene casos; `trimNow` tampoco; ni la ruta de pérdida de datos con nombres que no son `.log`.

---

## 10. Apéndice: `src/core/display.js` (también un módulo de utilidad pura)

Aunque no pertenece a la cadena de análisis, es otro módulo pequeño de `src/core` «de cálculo puro sin dependencias y con pruebas unitarias»; conviene conocerlo al hacerse cargo.

- **Responsabilidades**: cálculo puro de adaptación de pantalla (sin Electron/adb): rectángulos de ventana para pantalla completa/ventana y resolución Android (`display.js:2-6`).
- **Interfaz**: `densityFor(w,h,manual)` → number (si manual>0, limita a 120..640; si no, `min(w,h)/2.57` limitado a 200..480, `7-10`); `portraitSize(str)` → `{w,h}` (regex `^(\d{3,4})x(\d{3,4})$`; si no es vertical o se sale de rango, cae a `900x1600`, `12-18`); `defaultBounds(area)` → `{x,y,w,h}` (84 % de altura, ancho = alto·9/16, centrado, `20-28`); `fullscreenBounds(portrait,area)` (llena la altura, calcula el ancho según la proporción vertical y centra horizontalmente, `36-46`); `sizeFor(mode,portrait,area)` (`55-57`).
