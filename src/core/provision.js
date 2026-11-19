'use strict';
/**
 * Arranque automático del runtime (Provisioning).
 *
 * ApkBuddyStart no depende de ningún emulador de terceros: adb, QEMU y la imagen de sistema se descargan, verifican y gestionan por completo internamente.
 * Todos los archivos del runtime se ponen bajo %APPDATA%\apkstart\runtime, para garantizar que se puede escribir desde cualquier ubicación de instalación.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile, resolveZipEntry } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Índice oficial del SDK de Google: las direcciones reales de emulator y de las imágenes de sistema se resuelven dinámicamente aquí; no se fijan versiones
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Respaldo: versiones conocidas para usar cuando el índice no esté disponible
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Imagen compatible ARM (versión Google Play, con native bridge integrado)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): solo se usa si el usuario ya trae su propia ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // La edición ligera (sin runtime) obtiene aquí el «paquete completo de runtime»: el GitHub Release de este proyecto.
  // Antes, la edición ligera tenía que bajar por separado emulator / imagen de sistema de dl.google.com, y la red nacional se quedaba
  // a menudo en decenas de KB/s o incluso daba 404; al pasar al paquete completo + el GitHub de este proyecto, la fuente de descarga
  // y la de actualización son la misma, y si hay un problema basta arreglarlo en un solo sitio.
  ghReleaseApi: 'https://api.github.com/repos/RoutineMiku/apkstart/releases',
  ghReleasePage: 'https://github.com/RoutineMiku/apkstart/releases',
  // Espejo Gitee del mismo contenido: la conexión directa a api.github.com desde China a menudo tarda decenas de segundos, y Gitee suele responder en unos cientos de ms.
  // Se pregunta a ambos y se usa quien dé primero «la versión más alta con el paquete completo de runtime».
  giteeReleaseApi: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases',
  giteeReleasePage: 'https://gitee.com/daily-miku/apkstart/releases',
};

/**
 * Las <url> del índice del SDK son rutas relativas y la carpeta base varía:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * Por eso la carpeta base siempre se toma como «el directorio donde está el propio archivo de índice». Antes, usar directamente el nombre de archivo como URL lanzaba Invalid URL.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Se conserva una sola «imagen base universal».
 * La versión anterior traía por defecto AOSP API30 + una imagen opcional API34 Play de compatibilidad, lo que causaba:
 *   - los usuario que instalaban apps ARM chinas fallaban sí o sí y tenían que cambiar de imagen a mano (barrera de usabilidad);
 *   - dos imágenes de 0,6~3 GB cada una, con un directorio de runtime que fácilmente pasaba de diez GB;
 *   - cambiar de imagen exigía wipe-data y se perdían todas las apps instaladas.
 * Ahora se unifica en Android 14 Google Play x86_64: funcionan apps x86, apps ARM y GMS,
 * y en toda la máquina se guarda una sola capa base de solo lectura (compartida como un contenedor), que basta descargar una vez.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Sondeo de escribibilidad de un directorio (el resultado se cachea por directorio).
 *
 * ¿Por qué no usar fs.accessSync(dir, W_OK)? En Windows solo mira el atributo de archivo «solo lectura»,
 * no las ACL, y para C:\Program Files\WindowsApps\... (directorio de instalación MSIX) da un falsos
 * «se puede escribir», y entonces la expansión de .img.xz falla a mitad. Aquí se escribe de verdad un archivo de prueba y se borra.
 */
const _dirWritableCache = new Map();
function provisionDirWritable(dir) {
  if (_dirWritableCache.has(dir)) return _dirWritableCache.get(dir);
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.apkstart-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _dirWritableCache.set(dir, ok);
  return ok;
}

/**
 * Comprobación de integridad tras la descarga. Si no pasa, **se borra el archivo incompleto**.
 *
 * Antes aquí solo se lanzaba un error sin borrar el archivo, con lo que en tmp quedaba para siempre un zip a medias. La próxima vez,
 * download() veía el archivo existente y continuaba con Range; si el servidor / la fuente cambiaban, los bytes recibidos
 * no encajaban con la primera mitad, volvía a fallar y volvía a quedar un archivo a medias… lo que el usuario veía era «siempre vuelve a descargar».
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label}Descarga incompleta (${(size / 1048576).toFixed(1)} MB), se ha limpiado, inténtalo de nuevo`);
}

/**
 * Caché en disco del resultado del sondeo del entorno.
 *
 * `emulator -version` y `emulator -accel-check` tienen que arrancar un proceso de emulator cada vez y en Windows tardan 1~3 s medidos;
 * y estos dos resultados son constantes mientras «el motor / los controladores no cambien».
 * Antes solo se cacheaban 30 segundos en memoria, con lo que cada arranque en frío volvía a pagarlos, justo en el momento
 * en que el usuario pulsa la app. Aquí se hace huella con «tamaño + fecha de modificación del exe + fecha del controlador AEHD + componente WHPX»
 * y se guarda en %APPDATA%; al cambiar el software o el hardware caduca automáticamente.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // La conclusión «aceleración no disponible» solo se cree durante 10 minutos: puede que el usuario acabe de activar la virtualización

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Punto de entrada único para las dos fuentes / espejos (la caché de medición también está aquí, la comparten varios componentes) */
  get sources() {
    return this._sources;
  }

  /** Huella de caché: cambia la clave si cambia cualquier archivo del motor o el controlador de aceleración */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* Primera vez */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* Si no se puede escribir la caché, no afecta al flujo principal */ }
  }

  /** Se llama si el arranque falló (problemas de aceleración / imagen): se vuelve a sondear en el próximo arranque para no usar siempre una conclusión errónea */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Rutas ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // ¿Se puede escribir en el directorio de runtime?
    // La versión de Store (MSIX) pone emulator / platform-tools / system-images directamente en el paquete de instalación
    // (C:\Program Files\WindowsApps\...), que es de solo lectura:
    //   - fallarían la expansión in situ de .img.xz, la creación de _tmp y de qemu/;
    //   - pero ejecutar los binarios desde el paquete sí está permitido (y así se conserva la identidad de paquete,
    //     de modo que la vista virtualizada de %APPDATA% coincida con la del proceso padre).
    // Por eso hay que separar «se puede ejecutar» de «se puede escribir»: la ruta ejecutable sigue apuntando al paquete, y los datos
    // grabables (directorio de expansión de imágenes / AVD / directorios temporales) se redirigen todos al directorio de datos del usuario.
    const rootWritable = provisionDirWritable(root);
    // El AVD (con los datos de usuario, las apps instaladas y la instantánea quickboot) debe caer en un lugar escribible que no se limpie.
    // En las distribuciones de un solo archivo, el runtime se descomprime en un directorio temporal cada vez; poner el AVD ahí
    // equivaldría a perder las apps en cada salida. Mientras el directorio de runtime no esté en %APPDATA%, se fija el AVD al directorio de datos del usuario.
    // Además: se permite indicar por separado en Ajustes el «directorio de datos de Android», que es lo que realmente come disco
    // (partición de datos de 6~24 GB + instantánea de 2~3 GB); mover solo el runtime y no esto deja la unidad C igual de llena.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // ¿Dónde poner la imagen de sistema? **Primero el directorio de runtime**.
    // Antes el orden era «primero el directorio de datos del usuario», con esta consecuencia: el usuario cambia el runtime a la unidad D para ahorrar en C,
    // se descomprime el paquete de 1,4 GB en D, y materializeImages vuelve a expandir el system.img de 3,3 GB a
    // C://Users//...//AppData//Roaming//apkstart//system-images, y C sigue comiéndose, además de guardar la misma imagen en dos sitios
    // (medidos 1,2 GB + 3,3 GB a la vez). Ahora: si en el directorio de runtime ya están system-images (producto de descomprimir el paquete), se usa;
    // si no, se recurre al directorio de datos del usuario (así funcionan las versiones antiguas y las de un solo archivo).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Tres casos:
    //  1) ya hay una imagen en el directorio de runtime (producto de descomprimir el paquete) → se usa esa;
    //  2) usuarios antiguos / distribución de un solo archivo que pusieron la imagen en el directorio de datos del usuario → se usa la de allí;
    //  3) instalación nueva (no hay en ninguno de los dos) → cae en el directorio de runtime, porque el directorio de datos del usuario puede ser
    //     un directorio temporal redirigido (es el caso del CI al ensamblar el runtime; escribir ahí daría un fallo de verificación).
    //  4) el directorio de runtime es de solo lectura (dentro del paquete MSIX) → debe caer en el directorio de datos del usuario, o .img.xz no se puede expandir.
    let sysRoot;
    if (!rootWritable) sysRoot = dataImg;
    else if (fs.existsSync(rootImg)) sysRoot = rootImg;
    else if (fs.existsSync(dataImg)) sysRoot = dataImg;
    else sysRoot = rootImg;
    return {
      root,
      // Solo si se puede escribir se ponen los directorios temporales / auxiliares bajo root; si no, se usan siempre los del directorio de datos
      writeRoot: rootWritable ? root : path.join(store.DATA_DIR, 'runtime'),
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // Runtime del emulator (oficial de Google): root hace también las veces de ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'aehd'),
      imagesDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), '_tmp'),
      rootWritable,
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      // Se tolera fallo individual: en la versión de Store (MSIX), p.root está en el paquete de instalación de solo lectura y no se puede crear, es normal;
      // los directorios grabables ya se redirigieron todos al directorio de datos del usuario (véase paths()). Que falle uno
      // no debe hacer que toda la ruta de arranque lance un error.
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* Si está de solo lectura / ocupado, se omite */ }
    }
    return p;
  }

/**
 * Guardián de disco: antes de descargar / descomprimir un componente grande, se comprueba que la unidad de destino tiene espacio libre suficiente.
 * Si no, se descarga hasta reventar la unidad del sistema o la descompresión falla directamente (y deja archivos a medias).
 * Se reserva 1 GB de margen: tras descomprimir el emulador / la imagen, la instantánea y la partición de datos siguen creciendo.
 * @param {string} component nombre del componente (determina la estimación de espacio necesario)
 * @param {string} targetDir directorio de escritura (para localizar la unidad)
 */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Paquete completo de runtime: 1,5 GB comprimido + imagen de ~3,3 GB expandida, ambos presentes en el pico
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // 1 GB adicional de margen (instantánea / partición de datos / archivos intermedios de descompresión)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Espacio insuficiente en el disco de destino: este componente necesita unos ${need + buf} MB, pero "${dir}」 el disco solo queda ${free} MB。\n`
        + 'Se recomienda cambiar la «Carpeta de datos del entorno de ejecución» a una unidad con más espacio (Ajustes → Integración del sistema → Carpeta de datos del entorno de ejecución → Examinar),'
        + 'O limpia primero el disco / desinstala las aplicaciones que no uses y vuelve a intentarlo.',
      );
    }
    return free;
  }

  // ---------------- Comprobación del entorno ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'Plataforma que no es Windows' }; return this._hypervisor; }
    // Solo se hacen comprobaciones de archivos a escala de ms. La respuesta autorizada sobre «si WHPX está realmente disponible»
    // la da emulator -accel-check; aquí se evita lanzar PowerShell (1-2 s en arranque en frío) que ralentizaría cada sondeo de estado.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // Lo sobrescribe emulatorAccel() con el valor real
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'El componente de plataforma de máquina virtual está presente (la disponibilidad la detecta el motor del entorno de ejecución)'
        : 'No se detectó el componente Windows Hypervisor Platform: puedes marcar «Plataforma de máquina virtual» en «Activar o desactivar características de Windows» y reiniciar',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // Caché de 30 s, para que el sondeo de estado no lance procesos externos constantemente
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // Ubicación de instalación por defecto de winget
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Verificar el descriptor de volumen principal ISO9660 ("CD001" en el desplazamiento 0x8001), para no tomar una página de error / un archivo a medias por una imagen */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'Sin descargar' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // Las imágenes raw / de disco ya instaladas que importa el usuario no llevan sector de arranque ISO; se dejan pasar por tamaño
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `El archivo solo tiene ${(size / 1048576).toFixed(1)}MB, descarga incompleta`
        : 'El archivo no es una imagen ISO9660 válida (puede que se descargara una página de error o que el archivo esté dañado)';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // La edición completa (con runtime integrado) trae una sola imagen API 34 Google Play, que es a la vez la imagen principal y la de compatibilidad;
    // ya no se depende del interruptor compatImage, evitando eso de «la imagen está pero como no marqué la casilla dice que no está desplegada»
    const playImage = this.playImageInfo();
    const compatReady = playImage.ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;
    // Lo que trae el paquete es .xz/.gz: la imagen «está», solo que aún no se ha expandido. La capa superior lo usa para decidir
    // «si hay que descargar por red» — si hay imagen, nunca se descarga, solo se expande.
    const needsExtract = !!(sysimg.compressed || (compatReady && playImage.compressed));

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'No instalado' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? playImage.size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        compressed: needsExtract,
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api}（${(sysimg.size / 1073741824).toFixed(2)} GB${sysimg.compressed ? '，versión comprimida, se extrae automáticamente al primer arranque' : ''}）`
          : (compatReady
            ? `Android ${PLAY_SYSIMG.api}（${playImage.compressed ? 'Versión comprimida incluida en el paquete; se expande automáticamente en el primer arranque' : 'Imagen compatible con ARM'}）`
            : (sysimg.note || 'Sin descargar')),
      },
      // true = la imagen está en local (en el paquete), solo hay que expandirla una vez; la capa superior **prohíbe** cualquier descarga por red
      needsExtract,
      playImage,
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'Sin descargar',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'Aún no creado',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Descargando Android platform-tools (aprox. 8MB)…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'Paquete de instalación de adb');

    onProgress({ stage: 'extract', message: 'Descomprimiendo adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb no se puede ejecutar tras descomprimirlo; comprueba si el antivirus lo está bloqueando');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} listo`, percent: 100 });
    return v;
  }

/**
 * Descomprimir con el parser ZIP propio (evita depender de herramientas de descompresión del sistema).
 * Las entradas grandes (system.img de nivel GB) van en flujo y las pequeñas se leen enteras, para no chocar con el límite de Buffer único de Node.
 */
  // ---------------- Paquete completo de runtime del GitHub de este proyecto (edición ligera) ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

/**
 * Resolver la dirección de descarga del «paquete completo de runtime».
 * Convenio de nombre de asset: ApkBuddyStart-runtime-<tag>.zip (lo genera .github/workflows/release.yml,
 * y su contenido es el build/runtime de siempre: emulator/ + platform-tools/ + aehd/ + system-images/).
 * Se barren tanto GitHub como Gitee y se toma la versión más alta; si no se encuentra, se lanza un error para que la capa superior
 * recurra a la descarga por componentes oficial de Google.
 */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const pref = String(store.getSettings().runtime.sourcePreference || 'auto');
    const apis = [];
    if (pref !== 'gitee') apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });
    if (pref !== 'github') apis.push({ api: SOURCES.giteeReleaseApi, page: SOURCES.giteeReleasePage, name: 'Gitee' });

    // Se pregunta a ambos en concurrencia; el fallo de uno no afecta al otro
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const hit = (rel.assets || []).find((x) => /^ApkBuddyStart-runtime-.*\.zip$/i.test(x.name || ''));
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} inalcanzable`).join('、');
      throw new Error(`Ninguna de las dos fuentes tiene el paquete completo del entorno de ejecución${errs ? `（${errs}）` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

/**
 * Despliegue de un clic de la edición ligera: descarga el paquete completo de runtime desde el GitHub de este proyecto y lo descomprime.
 * La imagen de sistema viene en el paquete como .xz y materializeImages() la expande en el primer arranque (solo una vez).
 */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Primero se da una línea de progreso: la fase de buscar versión + medir velocidad no tiene bytes, y sin aviso el usuario pensaría «se colgó».
    onProgress({ stage: 'download', message: 'Obteniendo información de la versión del entorno…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Seleccionando la fuente de descarga más rápida (${pack.from || 'GitHub'} · ${pack.tag}）…`, percent: 1 });
    // Candidatos = sitio original + prefijo de espejo. Primero se bajan 128 KB de cada uno para medir la velocidad real y decidir cuál usar:
    // «adivinar por dominio» suele fallar en la práctica — la misma dirección va a 30 KB/s por la mañana y a 5 MB/s por la noche.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Descargar el entorno de ejecución (unos 1.5 GB, solo una vez,${conn} hilos)…`, percent: 2 });
    // La descarga por bloques en paralelo (8 hilos) es mucho más rápida que un solo flujo: limitar una sola conexión de GitHub es habitual,
    // un solo flujo da solo uno o doscientos KB/s medidos, y con 8 hilos se llena el ancho de banda local. Si se corta, vuelve a un solo flujo desde el punto de corte.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · quedan aprox. ${Math.ceil(pr.eta / 60)} minutos` : '';
        onProgress({
          stage: 'download',
          message: `Descargando el entorno de ejecución ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'Paquete completo del entorno de ejecución');

    onProgress({ stage: 'extract', message: 'Extrayendo el entorno (unos 1 minuto)…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Descomprimiendo ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* Si no se puede escribir la marca, no afecta al uso */ }

    // El system.img del paquete completo viene comprimido en .xz (igual que en la edición instaladora). Se expande aquí mismo,
    // o si no, justo después checkEnv() creería que «no hay imagen de sistema» y bajaría otra de 1,4 GB de Google.
    // Si la expansión falla, el despliegue tiene que fallar y llevar el motivo: la versión anterior lo capturaba como 0 y el usuario veía
    // el progreso parado en el 99 % y luego saltar a «completar con la fuente oficial», descargando otra vez 1,4 GB en vano.
    onProgress({ stage: 'extract', message: 'Extrayendo la imagen del sistema (unos 1 minuto, solo una vez)…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Entorno listo', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

/**
 * Direcciones candidatas de descarga: primero la conexión directa, luego los prefijos de espejo.
 * Se pasa por Sources para que el manejo sea unificado: «el espejo automático (ghfast / gh-proxy)» y el prefijo personalizado del usuario
 * se mantengan en un solo sitio y puedan compartir la misma caché de medición con la descarga multiproceso.
 */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Los paquetes grandes (emulator / imagen de sistema) van por la versión de archivo: no se lee el zip de 1,5 GB entero en memoria
    // y hasta una máquina con poca memoria descomprime de forma estable; los pequeños siguen por la versión en memoria, que es más rápida.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        // Guardián anti zip-slip (issue #2 P0-4): el paquete de runtime viene de la red y los nombres de entrada no son de fiar.
        // Tanto las entradas de directorio como las de archivo deben ser rutas relativas válidas dentro de destDir.
        const target = resolveZipEntry(destDir, name);
        if (!target) {
          if (opts.onUnsafeEntry) opts.onUnsafeEntry(name);
          continue;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (runtime oficial de Google) ----------------

  /** Obtener un fragmento de texto XML (con límite de tamaño; el archivo de índice pesa unos 400 KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    // issue #2 P1-1: si se supera el límite, destroy() no emite 'end' y el error no se captura,
    // y esta Promise nunca termina, con lo que el asistente de despliegue se queda para siempre en «Analizando el índice».
    // Se usa un cerrojo de un solo uso + un tiempo de espera duro, para que cualquier ruta se resuelva una sola vez.
    return new Promise((resolve) => {
      let d = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { try { res.destroy(); } catch (_) {} finish(); }, 30000);
      res.on('data', (c) => {
        if (done) return;
        d += c;
        if (d.length > limit) {
          d = '';                       // El contenido que supera el límite no es utilizable; no se tome un índice a medias por uno completo
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
  }

  /** Resolver dinámicamente del índice del SDK la dirección del paquete emulator de Windows más reciente */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* Se recurre al respaldo */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Resolver del índice sys-img la dirección de la imagen AOSP por defecto */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* Se prueba el siguiente índice */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Si la sesión anterior ya sondeó y los archivos del motor no cambiaron, se usa directamente el resultado guardado (ahorrando un proceso de más de 1 s)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

/**
 * Extraer la imagen comprimida que viene en el paquete al directorio del usuario en el primer arranque (solo una vez).
 * En la distribución de un solo archivo, system.img es .gz (3,1 GB → unos 580 MB); sin expandirla el emulador no sirve.
 * Se expande a %APPDATA% y no al paquete: en la edición portable el directorio de runtime es un directorio temporal nuevo en cada arranque,
 * y ponerla ahí equivaldría a descomprimirla otra vez en cada arranque.
 */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // El destino de la expansión debe usar el mismo conjunto de reglas que paths().sysImgRoot, o saldría una duplicidad de
    // «el paquete se descomprime en D pero la imagen vuelve a expandirse en C, en APPDATA» (medidos 1,2 GB + 3,3 GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // Los archivos que no son la imagen comprimida (kernel-ranchu / ramdisk / .img sin comprimir, etc.) también deben caer en el directorio de expansión
    const found = new Map(); // dest -> job (si conviven .xz/.gz de la misma imagen, se prefiere .xz)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Se admite .img.xz (LZMA2, un ~25 % más pequeño que .gz) y el antiguo .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Primero se reponen los archivos que no son imágenes (el emulador usa kernel-ranchu etc. para localizar/arrancar; si faltan, avisa de «falta la imagen de sistema»)
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // Se expande in situ, sin copiar
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Error al copiar los componentes de la imagen:${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // Para decidir si «ya se expandió» no basta con mirar los 32 MB: la versión antigua no tenía .part y, si se interrumpió, pudo dejar
      // cientos de MB de imagen a medias; con solo pasar el umbral se daba por terminada y el arranque reventaba con «imagen de sistema dañada».
      // Una imagen real, una vez descomprimida, siempre es más grande que el archivo comprimido, así que «más pequeña que el comprimido» = desde luego no terminó.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Primero se descomprime a .part y solo después se renombra: una expansión interrumpida (cerrar el programa / corte de luz / disco lleno)
      // no deja un system.img a medias «que parece terminado», porque si no, la próxima vez se saltaría la expansión y el arranque
      // moriría con imagen dañada, y el usuario tendría que borrar datos y empezar de cero.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`Primer arranque: expandiendo la imagen del sistema ${path.basename(j.dest)}(aprox. 1 minuto, solo una vez)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2: hay que importar directamente el enlace nativo index.js.
            // El punto de entrada por defecto del paquete, main.js / xz.js, hace require('stream-polyfill.mjs') por dentro,
            // y el Node 20 de Electron no admite require(ESM) y lanza un error; además exports no permite escribir directamente
            // '@napi-rs/lzma/index.js', así que se usa require.resolve para localizar el directorio y se importa por ruta de archivo.
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // No se puede seguir tragando el error: quien llama (despliegue / arranque) debe saber
        // que la imagen no se expandió; si no, se descargarían otros 1.4 GB de la fuente oficial
        // o el arranque fallaría directamente.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Error al expandir la imagen: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`Error al expandir la imagen del sistema (${failures.join('；')}）`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    // La imagen por fin se expandió: limpia la marca de error de despliegue anterior.
    // Si no, un deployFailedAt heredado de arranques fallidos mantendría autoDeploy en
    // enfriamiento 30 min aunque la imagen ya esté lista, sin volver a intentar arrancar
    // — el usuario ve «instalado pero no funciona».
    try {
      if (Number(store.getSettings().runtime.deployFailedAt || 0)) {
        store.saveSettings({ runtime: { deployFailedAt: 0 } });
        if (typeof onLog === 'function') onLog('Marca de error de despliegue anterior eliminada; se reanudan los reintentos automáticos');
      }
    } catch (_) { /* no se puede escribir la configuración; no afecta al resultado */ }
    return done;
  }

/**
 * ¿Está completa la imagen de sistema?
 *
 * «Completa» tiene dos formas:
 *   1. `system.img` ya expandido (caché local / directorio de runtime indicado por el usuario en Ajustes);
 *   2. **`system.img.xz` / `.gz` incluido en el paquete** — la versión de Store (MSIX) y el instalador completo
 *      son de esta forma, y materializeImages() lo expande in situ en el primer arranque.
 *
 * El caso 2 debe contar como ok, o checkEnv().ready sería false y autoDeploy pensaría que
 * «el usuario aún no bajó la imagen» e iría a buscar por red una de 1,5 GB — esa es justo la raíz de «aunque ya se instaló con imagen,
 * sigue descargando». La marca compressed del valor devuelto indica que «hay que expandirla una vez más».
 */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Primero se busca en la ubicación por defecto (API34 Play) y luego se recurre a «cualquier imagen».
    // La distribución de un solo archivo puede traer solo una imagen AOSP más pequeña; fijar API34 haría que
    // aunque la imagen esté en el paquete se avise de «no descargada» y el usuario se vea obligado a bajar una nueva por red.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    let packed = null;   // Solo se encontró el archivo comprimido: sigue contando como «hay», pero hay que expandirlo
    for (const dir of candidates) {
      const kernel = path.join(dir, 'kernel-ranchu');
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      // Primero el ya expandido
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi, compressed: false };
      }
      // Luego se reconoce el comprimido (la forma habitual de las imágenes incluidas en el paquete)
      if (fs.existsSync(kernel)) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            if (!packed) packed = { ok: true, dir, size: cs, api, tag, abi, compressed: true, file: name };
            break;
          }
        }
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'La imagen está incompleta' : 'Falta system.img' };
      }
    }
    // Si hay un archivo comprimido, se usa: hay que expandirlo, pero **no falta la imagen**; nunca debe disparar una descarga por red
    if (packed) return packed;
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'Sin descargar' };
  }

/**
 * Estado de la aceleración por hardware.
 * En Windows, emulator admite dos tipos de aceleración: WHPX (función del sistema, requiere reinicio) y AEHD (controlador propio de Google, listo al instalarlo).
 */
  async emulatorAccel() {
    // El sondeo de estado se hace cada pocos segundos y -accel-check tiene que arrancar un proceso de emulator, hay que cachearlo
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'emulator no está instalado' };

    // Caché en disco: en arranque en frío no se arranca un proceso de emulator para esto.
    // La conclusión «no disponible» solo se cree 10 minutos — puede que el usuario acabe de activar la virtualización / instalar AEHD y hay que reflejarlo enseguida.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'Aceleración por hardware WHPX activada' : 'Aceleración por hardware AEHD activada' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Algunos paquetes de runtime recortados omiten emulator-check.exe, con lo que -accel-check no puede dar una conclusión.
      // En ese caso, si el controlador AEHD está instalado, se trata como «disponible»: al arrancar, el emulator montará el controlador,
      // y así se evita que un falso «sin aceleración» fuerce -accel off (la simulación por software se cae directamente en algunas máquinas).
      result = { ok: true, kind: 'aehd', note: 'Aceleración de hardware AEHD activada (falta emulator-check, determinado según el controlador)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'Aceleración por hardware AEHD activada' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'Aceleración por hardware WHPX activada' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Aceleración de hardware desactivada: se usará la emulación por software (funciona, pero muy lento). Se recomienda instalar el controlador AEHD o activar «Plataforma de máquina virtual»',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Descargar e instalar emulator (el zip lleva emulator/ en el nivel superior, se descomprime directo en la raíz del SDK) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Descargando el motor del entorno de ejecución (aprox. 440MB, desde la fuente oficial de Google)…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando el entorno de ejecución ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'Motor del entorno de ejecución');

    onProgress({ stage: 'extract', message: 'Descomprimiendo el entorno de ejecución…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // La raíz del SDK debe tener también platform-tools, o el emulator se niega a arrancar
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('El emulator no se puede ejecutar tras descomprimirlo; comprueba si el antivirus lo está bloqueando');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Motor del entorno de ejecución ${v.version} listo`, percent: 100 });
    return v;
  }

  /** El emulator exige un directorio platform-tools bajo la raíz del SDK, o sale FATAL directamente */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Descargar e instalar una sola imagen base universal (Android 14 Play x86_64), ya no hay dos juegos «normal / compatible» */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** ¿Está ya instalada la imagen de compatibilidad ARM (versión Google Play)? */
  playImageInfo() {
    const p = this.paths();
    const rel = `android-${PLAY_SYSIMG.api}/${PLAY_SYSIMG.tag}/${PLAY_SYSIMG.abi}`;
    // Se miran dos sitios: el destino de la expansión (directorio de datos grabable) y la ubicación original en el paquete.
    // El instalador de Store / completo trae system.img.xz, que solo se expande en el primer arranque — aquí hay que
    // reconocerlo, o installSystemImage / autoDeploy irían a descargar otra por red.
    const dirs = [path.join(p.sysImgRoot, rel), path.join(this.root, 'system-images', rel)];
    let packed = null;
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'kernel-ranchu'))) continue;
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg) {
        return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: false };
      }
      if (!packed) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            packed = { ok: true, dir, size: cs, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: true, file: name };
            break;
          }
        }
      }
    }
    if (packed) return packed;
    const size = fileSize(path.join(dirs[0], 'system.img'));
    return { ok: false, dir: dirs[0], size, note: size ? 'La imagen está incompleta' : 'Sin descargar' };
  }

  /** Resolver la dirección de la imagen de Google Play (<url> relativa al directorio del archivo de índice) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* Se recurre al respaldo */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Descargar e instalar la imagen de compatibilidad ARM (versión Google Play, unos 1,5 GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Descargando la imagen compatible con ARM (Android 14, aprox. 1.5GB)…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando imagen compatible ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'Imagen compatible');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Descomprimiendo la imagen compatible (3 GB, tarda más de diez segundos)…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Descomprimiendo imagen compatible ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('Error de verificación tras descomprimir la imagen compatible');
    // La imagen de compatibilidad antigua (API 30) ya no se usa; una vez instalada con éxito, se limpia para liberar espacio
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'La imagen compatible con ARM está lista; reinicia el entorno de ejecución para que surta efecto', percent: 100 });
    return info;
  }

  /** Descargar el controlador AEHD (archivo pequeño); la instalación requiere permisos de administrador y se delega al asistente */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Descargando el controlador AEHD…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('Error al descomprimir el paquete del controlador AEHD');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'El controlador AEHD está listo; requiere permisos de administrador para instalarse', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Obtener el nombre del paquete de instalación más reciente del catálogo oficial (sin fijar número de versión) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* Se recurre a la fuente de respaldo */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Buscando la última versión de QEMU…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Descargando QEMU (unos 200 MB)…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'Paquete de instalación de QEMU');

    onProgress({ stage: 'install', message: 'Instalando QEMU (silencioso)…', percent: 96 });
    // qemu-w64-setup es un instalador NSIS: /S silencioso, /D indica el directorio (debe ir al final y sin comillas)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('No se encontró qemu-system-x86_64.exe después de instalar QEMU: puedes descargar QEMU manualmente y extraerlo en engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} listo`, percent: 100 });
    return v;
  }

  // ---------------- Imagen de sistema ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Descargando Android-x86 9.0-r2 (aprox. 900MB, descarga fragmentada en 8 hilos)…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando la imagen del sistema… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`Imagen del sistema no disponible: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? ', puedes hacer clic de nuevo para continuar la descarga desde donde se dejó' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `Imagen del sistema lista (${(info.size / 1073741824).toFixed(2)} GB）`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Verificar la imagen / ISO importada por el usuario */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('El archivo no existe o está vacío');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'Archivo de imagen no disponible');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Disco virtual ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Creando ${sizeGB}GB de disco virtual…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`Error de qemu-img al crear el disco virtual:${r.stderr || r.stdout}`);
    } else {
      throw new Error('No se encontró qemu-img.exe; instala QEMU primero');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Disco virtual creado', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- Comprobación previa de accesibilidad de la imagen de sistema ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
