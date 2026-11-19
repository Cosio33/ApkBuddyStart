'use strict';
/**
 * Guardia de ejecución independiente: el instalador **no debe contener** ningún archivo de emuladores de terceros.
 *
 * ¿Por qué se necesita una comprobación en tiempo de compilación?
 *   El instalador de ApkBuddyStart (NSIS / portátil / MSIX) debe funcionar desde el primer momento: incluye emulator +
 *   platform-tools + imágenes de sistema; tras instalar ya funciona, sin exigir que el usuario instale antes MuMu / LDPlayer / BlueStacks.
 *   Desde la 0.5.6 va más lejos: **en el código no hay ninguna base de terceros**; lo instalado no es "runtime integrado + reutilización opcional",
 *   sino "solo el runtime integrado". Por eso aquí se bloquean tanto los binarios como el código fuente de los adaptadores de bases de terceros
 *   (backends/mumu.js / backends/fydeos.js / mumu-compat.js): si alguien los vuelve a añadir,
 *   la compilación falla de inmediato, para evitar que "quede en el código otro camino para tomar el control de un emulador ajeno".
 *
 *   Esta restricción puede romperse en silencio: por ejemplo, copiar el directorio de MuMu como runtime en build/runtime,
 *   o meter localmente un directorio de emulador en resources antes de empaquetar. Entonces la aplicación sigue funcionando en la máquina de desarrollo,
 *   pero el usuario, tras instalar, se encuentra con que "hay que instalar otro emulador": el problema solo se manifiesta en otros equipos.
 *   Por eso se escanean los nombres de archivo antes de empaquetar y, si hay coincidencia, la compilación falla directamente.
 */

const fs = require('fs');
const path = require('path');

/**
 * Si estos nombres aparecen en el resultado del empaquetado, significa que se ha metido "un emulador ajeno".
 * Solo se comparan los nombres de archivo característicos de cada emulador, sin patrones amplios como /android/, para evitar falsos positivos.
 */
const BANNED = [
  { re: /^mumu/i, vendor: 'Emulador MuMu' },          // MuMuManager.exe / MuMuPlayer.exe / MuMuVMMVbox
  { re: /\.nemu$/i, vendor: 'Emulador MuMu' },        // Archivo de descripción de instancia MuMuPlayer-12.0-0.nemu
  { re: /^nemu$/i, vendor: 'Emulador MuMu' },         // Directorio nemu de MuMu
  { re: /^nx_main$/i, vendor: 'Emulador MuMu' },      // Directorios nx_main / nx_device de MuMu
  { re: /^nx_device$/i, vendor: 'Emulador MuMu' },
  { re: /^ldplayer/i, vendor: 'Emulador LDPlayer' },
  { re: /^dnplayer/i, vendor: 'Emulador LDPlayer' },
  { re: /^bluestacks/i, vendor: 'Emulador BlueStacks' },
  { re: /^hd-player/i, vendor: 'Emulador BlueStacks' },
  { re: /^mgalaxy/i, vendor: 'Emulador MEmu' },
];

/** Solo estas extensiones cuentan como "cuerpo del emulador"; .js/.md/.json son código y configuración y no entran en el bloqueo */
const BINARY_EXT = /\.(exe|dll|sys|nemu|vdi|vmdk|vbox|iso|msi|bin|dat|db|img)$/i;

/**
 * Buscar recursivamente archivos/directorios que coincidan.
 * @param {string} dir directorio raíz a escanear (normalmente resources/runtime o el directorio app generado al empaquetar)
 * @param {object} [opts] { limit } cuántas coincidencias antes de detenerse (20 por defecto, suficiente para avisar)
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findBundled(dir, { limit = 20 } = {}) {
  const hits = [];
  const walk = (d) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return; // Sin permisos / no existe: se trata como si no hubiera nada
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const hit = BANNED.find((b) => b.re.test(e.name));
      // Los directorios cuentan directamente; los archivos deben parecer binarios (si no, backends/mumu.js en el código se confundiría con el cuerpo de MuMu)
      if (hit && (e.isDirectory() || BINARY_EXT.test(e.name))) {
        hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.vendor });
        continue; // Si coincide un directorio, no se sigue explorando dentro; es más útil reportarlo
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

/**
 * Código fuente de adaptadores de bases de terceros (si aparece en el resultado, significa que se ha reintroducido la capacidad de "reutilizar emuladores ajenos").
 * Son archivos .js, que no están en BINARY_EXT, por eso se comprueban por separado.
 */
const BANNED_SOURCE = [
  { re: /^mumu\.js$/i, what: 'Adaptador de base MuMu' },
  { re: /^fydeos\.js$/i, what: 'Adaptador de base FydeOS' },
  { re: /^mumu-compat\.js$/i, what: 'Estrategia de compatibilidad MuMu' },
  { re: /^frame\.js$/i, what: 'Comprobación de fotogramas MuMu' },
];

/**
 * Buscar código de bases de terceros en el resultado del empaquetado.
 * Solo se reconocen "backends/xxx.js" o esos nombres de archivo directamente bajo src/core, para no afectar a otros frame.js.
 * @param {string} dir
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findForbiddenSource(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const dirName = path.basename(d);
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
      const hit = BANNED_SOURCE.find((b) => b.re.test(e.name));
      if (!hit) continue;
      // Solo se aceptan estas ubicaciones concretas: mumu|fydeos bajo backends/, mumu-compat / frame bajo core/.
      // Los archivos con el mismo nombre en otros lugares (por ejemplo frame.js en la capa de renderizado) no se bloquean, para evitar falsos positivos.
      const suspicious = dirName === 'backends' || (dirName === 'core' && !/^builtin\.js$/i.test(e.name));
      if (suspicious) hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.what });
    }
  };
  walk(dir);
  return hits;
}

/**
 * Afirmar que el directorio no contiene emuladores de terceros.
 * @param {string} dir
 * @param {object} [opts] { label, exit } label se usa para el aviso; exit=false solo devuelve el resultado sin terminar el proceso
 * @returns {{ok: boolean, skipped?: boolean, hits: Array}}
 */
function assertStandalone(dir, { label = 'resultado del empaquetado', exit = true } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true, hits: [] };
  const hits = findBundled(dir).concat(findForbiddenSource(dir));
  if (!hits.length) return { ok: true, hits: [] };

  const vendors = [...new Set(hits.map((h) => h.vendor))].join(' / ');
  console.error(`\n[Guardia] ${label} contiene emuladores de terceros (${vendors}):`);
  for (const h of hits) console.error(`  - ${h.path}`);
  console.error('');
  console.error('El instalador de ApkBuddyStart debe incluir su propio runtime y funcionar de forma independiente: no puede depender ni incluir otros emuladores,');
  console.error('tampoco se permite reintroducir código de adaptadores que "tomen el control de emuladores ajenos".');
  console.error('Elimina del directorio de empaquetado las rutas anteriores y vuelve a intentarlo.\n');
  if (exit) process.exit(4);
  return { ok: false, hits };
}

module.exports = { BANNED, BANNED_SOURCE, findBundled, findForbiddenSource, assertStandalone };
