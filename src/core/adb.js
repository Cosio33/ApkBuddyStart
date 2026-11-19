'use strict';
/**
 * Cliente adb encapsulado.
 * Solo hace la parte que apkstart necesita: instalar / arrancar / detener / desinstalar / sincronizar archivos / captura de pantalla.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

/**
 * Densidad lógica del diseño de tableta.
 * 720 de ancho ÷ (190/160) = 606dp ≥ 600dp, justo por encima del punto de corte de tableta de Android;
 * con 320dpi (valor por defecto de la imagen) solo hay 360dp, que es diseño de móvil.
 */
const TABLET_DENSITY = 190;
function tabletDensity() {
  try {
    return (store.getSettings().display || {}).tabletMode !== false ? String(TABLET_DENSITY) : 'reset';
  } catch (_) {
    return String(TABLET_DENSITY);
  }
}

/**
 * Ubicaciones posibles de adb en el sistema. **A propósito solo se listan Android SDK y directorios habituales de instalación manual**:
 * los adb incluidos en emuladores de terceros (MuMu / LDPlayer / BlueStacks) no están aquí — usarlos heredara el estado de server
 * ajeno (puerto, autorización, tartaleos de offline), en conflicto con «funcionar de forma independiente».
 * Nuestra copia de adb está en el directorio de runtime y siempre tiene prioridad máxima (véase engine.adbPath).
 */
const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:/Android/platform-tools/adb.exe',
  'C:/adb/adb.exe',
];

/**
 * Traducir la causa original del fallo de pm install a un texto comprensible para el usuario.
 * Se conserva el código de error original al final, para facilitar la búsqueda al diagnosticar.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Error de instalación: esta aplicación solo incluye bibliotecas nativas ARM (es lo habitual en muchas apps chinas),\n            '
      + 'La imagen actual no incluye una capa de traducción ARM. ApkBuddyStart cambiará automáticamente a una imagen compatible con la nueva capa integrada y lo reintentará.',
    INSTALL_FAILED_OLDER_SDK:
      'Error de instalación: la aplicación requiere una versión de Android superior a la del entorno actual (se necesita una imagen de sistema más reciente).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Error de instalación: el APK no tiene una firma válida; no se puede instalar.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Error de instalación: la firma no coincide con la versión instalada; desinstala la anterior antes de continuar.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Error de instalación: ya hay instalada una versión superior; no se puede degradar.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Error de instalación: poco espacio en el disco del entorno; libera espacio e inténtalo de nuevo.',
    INSTALL_FAILED_INVALID_APK:
      'Error de instalación: archivo APK dañado o incompleto (puede que la descarga no terminara); vuelve a obtenerlo.',
    INSTALL_FAILED_INVALID_URI: 'Error de instalación: la ruta del APK contiene caracteres especiales; muelelo a una ruta solo en inglés y reinténtalo.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Error de instalación: ya existe una aplicación con el mismo nombre pero otra firma; desinstálala primero.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Error de instalación: la firma no coincide con la versión instalada; desinstala primero la anterior.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Error de instalación: la aplicación apunta a una versión muy antigua de Android (targetSdk demasiado bajo); Android 14 bloquea la instalación por defecto.'
      + 'ApkBuddyStart reintentará automáticamente con el parámetro de omisión oficial.',
    INSTALL_FAILED_TEST_ONLY: 'Error de instalación: es un paquete de solo pruebas; se ha añadido automáticamente el parámetro de test y se ha reintentado.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Error de instalación: la aplicación depende de características del dispositivo (como bibliotecas de un fabricante) ausentes en este entorno.',
    INSTALL_FAILED_USER_RESTRICTION: 'Error de instalación: el sistema bloqueó la instalación; reinicia el entorno e inténtalo de nuevo.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Error de instalación: conflicto con el ContentProvider de otra aplicación; desinstala la aplicación en conflicto.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Error de instalación: error interno del sistema (habitualmente poco espacio o arranque incompleto); reinicia el entorno e inténtalo de nuevo.',
  };
  const msg = table[tag];
  return msg ? `${msg}（${tag}）` : `Error de instalación:${raw}`;
}

/** Traducir el log de cierre tras arrancar a una causa comprensible */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'Aplicación'} Se cierra tras iniciar: la capa de traducción ARM no es compatible con el manejo de señales de esta aplicación.`
      + 'ApkBuddyStart cambiará automáticamente a la imagen compatible con Android 14 y lo reintentará.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'Aplicación'} Se cierra tras iniciar: faltan bibliotecas nativas del dispositivo (la aplicación podría ofrecer solo versión ARM).`
      + 'Se cambiará automáticamente a una imagen compatible con capa de traducción ARM y se volverá a intentar.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'Aplicación'} Se cierra al iniciar (excepción interna de la aplicación, posiblemente relacionada con el entorno del emulador o la falta de servicios de Google).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'Aplicación'} Error al iniciar: el sistema rechazó la solicitud de inicio (problema de permisos o firma).`;
  }
  return `${pkg || 'Aplicación'} no se pudo iniciar${t ? `：${t.slice(0, 240)}` : '(el proceso no está activo)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Analizar la columna state de un serial concreto en `adb devices`.
 * Clave: un dispositivo unauthorized también informa 'device' en `get-state`; solo la columna state de la lista devices
 * distingue authorized / unauthorized / offline — la detección del arranque se autorrepara rápidamente con esto.
 */
function parseDeviceState(text, serial) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\s+(unauthorized|offline|recovery|sideload|no\s+permissions|device)\b/i.exec(line.trim());
    if (!m) continue;
    if (serial && m[1] !== serial) continue;
    const st = m[2].toLowerCase().replace(/\s+/g, '');
    if (st === 'device') return 'device';
    if (st === 'unauthorized' || st === 'nopermissions') return 'unauthorized';
    return st; // offline / recovery / sideload
  }
  return 'no-device';
}

/** Reconocer como unauthorized un error de shell provocado por no confirmar el diálogo «Permitir depuración USB» */
function isUnauthorizedError(raw) {
  return /\bunauthorized\b|no permissions|confirm.*(allow|debug)/i.test(String(raw || ''));
}

/** Extraer la ruta real de cada APK de la salida de `pm path <pkg>` */
function parsePmPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^package:/.test(l)).map((l) => l.slice(8).trim()).filter(Boolean);
}

/** Entradas de arranque ya resueltas (adbPath|pkg → activity), válidas 10 minutos */
const LAUNCHER_CACHE = new Map();

/**
 * La versión Windows de adb maneja mal las rutas no ASCII (usuario en chino / directorio de descargas en chino es muy común).
 * Antes de instalar se copia el APK a un directorio temporal ASCII puro y se borra al terminar.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Convertir el «Activity» en el componente completo que necesita am start -n.
 * Hay que admitir dos formas:
 *   - nombre de clase puro (lo que guardaban los apps.json antiguos): `MainActivity` / `.MainActivity` → `<pkg>/<activity>`
 *   - componente completo (salida de `cmd package resolve-activity`): `com.a.b/.Main` → se usa tal cual
 * La implementación anterior concatenaba sin más `${pkg}/${activity}` y, con un componente completo, daba `pkg/pkg/class`;
 * am start lo cancelaba (result code=-92) y el síntoma era «al pulsar el icono solo se ve el escritorio de Android».
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Extraer de la salida de `cmd package resolve-activity --brief` el componente perteneciente a pkg (tolera líneas vacías / de priority al final) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * El tope de tiempo de espera de adb install era fijo de 240 s, pero un paquete de más de 2 GB en un disco lento
 * «push + instalación + dexopt» supera fácilmente los 4 minutos: al agotarse se daba por fallo,
 * y el usuario veía «el paquete grande se quedó sin respuesta / falló». Aquí se escala con el tamaño del paquete, tope 20 minutos.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Analizar la salida de `find -exec stat -c '%Y|%s|%n'`.
 * Devuelve null si la salida no parece de stat (el dispositivo no lo admite).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Hay salida pero no se puede analizar ninguna línea → no es formato stat
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // Proceso `adb shell` residente
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // Se deja a PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
    // La imagen de Play Store fuerza la autorización ADB: el servidor adb del host y el adbd del guest deben usar la misma
    // adbkey. El procedimiento oficial es que adb/emulator compartan %USERPROFILE%\.android\adbkey{,.pub} y
    // emulator hornea adbkey.pub en /data/misc/adb/adb_keys del guest al arrancar.
    // Se dice explícitamente al servidor adb dónde encontrar la clave pública: en algunos entornos ANDROID_SDK_HOME / runtime portable
    // hacen que adb busque la clave en otro sitio y entonces cada arranque en frío muestra «Permitir depuración USB» → device unauthorized.
    if (!env.ADB_VENDOR_KEYS) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const keyDir = path.join(home, '.android');
      try { if (home && fs.existsSync(keyDir)) env.ADB_VENDOR_KEYS = keyDir; } catch (_) { /* ignore */ }
    }
    return env;
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Se comparte el puerto de servidor adb exclusivo con el emulador del runtime (5044 por defecto), aislado del
        // adb de WSA / emuladores de terceros en el 5037, para evitar que el registro sea expulsado una y otra vez y el dispositivo quede offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // El motivo del fallo de adb install va en stdout y el código de salida es distinto de 0;
          // las versiones anteriores solo miraban stderr y el usuario siempre veía un «fallo» vacío.
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} error: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Canal de entrada residente.
   * La rueda / el volver son entradas de alta frecuencia: ejecutar un adb por cada muesca de rueda lanza un montón de procesos
   * y el escritorio se nota claramente tirones. Aquí se reutiliza un único `adb shell`, un comando por línea, y al final
   * se hace echo de una marca de fin — así se sabe cuándo terminó realmente el comando y se forma contrapresión natural,
   * sin que los comandos de desplazamiento se apilen en una larga cola en el shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // La línea debe ser exactamente igual a la marca: algunos shells repiten toda la línea de comando,
          // y usar contains confundiría «recién escrito» con «ya ejecutado», apilándose los desplazamientos.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* Se ignora: la información de dispositivo offline la cubre el llamador */ });
    p.stdin.on('error', () => { /* Al desconectarse, exit se encarga de limpiar */ });
    p.on('error', () => { this._failWaiters(new Error('adb shell no pudo iniciarse')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell se ha cerrado'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Ejecutar un comando input de la lista blanca; si falla, se recicla la sesión y el llamador puede recurrir a un adb de un solo uso */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Comando de entrada no válido');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('El comando input ha agotado el tiempo de espera'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Canal de entrada cerrado'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* Puede estar ya conectado */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state no se puede usar sin especificar serial; se degrada a la lista devices
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  /**
   * Leer el estado real de este serial en `adb devices`: device / unauthorized / offline / no-device.
   * El get-state que usa isOnline() no distingue authorized de unauthorized (ambos son 'device');
   * la detección del arranque usa este método para identificar «el diálogo de autorización está atascado» y autorrepararse rápido.
   */
  async deviceState() {
    try {
      const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
      return parseDeviceState(stdout, this.serial);
    } catch (_) {
      return 'no-device';
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Instalar un APK suelto, con degradación automática:
   *  - por defecto se quita -g (conceder todos los permisos automáticamente hace que PermissionController se caiga en algunas imágenes);
   *  - se incluye --bypass-low-target-sdk-block para sortear el rechazo de Android 14 a apps con targetSdk antiguo;
   *  - si la versión de adb no reconoce el parámetro / hay rutas chinas / hay errores de transferencia, se cambia la forma y se reintenta;
   *  - con NO_MATCHING_ABIS se lanza un error con code para que la capa superior cambie automáticamente a una imagen compatible.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`El APK no existe: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g concede permisos de ejecución automáticamente y evita diálogos de autorización en la app; si alguna imagen no lo admite, se quita solo
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* Si no se puede obtener el tamaño, se usa el valor por defecto */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // El adb antiguo no reconoce el parámetro nuevo / la marca de paquete de prueba → se cambia de forma
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // Errores de transferencia (dispositivo desconectado, reinicio del servidor adb): se reintenta una vez
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // No se obtuvo un código de error claro: se prueba la última forma
        }
      }
      const err = new Error(friendlyInstallError(last || 'Error de instalación, no se obtuvo una razón clara'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Los APK divididos (varios fragmentos extraídos de .apks / .xapk) usan install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('No hay APK fragmentados que se puedan instalar');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('Error al instalar el APK dividido');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // Algunos dispositivos requieren especificar el usuario
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  /**
   * ¿Se instaló de verdad? No se confía en la palabra de PackageManager.
   *
   * Cuando la instantánea y la partición de datos no concuerdan, `pm path` devuelve
   * `package:/data/app/.../base.apk` (installed=true) porque packages.xml conserva el registro,
   * pero ese archivo APK ya fue revertido. Seguir con `am start` solo fallará. Por eso se usa `test -f/-s`
   * para comprobar uno a uno las rutas que informa pm; si el archivo no está (o está vacío) se decide que «no está realmente instalado»
   * y se deja a la capa superior reinstalar automáticamente.
   *
   * @returns {Promise<boolean>}
   */
  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    const paths = parsePmPaths(out);
    if (!paths.length) return false;
     // Todos los fragmentos APK deben estar; si falta uno, no arranca. Se unen en un solo shell para ahorrar una ida y vuelta de adb.
    const checks = paths.map((p) => `[ -s "${p}" ]`).join(' && ');
    const probe = await this.shell(`${checks} && echo __APKSTART_PRESENT__`, { timeout: 10000 }).catch(() => '');
    return /__APKSTART_PRESENT__/.test(String(probe));
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Resolver del sistema el Activity de arranque real (respaldo cuando no se puede analizar en el manifiesto) */
  /** Tras actualizar una app, el punto de entrada puede cambiar: se quita este paquete de la caché antes de resolverlo */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Resolver el Activity de entrada cuesta una ida y vuelta de adb (~200-400 ms) y no cambia durante una sesión de arranque.
    // Se cachea: la segunda vez que se pulsa la misma app se salta; caduca sola a los 10 minutos y reinstalar no usa una entrada obsoleta.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* Se recurre a monkey */ }
    return null;
  }

  /** ¿La app sigue realmente viva? Que am start devuelva éxito ≠ que el proceso no se haya caído */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Sin un log de cierre no se puede afirmar el fallo: algunas apps grandes tardan 20-40 s en arrancar la primera vez
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Arrancar la app, con tres niveles de degradación:
   *   ventana freeform independiente → pantalla completa normal → respaldo monkey;
   * cada vez se comprueba si el proceso sigue vivo y, si se cae, se captura logcat y se lanza un error con code para que la capa superior cambie de imagen.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Hay que usar el punto de entrada LAUNCHER resuelto por el sistema, no solo el Activity principal analizado del APK:
    // muchas apps (como Hongguo, drama corto) hacen la inicialización real en la pantalla de arranque; entrar directo al Activity principal
    // lanza "had you called RpcService.init" y el síntoma es que al abrir parpadea y desaparece.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved puede ser un componente completo (pkg/class) o solo un nombre de clase (apps.json antiguo);
    // aquí se unifica al componente completo que quiere am start -n, para que el sistema no cancele un pkg/pkg/class.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}
(la aplicación aún se está cargando)`;
      lastError = alive.crash || lastError;
      // Si el log de cierre apunta claramente a la capa de traducción ARM, no se reintenta y se pasa directo a la capa superior para cambiar de imagen compatible
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // Respaldo monkey: con algunas imágenes, am start -a/-c/-p no resuelve el launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Si hay información de cierre clara se usa primero; si no, se conserva el error de arranque original
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Activar la compatibilidad freeform (ventana independiente); si falla, no afecta al flujo principal */
  async ensureFreeform() {
    // Se combinan en un solo adb shell: 4 execFile independientes en Windows tardan más de 600 ms,
    // y ese rato cae justo dentro de la espera de «abrir la app».
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // El ls -l de Android tiene dos formatos (con group y sin group), y la fecha puede ser
      // "2026-11-12 18:52" o "Nov 12 18:52"; una regex fija no analizaría ninguno.
      // El segundo número tras los permisos es el tamaño del archivo, y el último tramo es el nombre.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // El nombre de archivo va después del token «hora:minuto» (la fecha ocupa 2-3 tokens, no fijo)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Listado remoto con mtime real (stat de toybox).
   * La fecha del ls -l es «mes día hora:minuto» y no se puede convertir de forma fiable, lo que haría que la sincronización creyera «cambió cada vez».
   * Devuelve null si el dispositivo no admite stat; el llamador debe recurrir a listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Borrar los datos de la app */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** Exportar los datos de la app (en Windows / versión de depuración se puede usar run-as; si no, se recurre a adb backup) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Conceder de una vez los permisos de ejecución que pide la app.
   * Si no se conceden, pasan dos cosas: ① el primer arranque muestra el cuadro de autorización del sistema y el usuario ve «la app no se abrió»;
   * ② tras borrar datos (pm clear) los permisos se pierden y la app se queda atascada en la página de autorización.
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // Salir de la sección de runtime permissions
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Se envían todas las autorizaciones juntas: una llamada a pm grant por permiso tarda más de 150 ms en Windows,
    // y cuatro o cinco permisos son 1 segundo, cuando estos comandos no tienen ninguna dependencia entre sí.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Los permisos especiales van por appops, o seguiría saliendo el diálogo
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    return granted;
  }

  /**
   * Llegar al estado «es esta app»:
   *  - cerrar la pantalla de bloqueo, para que al arrancar no se quede en ella tapando la app;
   *  - ocultar la barra de estado (se conservan los botones de navegación inferiores para poder pulsar volver/inicio sin el ratón a mano);
   *  - desactivar las animaciones del sistema, que en máquinas modestas cambia muchísimo la sensación de fluidez.
   * Todo son comandos de settings, unos cientos de ms cada uno, y repetirlos no hace daño.
   */
  async prepareForeground() {
    // Antes se enviaban 7 comandos en serie, cada uno levantando un proceso adb nuevo (150~250 ms en Windows),
    // en total 1~1,7 s cargados en la espera de «abrir la app». Con un solo shell queda una única ida y vuelta.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Verificación de conexión: Android usa connectivitycheck.gstatic.com por defecto para decidir «si hay internet de verdad»,
      // y en China no se conecta, así que el sistema marca siempre la red con «!» (conectado pero sin acceso a internet),
      // y algunas apps se declaran solas offline y se niegan a cargar contenido. Se cambia a un endpoint nacional que devuelve 204.
      // Se escribe en cada arranque (idempotente, dentro de un solo shell, coste casi cero), para que incluso al restaurar una instantánea antigua
      // o si el usuario cambió a mano los ajustes del sistema, se corrija automáticamente.
      'settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_mode 0',
      // Ojo: aquí no hay que escribir wm user-rotation / accelerometer_rotation.
      // La orientación la fija de forma unificada setOrientation / resetDisplayOverrides según el estado actual horizontal/vertical;
      // escribir aquí un lock 0 fijo sobrescribiría la orientación horizontal devolviéndola a vertical (imagen tumbada).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Mapeo de botón derecho / botones laterales / atajos: usa el canal de entrada residente; el volver con derecho ya no tiene latencia del orden de 100 ms */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Justo después de reiniciar el runtime, si el shell residente aún no conectó, se recurre a un adb de un solo uso; no se puede perder este clic
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Cambiar entre «diseño de móvil / diseño de tableta».
   *
   * Clave: **nunca cambiar wm size**. Cambiar wm size altera el tamaño físico del framebuffer del guest
   * (720x1280 -> 1280x720), pero la ventana Qt incrustada conserva su tamaño/orientación anterior, y la imagen sale
   * aplastada o tumbada 90°, con el mapeo de coordenadas del ratón también desordenado. Peor aún: la sobreescritura de wm size
   * queda persistida en /data y sigue actuando tras el reinicio — esa es la raíz de que el usuario vea una y otra vez «bordes negros / sin llenar / no se puede pulsar».
   *
   * Ahora solo se cambia la densidad lógica (wm density) y el framebuffer siempre es 720x1280 en posición vertical:
   *   - 320dpi -> smallestWidth 360dp -> diseño de móvil
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> diseño de tableta / dos columnas
   * No cambian tamaño, orientación ni mapeo de clics, así que no se tumba, no hay bordes negros y los clics siempre corresponden.
   */
  async setOrientation(landscape) {
    try {
      // La rotación automática debe estar desactivada (si no, el sensor gira la imagen sin control).
      await this.shell('settings put system accelerometer_rotation 0; wm size reset', { timeout: 15000 });
      // Bloqueo de orientación **0** (no 1). La orientación del panel físico ya la decide hw.lcd.width/height
      // (véase doctor.lcdFor); bloquear 1 aquí equivaldría a girar otra vez el panel horizontal a un espacio lógico vertical,
      // y la imagen saldría tumbada 90° — justo la causa directa de «la horizontal no quedó bien».
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      // Paso clave: apps como Hongguo declaran portrait por su cuenta y el sistema obedece, de modo que
      // un panel horizontal init=1280x720 se convierte en un espacio lógico vertical cur=720x1280 y la imagen se tumba otra vez.
      // Solo activando «Ignorar las solicitudes de orientación de la app» dispone el sistema según la orientación del panel.
      // En modo vertical hay que desactivarlo explícitamente, o un true residual de la vez anterior haría que el panel vertical
      // mostrara un diseño horizontal. Con API < 31 el comando no existe; se ignora el fallo.
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Al activar freeform / ignorar solicitudes de orientación, Android muestra una vez la guía «See and do more»
      // ("Double-tap outside an app to reposition it…"). Se pone encima de la app y el usuario piensa que el programa se rompió.
      // Aquí se marca previamente como ya confirmada y, como respaldo, se pulsa una vez volver.
      await this.shell('settings put secure freeform_mode_confirmations confirmed', { timeout: 10000 });
      if (landscape) await this.shell('input keyevent KEYCODE_BACK', { timeout: 8000 });
      await this.shell(`wm density ${tabletDensity()}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Al arrancar se limpian las sobreescrituras de wm size / density que dejaron versiones antiguas (persisten en /data y tumban la imagen) */
  async resetDisplayOverrides(landscape = false) {
    try {
      // La density debe fijarse **antes de arrancar la app**.
      // Antes aquí se hacía `wm density reset` sin más y luego _healOrientation (1,8 s después de arrancar / cada 60 s) volvía a poner 190:
      // eso era un cambio de configuración «con la app ya en marcha». Las apps que cachean DisplayMetrics (Modu es una)
      // recalculan los dp con la densidad antigua y la imagen se reduce a un bloque pequeño arriba a la izquierda, con gran espacio en blanco a la derecha,
      // que es lo que el usuario describe como «Modu no llena la ventana». Ahora se reajusta aquí junto con size y en la ruta de arranque no hay cambios de densidad a mitad.
      await this.shell(`wm size reset; wm density ${tabletDensity()}`, { timeout: 15000 });
      await this.shell('settings put system accelerometer_rotation 0', { timeout: 15000 });
      // Se mantiene coherente con setOrientation: manda la orientación del panel y la orientación lógica queda bloqueada en 0.
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Garantizar que en el guest haya un método de entrada para escribir en chino.
   *
   * La imagen de sistema (versión Google Play) solo trae LatinIME (teclado inglés), y el paquete de idioma chino de Gboard
   * hay que descargarlo de internet, lo cual es muy poco fiable en el emulador. Por eso se incluye un método de entrada Pinyin de AOSP
   * (assets/PinyinIME.apk, con bibliotecas nativas x86_64), que se instala y activa en silencio tras el arranque.
   *
   * Idempotente: si ya está instalado se omite; si el usuario cambia a mano el teclado por defecto, no se lo fuerza de vuelta.
   *
   * @param {string} apkPath ruta absoluta de PinyinIME.apk
   * @param {object} [o] { setDefault } si se pone como teclado por defecto (true por defecto)
   * @returns {Promise<{ok:boolean, installed?:boolean, ime?:string, reason?:string}>}
   */
  async ensureChineseIme(apkPath, { setDefault = true } = {}) {
    const IME_PKG = 'com.android.inputmethod.pinyin';
    const IME_ID = IME_PKG + '/.PinyinIME';
    // El nombre del componente se fija pero se comprueba su existencia: `ime list -s` solo enumera los teclados **activados**, y usar eso para decidir
    // «está instalado o no» daría un falso «servicio no registrado» justo después de instalar, y nunca se llegaría a ime enable.
    // Lo correcto es comprobar si el paquete está instalado y confirmar el nombre del componente con `ime list -a`.
    const pkgInstalled = async () => {
      const out = await this.shell(`pm list packages ${IME_PKG}`, { timeout: 10000 }).catch(() => '');
      return String(out).indexOf('package:' + IME_PKG) >= 0;
    };
    const findEnabledIme = async () => {
      const out = await this.shell('ime list -s', { timeout: 10000 }).catch(() => '');
      return String(out).split('\n').map((s) => s.trim()).find((s) => s.indexOf(IME_PKG) === 0) || '';
    };
    try {
      let installed = await pkgInstalled();
      let justInstalled = false;
      if (!installed) {
        if (!apkPath || !fs.existsSync(apkPath)) {
          return { ok: false, reason: 'Falta el APK del método de entrada' };
        }
        await this.install(apkPath);
        installed = true;
        justInstalled = true;
        // Tras instalar, se espera a que el gestor de paquetes registre el paquete
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          installed = await pkgInstalled();
          if (installed) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!installed) return { ok: false, justInstalled, reason: 'Paquete del método de entrada no registrado' };
      // Activar y poner como teclado por defecto (secure settings se puede escribir, no hace falta root).
      // Se ejecuta siempre: al restaurar una instantánea antigua puede perderse la marca enabled, o el usuario cambió el teclado por defecto.
      const cmds = [`ime enable ${IME_ID}`];
      if (setDefault) cmds.push(`settings put secure default_input_method ${IME_ID}`);
      await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
      const ime = await findEnabledIme();
      return { ok: !!ime, installed: justInstalled, ime: ime || IME_ID };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Garantizar que el idioma del sistema sea chino simplificado.
   * persist.sys.locale es una propiedad de solo lectura protegida por SELinux y no se puede cambiar en tiempo de ejecución (da
   * "Failed to set property"); lo que realmente surte efecto es la inyección con -prop al arrancar emulator.
   * Lo que se hace aquí es la parte posible: fijar el locale a nivel de app y la zona horaria para que la interfaz pase a chino enseguida y la hora sea correcta.
   */
  async ensureChineseLocale(locale = 'zh-CN') {
    const cmds = [
      'settings put system system_locales ' + locale,
      'setprop persist.sys.timezone Asia/Shanghai',
      // Formato de 24 horas + formato de fecha habitual en chino
      'settings put system time_12_24 24',
    ];
    await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
    return true;
  }

  /** Resolución lógica actual (al cambiar a horizontal, la ventana calcula su relación de aspecto según ella) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** Si el diálogo de autorización sigue delante (autorreparación incluso sin el usuario delante), se pulsa volver para cerrarlo */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Adaptación de pantalla: con pantalla completa se cambia la resolución de Android al tamaño del monitor (el contenido llena solo),
   * y en modo ventana se restaura la preconfiguración vertical. Los comandos wm surten efecto en tiempo de ejecución, sin reiniciar Android.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity, parseDeviceState, isUnauthorizedError, parsePmPaths,
};
