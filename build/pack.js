'use strict';
/**
 * Empaquetado portátil: genera dist/ApkBuddyStart-win64-portable/
 *   ApkBuddyStart.exe (electron.exe renombrado + icono y recursos de versión escritos) + resources/app (código de esta aplicación)
 * Sin instalador: se descomprime y se usa directamente.
 *
 * --full (o APKSTART_PACK_FULL=1) genera la "versión completa":
 *   copia además build/runtime en resources/runtime; al descomprimir funciona y el primer inicio no descarga nada.
 *   El directorio de salida por defecto es dist/ApkBuddyStart-v<versión>-win64-full y no sobrescribe la versión ligera.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertStandalone } = require('./guard-standalone');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const FULL = process.argv.includes('--full') || process.env.APKSTART_PACK_FULL === '1';
// Permite especificar el directorio de salida (para compilar en otro sitio y reemplazar después si una instancia en ejecución ocupa el destino)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', FULL ? `ApkBuddyStart-v${PKG.version}-win64-full` : 'ApkBuddyStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log(FULL ? 'Empaquetando versión completa (con runtime) →' : 'Empaquetando versión portátil →', OUT);
// Si el destino ya existe, no se borra el árbol completo: algunos entornos bloquean las eliminaciones masivas y un fallo a mitad de empaquetado perdería
// la última versión funcional. En su lugar, se renombra el directorio antiguo para conservarlo y se compila desde cero; si está ocupado, se cambia de directorio automáticamente.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Versión anterior conservada →', backup);
  } catch (_) {
    // Algunos entornos (antivirus / indexador de búsqueda / Explorador de archivos) mantienen el directorio abierto mucho tiempo,
    // y renombrar el directorio completo da EBUSY; entonces se usa un directorio con número de versión, igual de válido y sin colisión de nombres.
    OUT = path.join(ROOT, 'dist', `ApkBuddyStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Directorio antiguo ocupado; se cambia la salida a →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Runtime de Electron
console.log('Copiando el runtime de Electron…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Reducción de paquetes de idioma: Electron trae 55 idiomas (41 MB en total) y solo usamos la interfaz en chino.
//     Se conservan solo zh-CN / zh-TW / en-US y se borran los demás (-39 MB, unos 15 % menos de paquete).
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* No tener el directorio locales tampoco afecta */ }

// 1.2 Archivos que nadie abre: registros de cambios, símbolos de depuración y algunos pak inútiles (0,1~9 MB cada uno)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Bibliotecas de ejecución que se pueden omitir:
//     d3dcompiler_47.dll compila el HLSL de ANGLE a instrucciones de GPU, pero desde Windows 8.1
//     System32 ya incluye una DLL con el mismo nombre; si LoadLibrary no encuentra la del paquete, usa la del sistema.
//     En pruebas, tras borrarla la interfaz, los iconos y las fuentes se renderizan perfectamente (las capturas --smoke no muestran diferencias). Ahorra 2,1 MB.
//     Atención: vk_swiftshader.dll / vulkan-1.dll no se pueden borrar: si el controlador GPU no está disponible, Chromium
//     las usa como respaldo por software; borrarlas deja la pantalla en blanco.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* No estaba presente de antemano */ }
}

// 2. La aplicación en sí
// assets/ contiene los recursos distribuidos con el paquete: PinyinIME.apk (teclado chino), que se instala silenciosamente en Android
// durante el arranque mediante Runtime.prepare(). Si falta, el usuario no podrá escribir en chino.
console.log('Copiando la aplicación…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'assets', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Directorios opcionales
// Bajo engine/ solo se distribuye contenido documental; los componentes pesados del runtime (emulator, system-images,
// platform-tools, avd) los descarga la aplicación automáticamente de fuentes oficiales en el primer inicio y no entran en el instalador.
// tools/ contiene scripts de autocomprobación para desarrollo (pruebas en consola y mediciones); el usuario no los necesita y ya no se distribuyen.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 3.5 Versión completa: añadir también el runtime (emulator + platform-tools + imágenes de sistema)
if (FULL) {
  const runtime = path.join(ROOT, 'build', 'runtime');
  const runtimeExe = path.join(runtime, 'emulator', 'emulator.exe');
  if (!fs.existsSync(runtimeExe)) {
    console.error('\n[!] No se encuentra build/runtime/emulator/emulator.exe.');
    console.error('    Ejecuta primero node build/prepare-runtime.js (npm run runtime) para generar el runtime y luego empaqueta la versión completa.\n');
    process.exit(1);
  }
  console.log('Runtime integrado (unos 1 GB, tardará un momento)…');
  fs.cpSync(runtime, path.join(OUT, 'resources', 'runtime'), { recursive: true });
}

// 3.6 Guardia de ejecución independiente: el resultado no debe contener MuMu / LDPlayer / BlueStacks ni otros emuladores de terceros.
// Si hay coincidencia, la compilación falla: estos problemas solo aparecen en "ordenadores ajenos" y nunca se detectan en local.
assertStandalone(path.join(OUT, 'resources'), { label: 'resources de la versión portátil' });

// 4. Renombrar el ejecutable principal
const exePath = path.join(OUT, 'ApkBuddyStart.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

/**
 * Escribir el icono y los recursos de versión en ApkBuddyStart.exe.
 *
 * Por qué hay que hacerlo: un exe simplemente renombrado sigue siendo Electron por dentro:
 * FileDescription=Electron, ProductName=Electron, CompanyName=GitHub, Inc.,
 * versión 33.4.11 e icono de Electron también. Así, el Explorador de archivos, los accesos fijos de la barra de tareas,
 * las propiedades de los accesos directos y el antivirus/la información del sistema muestran "Electron" y el icono por defecto,
 * y el usuario ve "el icono es el de por defecto".
 *
 * rcedit es la misma herramienta que usan electron-builder / electron-winstaller,
 * aquí se usa directamente la copia ya presente en node_modules, sin necesidad de internet.
 */
function embedExeMeta(exe) {
  const rcedit = [
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ].find((p) => fs.existsSync(p));
  if (!rcedit) {
    console.warn('  [!] No se encuentra rcedit.exe; el icono y la versión del exe conservan los valores de Electron');
    return false;
  }
  const ico = path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico');
  if (!fs.existsSync(ico)) {
    console.warn(`  [!] No se encuentra ${ico};se omite la escritura del icono`);
    return false;
  }
  const args = [
    exe,
    '--set-icon', ico,
    // Versión de archivo de cuatro segmentos (igual que en MSIX); la versión de producto usa tres segmentos
    '--set-file-version', `${PKG.version}.0`,
    '--set-product-version', PKG.version,
    '--set-version-string', 'ProductName', 'ApkBuddyStart',
    '--set-version-string', 'FileDescription', 'ApkBuddyStart - Ejecutor de aplicaciones Android',
    '--set-version-string', 'CompanyName', PKG.author || 'RoutineMiku',
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 ApkBuddyStart',
    '--set-version-string', 'OriginalFilename', 'ApkBuddyStart.exe',
    '--set-version-string', 'InternalName', 'ApkBuddyStart',
  ];
  try {
    execFileSync(rcedit, args, { stdio: 'pipe', windowsHide: true });
    console.log(`  Icono/versión del exe escritos (${PKG.version}, FileDescription=ApkBuddyStart - Ejecutor de aplicaciones Android)`);
    return true;
  } catch (e) {
    console.warn(`  [!] Error de rcedit: ${e.message}`);
    return false;
  }
}
embedExeMeta(exePath);

// 5. Información de versión
const pkg = PKG;
const fullNote = FULL ? 'Versión completa (runtime integrado, sin conexión tras instalar)' : 'Versión ligera (descarga el runtime en el primer inicio)';
fs.writeFileSync(path.join(OUT, 'VERSION.txt'),
  `ApkBuddyStart ${pkg.version}\n${fullNote}\nFecha de compilación:${new Date().toLocaleString('zh-CN')}\n`);

// 6. Informe de tamaño: se imprime en cada empaquetado para evitar que vuelva a crecer sin avisar
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Completado. Paquete completo ${totalMB.toFixed(0)} MB (los paquetes de idioma ahorraron ${(localeSaved / 1048576).toFixed(0)} MB,`
  + `las bibliotecas redundantes ahorraron ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Comprimir: node build/zip.js ' + path.relative(ROOT, OUT) + ' <salida.zip>');
console.log(`Ejecuta ${path.join(OUT, 'ApkBuddyStart.exe')} para usarla.`);
if (!FULL) console.log('Para la versión completa ("una descarga y sin conexión tras instalar"): node build/pack.js --full');
