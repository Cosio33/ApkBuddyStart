'use strict';
/**
 * Limpiar restos de versiones anteriores.
 *
 * Al actualizar ApkBuddyStart es habitual encontrarse con «varias versiones instaladas y una desinstalación incompleta»: cada cambio de versión portable deja un directorio
 * ApkBuddyStart-vX.Y.Z-win64-portable; la instalación NSIS puede dejar entradas de desinstalación que apuntan a directorios ya borrados;
 * y el proceso de actualización deja un montón de paquetes temporales en el directorio de datos.
 *
 * Aquí solo se hace una limpieza «demostrablemente segura»:
 *   - Solo se reconocen directorios de versiones antiguas que contengan de verdad «ApkBuddyStart.exe», y nunca se toca el que se está ejecutando ahora;
 *   - Solo se eliminan entradas de desinstalación del registro cuyo «InstallLocation» ya no existe (son entradas muertas);
 *   - Solo se borran los archivos temporales de nuestra propia caché de actualizaciones y los accesos directos del menú Inicio/escritorio que apuntan a destinos inexistentes.
 * Ante la menor duda en cualquier paso, se omite y se devuelve el motivo a la interfaz con total transparencia.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkBuddyStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* Ocupado o sin permisos, se omite */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Buscar directorios de versiones antiguas entre varios directorios «donde podría estar el programa».
 *
 * Antes solo se exploraba el directorio padre del exe actual + LOCALAPPDATA\Programs + ProgramFiles, y si el usuario descomprimía la versión portable
 * en otro sitio (E:\Descargas, el escritorio, algún directorio de proyecto) nunca se encontraba: esa es precisamente la razón de
 * «no se pueden limpiar las versiones antiguas de otras carpetas». Ahora se usa descubrimiento por varias vías:
 *   - Ubicaciones de instalación habituales;
 *   - Niveles superficiales de la raíz de cada disco (muchas versiones portable se dejan directamente en D:\ApkBuddyStart-…);
 *   - El directorio real del exe al que apuntan los accesos directos existentes en el escritorio / menú Inicio (el más fiable: si el usuario lo instaló, tiene que estar ahí).
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // Varias ubicaciones frecuentes bajo el directorio principal del usuario
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // Raíz de cada disco local (las versiones portable suelen estar directamente en la raíz)
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * Encontrar el directorio real de ApkBuddyStart.exe a partir de un acceso directo (.lnk / .desktop).
 * Es el método de descubrimiento más fiable: si el usuario creó alguna vez un icono de escritorio o una entrada en el menú Inicio,
 * la ruta de destino está dentro, esté en el disco que esté y en la carpeta profunda que sea.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkBuddyStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkBuddyStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // El .lnk es binario, pero la ruta de destino va incrustada en forma legible; se busca directamente ApkBuddyStart*.exe en los bytes
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkBuddyStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkBuddyStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkBuddyStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* No se puede leer, se omite */ }
    }
  }
  return [...dirs];
}

/** Directorio de programa de versión antigua: con forma ApkBuddyStart*, que contenga ApkBuddyStart.exe y que no sea el directorio de instalación actual */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Debe ser un directorio «realmente de ApkBuddyStart», para evitar borrar por error carpetas con el mismo nombre
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'Directorio del programa de la versión anterior (incluye ' + EXE + '）',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkBuddyStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // Directorios encontrados mediante accesos directos: pueden ser en sí una versión antigua, o serlo su directorio padre/hijo
  for (const d of rootsFromShortcuts()) {
    if (/^ApkBuddyStart/i.test(path.basename(d))) consider(d);
    // También se miran los hermanos (bajo dist suelen estar varias versiones en paralelo)
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkBuddyStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Entradas de desinstalación del registro que apuntan a directorios que ya no existen */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkBuddyStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // La salida de reg query viene por bloques «clave → valor»; se divide por bloques
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkBuddyStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Solo se tratan entradas muertas: «ya no está instalado pero sigue colgando en la lista de aplicaciones»
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Elementos de desinstalación no válidos${disp ? `：${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** Caché de actualización / paquetes temporales */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkBuddyStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkBuddyStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'Archivos temporales de la actualización' });
    }
  }
  return out;
}

/** Instantáneas de arranque rápido antiguas o en desuso: default_boot la dejaron las primeras versiones (un ram.img de unos 3 GB),
 *  *.stale-* son restos de «no se pudo borrar y se renombró». El nombre actual de la instantánea es apkstart, que jamás se toca. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // Instantánea en uso actualmente
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'Instantánea de arranque rápido residual de una versión anterior' : 'Restos obsoletos de instantáneas',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Doble seguridad: nunca se borra el directorio que se está ejecutando ahora
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'Esta es la versión que se está ejecutando actualmente' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'No hay archivos en' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Archivo en uso (puede haber una ventana abierta)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Archivo en uso' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Error al eliminar' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
