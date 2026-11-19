'use strict';
/**
 * Motor del emulador: impulsa el Android Emulator oficial de Google como runtime de ApkBuddyStart.
 *
 * La mayor diferencia con la versión anterior: aquí ya no se asume que «un juego de parámetros funcione en todos los equipos».
 *  1. Se usan doctor.chooseProfile() para deducir los parámetros según memoria/CPU/disco/estado de aceleración/versión del motor;
 *  2. Si falla el arranque, planVariants() degraday reintenta automáticamente (backend GPU → simulación por software → arranque en frío con memoria mínima);
 *  3. Se elige un puerto libre dinámicamente, se limpian los bloqueos del AVD, las rutas chinas se convierten a rutas cortas y la instantánea se invalida al cambiar la imagen;
 *  4. Instantánea quickboot + partición de datos pequeña para «compartir una capa base de solo lectura como un contenedor» y recuperar en segundos.
 *
 * El callback probe lo aporta la capa superior (Runtime) y sirve para juzgar si Android está realmente listo.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * En Windows, traducir los códigos de salida de emulator/qemu a lenguaje humano.
 * 0xC0000005 (3221225477) es el más habitual en los cierres: violación de acceso y, en pruebas, suele deberse a que
 * el controlador de gráficos / el backend Vulkan se cae justo al arrancar el guest; basta con cambiar a renderizado por software.
 */
function describeExitCode(code) {
  // Cuando termina por señal, code es null (en Windows tanto taskkill como adb emu kill lo hacen así),
  // no se puede dar como 0 «salida normal», pero tampoco es una anomalía: se devuelve una cadena vacía para que el llamador lo muestre tal cual.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Salida normal';
    case 1: return 'Parámetros de arranque o entorno incorrectos';
    case 3221225477: return '0xC0000005 Violación de acceso; el backend de renderizado se cerró';
    case 3221225725: return '0xC00000FD Desbordamiento de pila';
    case 3221225781: return '0xC0000135 Falta una DLL (VC++ Runtime o componente eliminado por el antivirus)';
    case 3221225506: return '0xC0000022 Acceso denegado (problema de controlador o permisos)';
    case 3221225595: return '0xC000007B Desajuste de arquitectura o DLL dañada';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * Efecto de los controladores (parches de compatibilidad) aplicados en este arranque y la lista de los que coincidieron.
     * Lo rellena _resolveDrivers() desde start(); buildArgs / env / ensureAvd solo lo leen.
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // El ram.bin de la instantánea ≈ la memoria asignada a la máquina virtual (2-4 GB).
    // Una máquina que ya arranca rápido en frío no debería pagar varios GB de disco por esto: solo se guarda si «va realmente lento».
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Guardar en disco «el último fallo de arranque».
   * La versión anterior solo lo tenía en memoria (this.attempts); si el usuario reiniciaba ApkBuddyStart y luego exportaba el informe,
   * el informe salía con attempts: [] y bootLog: [] vacíos y había que buscar en los logs — causa directa de que en las
   * issues #20/#25 «se adjuntaba el informe pero no se veía la razón».
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* Si falla el guardado en disco, no afecta al flujo principal */ }
  }

  /** Leer el registro del último fallo (para el informe de diagnóstico / avisos antes del arranque) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe y el directorio de imágenes de sistema (primero el directorio de runtime del usuario, luego engine/ dentro del repositorio) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Elegir imagen: si hay una imagen universal (API 34 Play), se usa; no se pide al usuario que cambie de «modo compatible» */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Invalidar la instantánea quickboot.
   * La instantánea guarda a la vez la memoria y la imagen de disco; si tras instalar una app nueva / borrar datos se carga una instantánea antigua,
   * el usuario ve «la app que acabo de instalar desapareció al reiniciar».
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Limpiar los bloqueos que dejó una salida anómala anterior.
   * Ojo: hardware-qemu.ini.lock es un **directorio**, no un archivo; un rmSync(force) estilo bsdtar no lo puede borrar,
   * y entonces el emulador sigue avisando de "Running multiple emulators with the same AVD" y no arranca
   * (le pasa si lo mataron a la fuerza una vez); hay que borrarlo recursivamente.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* Si está ocupado, se omite y se limpia la próxima vez */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * ¿Hay realmente en el directorio del AVD una instantánea quickboot **completa**?
   * No basta con mirar si «el directorio no está vacío»: si se interrumpió un guardado, queda un cascarón con solo 12 bytes de snapshot.pb,
   * el emulator intenta cargarlo, falla (log "does not have the requested snapshot") y vuelve al arranque en frío,
   * perdiendo unos segundos en vano. Aquí se valida por tamaño de archivo y de paso se limpian los cascarones y el default_boot que dejó la versión antigua (un solo archivo de 3 GB).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // El emulator nuevo (37.x) escribe ram.bin; las versiones antiguas escriben ram.img.
    // Reconocer solo ram.img tiene consecuencias graves: una instantánea de 3 GB recién guardada se toma por un cascarón y se borra,
    // y entonces siempre se pasa -no-snapshot-load y se arranca en frío: la mitad de la causa de «la apertura es lenta».
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // El directorio no existía, no se borra nada en vano
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Limpiar directorios de instantánea que dejó la versión anterior / un renombrado fallido (el ram.img de default_boot puede llegar a 3 GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Matar emuladores huérfanos que ocupan el bloqueo del AVD.
   * emulator.exe es solo un lanzador; el qemu real se lanza como proceso independiente (detached),
   * así que matar solo el handle de proc que tenemos deja a menudo un huérfano ocupando multiinstance.lock,
   * y el próximo arranque da FATAL "Running multiple emulators with the same AVD".
   * Se limpia por dos fuentes: el pid del bloqueo del AVD y «qemu/emulator con este nombre de AVD en la línea de comandos».
   */
  /**
   * ¿Está el panel actual del AVD en horizontal o en vertical?
   *
   * ¿Por qué preguntar esto? El horizontal **solo se consigue con el panel físico**: `wm size` solo cambia la resolución lógica y la imagen se
   * tumba 90°; `adb emu rotate` solo gira el contenido y el sistema sigue en vertical. Lo que funciona de verdad es
   * intercambiar `hw.lcd.width/height` y reiniciar. Y como config.ini se escribe en cada arranque con los ajustes de ese momento,
   * leerlo dice qué orientación tiene **la máquina que está corriendo ahora**.
   *
   * @returns {boolean|null} true=panel horizontal, false=panel vertical, null=no se puede leer
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Ruta rápida (siempre se recorre en cada arranque en frío):
    //  - sin .lock → no puede haber un emulator vivo ocupando este AVD, se devuelve directamente;
    //  - con lock pero nadie escucha en el puerto → solo es un directorio residual de una matada anterior, se limpia.
    // Antes, fuera cual fuese el caso, se ejecutaba un wmic (1~3 s y muy comedor de CPU), lo que ralentizaba el arranque en frío.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) el pid que el propio emulator escribió en el archivo de bloqueo (lo más fiable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) respaldo: buscar qemu vivo por nombre de proceso + puerto (tasklist/netstat van un orden de magnitud más rápido que wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* Si no se consigue la lista de procesos, se confía solo en el pid del archivo de bloqueo */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Limpiar ${pids.size} proceso(s) residual(es) del emulador`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** ¿Hay algún puerto de consola de emulator escuchando entre 5554 y 5620? (una conexión rechazada vuelve al instante, coste mínimo) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Informe de controladores para la interfaz / el diagnóstico: cuáles se usaron, cuáles se omitieron y por qué.
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * Aplicar las sobreescrituras de config.ini que declara un controlador a la configuración por defecto.
   * Las claves existentes se sustituyen in situ (sin generar líneas duplicadas) y las que no existen se añaden al final.
   * Solo se procesan las claves de la lista blanca de drivers.js; las claves ilegales ya se rechazaron en la validación.
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = Object.keys(over);
    if (!keys.length) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !(m[1] in over)) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * Recorrer el directorio de controladores, elegir los que coinciden con esta máquina y guardarlos como el efecto de este arranque.
   *
   * El orden del directorio es la prioridad: primero los ejemplos integrados (solo lectura, enabled:false por defecto) y después los del usuario;
   * con el mismo id, el directorio del usuario sobrescribe al integrado: el usuario cambia el ejemplo y surte efecto directamente,
   * sin tener que tocar el directorio de instalación.
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* Si no se consigue, se toma como 0; los controladores cuya condición lleva osBuild no se aplicarán */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * Preparar el AVD: escribir config.ini. Se reescribe en cada arranque con la configuración automática actual, para que los reintentos con degradación surtan efecto al instante.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Resolución de pantalla: con aceleración por hardware, 720x1280@320 da imagen nítida y texto no borroso;
    // con simulación pura por software se baja a 540x960 y se priorizan fps (el área es solo el 56 % y la diferencia a simple vista es mucho menor que la de fluidez).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (compatible con ARM)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Se compara la «identidad de la imagen» y no la ruta absoluta: cambiar la misma imagen de disco / de directorio no cuenta como cambio de imagen,
      // o si no, con solo cambiar el directorio de runtime se borrarían todas las apps instaladas (véase el comentario de doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // El userdata antiguo no es compatible con la imagen nueva (bucle de arranque APEX), hay que reconstruirlo
        this.wipePending = true;
      }
    }

    // Cambió la huella de configuración → la instantánea quickboot antigua fallará al cargar o dará pantalla negra; se invalida a propósito.
    // Ojo: aquí solo se invalida la **instantánea**, jamás se puede hacer -wipe-data de paso: en los datos de usuario están las apps instaladas y las partidas.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* Primera vez */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // La eliminación puede ser bloqueada por el sistema / un antivirus (los directorios de instantánea suelen tener varios GB).
      // Si falla, se renombra para que el emulator deje de cargarla; nunca se interrumpe el arranque por un fallo de limpieza.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Solo «cambió la imagen» (tag / sysdir) exige -wipe-data: el userdata antiguo
    // no es compatible con la APEX de la imagen nueva y, sin reconstruirlo, se queda en un bucle de arranque. Cambiar capacidad / resolución / backend de render no cuenta.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch debe ser la ABI misma (x86_64 no se puede recortar a x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkBuddyStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // La versión anterior fijaba 16 G y generaba archivos gigantes en discos pequeños / con cuota, ralentizando el primer arranque
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // El Wi-Fi virtual debe activarse explícitamente. En la imagen Play de API 34, la red va por
      // wlan0 (la tarjeta virtual de netsim), no por el antiguo eth0. Si falta esta línea en config.ini,
      // el emulador no crea el enlace de wlan0: síntoma: wlan0 siempre NO-CARRIER,
      // `dumpsys connectivity` muestra Active default network: none y en la app sale siempre
      // «Error de red, inténtalo de nuevo». Los parámetros de línea de comandos -netdelay/-netspeed/-dns-server
      // son solo del NAT de usuario de QEMU y no tienen que ver con que la tarjeta interna del guest se haya levantado.
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // La instantánea la controla por completo el -snapshot apkstart de la línea de comandos: con un nombre propio, nunca se carga por error
      // el default_boot que dejó la versión anterior (era el estado de memoria de una imagen API30 y cargarlo entra seguro en bucle de arranque).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Los sensores de orientación / acelerómetro deben estar desactivados: si se activan, Android gira solo según el sensor y convierte
      // el contenido vertical en horizontal (imagen tumbada 90°, texto vertical, bordes negros). El cambio de diseño ahora solo depende de
      // wm density (cambia smallestWidth) y no necesita ni permite que intervenga el sensor.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // La partición /data debe «funcionar de verdad» primero, o todo lo demás es esperar en vano (véase el comentario de ensureDataPartition)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Garantizar que la partición userdata sea un ext4 **realmente utilizable** — es la base de «pulsar una app y entrar al escritorio en 30 s».
   *
   * ¿Por qué hay que hacerlo uno mismo? (tres razones, todas descubiertas a base de pruebas):
   *  1. El userdata.img del paquete de imagen de sistema es un marcador de 1 MB lleno de ceros; el formateo real lo hace avdmanager llamando al
   *     mke2fs del SDK. ApkBuddyStart escribe directamente config.ini y lanza emulator, saltándose ese paso → /data a ceros →
   *     el núcleo avisa "Invalid ext4 superblock on /dev/block/vdc" → el guest cae en un bucle de reinicio de recovery →
   *     adbd nunca sale → el probe de la capa superior sigue pendiente y acaba en timeout de 240 s. Síntoma anterior: había que esperar varios minutos al abrir.
   *  2. Los e2fsck/resize2fs que trae emulator son la versión cygwin de e2fsprogs 1.42.12 y **no conocen la característica encrypt**:
   *     con ese bit puesto salen con exit 8 y se niegan a trabajar, así que «ampliar el sistema de archivos» debe ir antes de poner el bit.
   *  3. El sistema de archivos debe ser ≥ el tamaño de la partición: con solo 64 MB, descomprimir APEX + dexopt lo llena al instante,
   *     y entonces todos los setxattr devuelven ENOSPC → no se pueden escribir las etiquetas SELinux → netd/media/tombstoned
   *     salen con exit 1 → el arranque se queda en la animación y adb siempre offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* No existe */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // Solo «no hay que tocar nada» si el archivo es suficientemente grande y el sistema de archivos realmente creció hasta ese tamaño.
      // Mirar solo el tamaño del archivo pasa por alto una avería real: qemu-img expandió el archivo pero resize2fs falló,
      // y entonces el archivo mide 6 GB y Android solo ve 64 MB — lo que el usuario ve es «al instalar un juego dice que falta espacio».
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // La capacidad configurada aumentó (o el sistema de archivos no creció lo suficiente): se amplía in situ, sin reconstruir y conservando las apps instaladas
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`Ampliación de userdata: archivo ${size} → ${wantBytes}, sistema de archivos ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Error al ampliar userdata (se sigue usando la partición actual):${e.message}`);
        // La partición antigua sigue siendo utilizable, pero hay que decirle con honestidad al llamador «esta vez no se amplió»; la página de ajustes no puede mostrar éxito
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // Primera vez / marcador de ceros que dejó una versión anterior / imagen dañada: se crea una nueva
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Primero sin el bit encrypt (así los e2fsck/resize2fs antiguos sí aceptan trabajar)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`userdata se ha reconstruido:${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (bloques de 4K, compatible con FBE)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Se hace lo posible: aunque falle la ampliación, se vuelve a poner el bit encrypt para que FBE pueda inicializarse (la partición se queda más pequeña)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Error al reconstruir userdata:${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** qemu-img.exe incluido en emulator: expande el archivo de imagen sin formato al tamaño objetivo (disperso, al instante)
   *  Ojo con el orden de los parámetros: `qemu-img <comando> -f raw <archivo> <tamaño>`.
   *  Poner -f antes del comando lo toma como parámetro global y da un error unrecognized option. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} error: ${(r.stderr || '').trim() || r.status}`);
  }

  /** resize2fs.exe incluido en emulator (versión cygwin; hay que ejecutarlo desde el directorio bin64 para que encuentre las DLL) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('Falta resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs falló: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator depende de estas variables de entorno para localizar el SDK / el AVD; las rutas chinas se convierten siempre a rutas cortas 8.3 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // El directorio del AVD debe coincidir con provisioner.paths().avdHome: con un runtime incluido de solo lectura (EXE junto a
    // resources/runtime), root/avd no existe ni se puede escribir, y el AVD debe ir al directorio de datos del usuario.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      // Variables de entorno declaradas por el controlador: solo se permiten los prefijos ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ (véase drivers.js)
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  /**
   * El idioma del sistema a inyectar. Por defecto, chino simplificado; el usuario puede cambiarlo en Ajustes (engine.locale),
   * y poner 'en-US' u 'off' vuelve al inglés nativo de la imagen.
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'zh-CN').trim();
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    // El controlador puede fijar el backend de renderizado / forzar simulación por software. Se pone al principio, dentro de gpu/accel,
    // para que toda la lógica posterior (-accel off, hw.gpu.mode de config.ini) siga esa decisión.
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: activado por defecto (para que se oigan los avisos / el sonido de los vídeos de las apps de Android).      // Solo se pasa -no-audio, ahorrando algo de CPU, si el usuario lo desactiva explícitamente en Ajustes.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Se desactiva el informe de cierres: si existe un informe de cierre anterior, emulator muestra un modal «Aceptar el envío»,
      // el hilo principal se queda bloqueado y nunca arranca (en el log se ve Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Red: el emulador AOSP va por defecto por el NAT de usuario de QEMU (-netdev user) y Android recibe
    // una dirección virtual 10.0.2.x, con la salida reutilizando directamente el NAT de la tarjeta física del host.
    // Este modo **no** crea ninguna tarjeta / conmutador virtual en Windows
    // (eso solo pasaría con -netdev tap o con puente, que nunca se activan).
    // Así, las apps de Android usan «un dispositivo detrás del NAT del host», intacto el stack de red del host,
    // sin instalar controladores ni añadir un adaptador de red.
    // Se declara explícitamente sin límite de velocidad: aunque el valor por defecto es full, algunas combinaciones -gpu / -net
    // le ponen la configuración conservadora del emulador y las apps de vídeo (Hongguo, Douyin) van claramente lentas al cargar.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // Idioma del sistema: por defecto, chino simplificado.
    // En pruebas, `-prop persist.sys.locale=zh-CN` no sirve de nada: el emulador intercepta las propiedades protegidas persist.sys.*
    // y ro.product.locale la sobrescribe el build.prop de la imagen; con getprop dentro del guest no se ve nada.
    // Para esto existe -change-locale: cambia de verdad el idioma del sistema y reinicia el framework,
    // y lo escribe en /data, así que se conserva al restaurar una instantánea.
    // El usuario puede cambiar a otro locale o desactivarlo en Ajustes (engine.locale='off').
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS: Android usa por defecto el 10.0.2.3 (reenviado al DNS del host). Con el host en VPN / red corporativa / algunos operadores,
    // una resolución puede tardar cientos de ms y se ve como «la página da vueltas antes de empezar a cargar». Se da un
    // DNS público nacional como preferido y el sistema sigue pudiendo recurrir a él si falla. El usuario puede desactivarlo en Ajustes (casos de dominios internos).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Ojo: **no se puede pasar -no-skin**. Sobrescribe el -skin de arriba y hace que el tamaño del panel vuelva al valor antiguo
      // de config.ini: se ve como «cambié a horizontal en Ajustes pero sigue vertical» y «la imagen solo ocupa una franja arriba a la izquierda».
      // El tamaño del panel debe decidirlo -skin.
      // La carcasa del dispositivo no se dibuja de todas formas (ShowDeviceFrame=no + este grupo de parámetros de estilo).
      // Ojo: no se puede usar -qt-hide-window. Hace que el emulador **ni cree** la ventana Qt,
      // y el agente de ventanas necesita justo esa ventana para incrustarla en la ventana de la app con SetParent —
      // con esa opción, probe nunca encuentra la ventana y el usuario ve una ventana de aplicación toda negra.
      // La ocultación de la ventana la hace el agente de ventanas de forma residente (véase QuietSweep en win/agent.ps1).
    }
    // Solo se pasa -snapshot si la instantánea existe de verdad: con un AVD nuevo (o una instantánea recién invalidada), pasarla hace que
    // qemu espere eternamente un estado de memoria inexistente, el proceso sigue vivo pero nunca arranca —
    // la capa superior solo ve «timeout de arranque», cambia de parámetros y reintenta, pero se topa con el bloqueo del AVD y da
    // "Running multiple emulators with the same AVD".
    // Los parámetros de instantánea deciden «si el próximo arranque tarda 8 o 90 segundos», y aquí está el segundo punto mortal:
    // la implementación antigua «si no hay instantánea, pasa -no-snapshot», pero -no-snapshot desactiva también **el guardado al salir**,
    // así que después del primer arranque en frío nunca se generaba una instantánea y cada pulsación del usuario era un arranque completo.
    // Lo correcto es -no-snapshot-load: esta vez no se carga (evita esperar una instantánea inexistente),
    // pero al salir se sigue escribiendo el estado de memoria como apkstart, y la próxima vez se restaura directo.
    // La instantánea ocupa un ram.bin de unos 2~3 GB (quien tenga poco disco puede desactivarla; solo afecta a la velocidad de arranque)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // Al reiniciar datos no se puede cargar una instantánea antigua (los datos ya no concuerdan), pero **sí se debe permitir guardar una nueva**:
      // reparar la red se apoya en la cadena «primer arranque tras el reinicio con red → se guarda la instantánea → se restaura la próxima vez»;
      // la forma antigua pasaba -no-snapshot aquí, lo que desactivaba también el guardado y la instantánea nunca se podía guardar.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // La autorreparación de red exige este arranque en frío: la instantánea pudo guardarse «sin red» y al restaurar seguiría sin red.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // Otros parámetros declarados por el controlador: -gpu / -accel ya se trataron unificadamente arriba y aquí se omiten,
    // para que el mismo parámetro no aparezca dos veces (el comportamiento ante parámetros duplicados varía según la versión de emulator).
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

  /** Arrancar un único proceso (sin esperar al arranque; esa espera está en el bucle probe de start()) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: mantiene el emulador independiente del grupo de procesos de ApkBuddyStart.
      // Al salir Electron, cierra su objeto job y con él mata a los procesos hijos —
      // el síntoma era «cierro ApkBuddyStart y al abrir otra vez hay que esperar 20 y pico segundos el arranque en frío». Al independizarlo,
      // el emulador se queda y el próximo arranque lo adopta directamente (véase Runtime.adoptExisting): se abre al instante.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`El entorno de ejecución se ha cerrado (code=${code}${meaning ? `，${meaning}` : ''}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu es un proceso independiente (detached); se baja su prioridad cuando ya arrancó de verdad.
    // Si no, los 2~4 hilos vCPU compiten con Normal contra el escritorio de Windows,
    // y lo que nota el usuario es «en cuanto abro ApkBuddyStart, el ratón va a la deriva y todo va lento».
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Escribir el log del emulador: con rotación por tamaño, para que el uso prolongado no llene el disco */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Situación real actual de la imagen /data (para mostrar en Ajustes; se puede obtener sin arrancar Android) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* Aún no se ha creado */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* Aún no se ha creado o está dañada */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // Tamaño real del sistema de archivos (≠ tamaño del archivo de imagen): si se amplió la imagen pero resize2fs no llegó, estos dos números difieren
      fsGB,
      configuredGB,
      // El usuario puso un objetivo pero el sistema de archivos aún no ha crecido hasta él
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot crea sobre userdata una capa de superposición qcow2: lo que ve el guest es ella, no la imagen base
      overlay: this._hasDataOverlay(img),
    };
  }

  /** ¿Userdata está tomado por la capa de superposición qcow2 de quickboot? (si está, solo se puede reiniciar, no ampliar in situ) */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * Ampliar de inmediato la partición /data al tamaño indicado (hay que asegurarse de que el emulador está parado, o la imagen está ocupada).
   *
   * Dos caminos, elegidos a base de pruebas:
   *  - sin capa de superposición quickboot: se amplía in situ (qemu-img resize + resize2fs), sin perder las apps instaladas;
   *  - con capa: lo que el guest monta de verdad es `userdata-qemu.img.qcow2`; aunque la base se amplíe a 8 GB y el sistema de archivos
   *    crezca a 8 GB, `df /data` en el guest sigue diciendo 5,7 GB (la capa conserva su tamaño antiguo) y el sistema de archivos
   *    de la capa no se puede cambiar sin permisos de root. Entonces hay que devolver con honestidad «hay que reiniciar»,
   *    y no dar éxito como antes: el usuario creería que ya amplió y el juego de 50 GB seguiría fallando a mitad.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `Android está usando un disco diferencial de inicio rápido y no se puede ampliar in situ (destino ${wantGB} GB）。`
          + 'Es necesario «Restablecer datos de Android» y reconstruir /data con la nueva capacidad: las aplicaciones instaladas y sus datos se borrarán, confírmalo antes.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition devuelve ok:false si falla resize2fs; se vuelve a comprobar el tamaño del sistema de archivos,
    // para que «el archivo creció pero el sistema de archivos no» no se dé por bueno (lo que el usuario ve es «al instalar dice que falta espacio»).
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `La imagen se amplió a ${wantGB} GB, pero el sistema de archivos solo llega a ${(fsAfter / 1073741824).toFixed(1)} GB (resize2fs no tuvo éxito).`
          + 'Puedes hacer clic de nuevo en «Ampliar ahora», o limpiar el disco y volver a intentarlo.',
      };
    }
    return r;
  }

  /**
   * Ajustar la prioridad de los procesos qemu/emulator de esta máquina (solo los que llevan el nombre de este AVD en su línea de comandos).
   * level: idle (contenedor aparcado) | below (app en primer plano) | normal (rendimiento primero).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Matar a la fuerza el intento actual (incluido el árbol de procesos qemu) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // El handle de proc a menudo ya no existe (emulator.exe sale al terminar de arrancar y qemu es un proceso detached independiente);
    // si no se limpia también por nombre de proceso, la siguiente ronda se topa con el bloqueo del AVD y da FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Recrear el servidor adb en este puerto exclusivo.
   *
   * Aquí está el principal culpable de «abrir una app tarda dos minutos». La implementación histórica hacía solo kill-server y volvía:
   * emulator, en cuanto arranca, intenta conectarse al daemon adb en ANDROID_ADB_SERVER_PORT,
   * y si no puede, **no vuelve a registrar nunca este dispositivo** — en adb devices no aparece emulator-5554,
   * o se queda para siempre en offline (en el log es la frase "Unable to connect to adb daemon on port: 5044").
   * Entonces el probe de la capa superior nunca obtiene sys.boot_completed, espera 3 minutos en vano y reintenta,
   * y cada reintento es un arranque en frío completo y la instantánea no se puede guardar porque «el dispositivo no está en línea»: bucle infinito.
   *
   * Por eso hay que hacer kill primero (limpiar los registros de dispositivos antiguos) y luego start, y no volver hasta que el puerto escuche de verdad.
   */
  /** Para que la capa superior reinicie el servidor una vez cuando la transferencia adb se quede atascada (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* Se usa el de PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server devuelve muy rápido en algunas máquinas, pero el puerto aún no escucha de verdad;
    // aquí se espera hasta que se pueda conectar (como máximo ~3 s; normalmente decenas de ms).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Esperar al caso de «arranca y sale enseguida».
   * Con parámetros erróneos / DLL ausente, emulator suele salir en menos de 1 s; si el proceso sigue, se vuelve al instante
   * y no hay que esperar fijamente 2,5 s — al restaurar una instantánea, ese tiempo basta para que el arranque avance a medias.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Forzar un arranque en frío en la «próxima vez» (sin cargar la instantánea de arranque rápido).
   *
   * En la instantánea se guarda también el estado de la tarjeta de red: si se guardó «sin red», todas las restauraciones posteriores
   * seguirán sin red. En la autorreparación de red, un primer arranque en frío esquiva esa instantánea mala.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Hacer que la «próxima vez» arranque con -wipe-data (solo para «reparar red» cuando todas las tentativas fallaron).
   * «Borrar el archivo de imagen userdata» no es equivalente al -wipe-data del emulator: hay que usar este último.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Comprobar si dentro de la máquina virtual se puede conectarse de verdad a internet.
   *
   * ¿Por qué hace falta: la configuración Wi-Fi de la máquina Android se guarda en /data y, si se escribe mal (típico:
   * `cmd wifi list-networks` muestra dos veces el mismo AndroidWifi y chocan los ids de red),
   * wlan0 queda siempre NO-CARRIER y no consigue IP. Entonces «las páginas que necesitan red» salen como una pantalla negra
   * en la app — de ahí viene lo de «Hongguo se queda negro tras pulsar Aceptar», que no tiene nada que ver con GPU/renderizado.
   *
   * @param {string} [adbPath] ruta explícita del ejecutable adb (Runtime tiene una resolución más autorizada)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    // Igual que en repairWifi: se evita el error de llamada de «pasar una función como si fuera una ruta»
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() solo mira el «archivo de versión» y, en muchas formas de instalación, está vacío;
      // buscar los platform-tools incluidos desde la raíz del runtime es lo seguro.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Las tablas de rutas múltiples de Android hacen que la tabla principal de `ip route` parezca vacía (la ruta por defecto está en las tablas por interfaz),
    // y el uid del shell no está en el grupo network de las apps, así que `ping` suele dar un falso "Network is unreachable",
    // aunque la Wi-Fi esté conectada y la app navegue bien. Por eso aquí solo se mira «si se consiguió una dirección IPv4»,
    // y se confirma cruzando con el estado de `cmd wifi status`; no se usa ping para juzgarlo.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // La asociación Wi-Fi + DHCP suele terminar decenas de segundos después que sys.boot_completed.
      // Si el llamador pasó waitMs, se sigue esperando; no se puede concluir «no hay red» en este instante.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // Tener IP no equivale a poder navegar. En pruebas: con 10.0.2.16 conseguido pero DNS/ruta cortados, la portada de la app sigue dando
    // «error de red» mientras la capa superior cree que todo está bien. Aquí se añade una sonda HTTP real.
    // Se usa nc al puerto 80 en vez de ping: el NAT de usuario de QEMU bloquea ICMP y ping daría un falso aviso siempre.
    // Solo se hace en la ruta «esperar a que la red esté lista» (waitMs>0); la encuesta rápida se salta esto — si no, cada 3 s
    // se gastarían 4 s sondeando y el arranque se ralentizaría. El resultado va en reachable, ok no cambia: con IP se deja
    // arrancar la app primero; un simple temblor de DNS no debe bloquear todo el arranque.
    let reachable = null;
    if (waitMs > 0) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connect.rom.miui.com\\r\\n\\r\\n' "
        + "| nc -w 4 connect.rom.miui.com 80 2>/dev/null | head -1",
        7000,
      );
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * Conectar activamente el AndroidWifi «guardado pero que no se conecta solo».
   *
   * Descubierto en equipos reales: el hotspot virtual AndroidWifi del emulador puede acabar como dos registros
   * en la base de configuración (open + owe) y el sistema lo interpreta como
   *   «Saved / Won't automatically connect»,
   * con lo que después del arranque wlan0 queda siempre NO-CARRIER y la app sigue avisando de error de red.
   *
   * El problema es que el shell (uid 2000) no tiene permiso NETWORK_SETTINGS y
   * `cmd wifi connect-network` lanza directamente SecurityException, así que no se puede por línea de comandos.
   * Aquí se abre la página de ajustes Wi-Fi y se pulsa la red guardada: el mismo efecto que si lo hiciera el usuario a mano.
   *
   * @returns {Promise<boolean>} si se consiguió conectar
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
    // Defensa: el llamador puede pasar por error la función misma (rt.adbPath es un método).
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Cuando ya esté conectado, de paso se cambia la dirección de la «verificación de conexión» a una alcanzable desde China.
    // Android comprueba «si hay internet de verdad» con connectifitycheck.gstatic.com, que no se puede alcanzar en China,
    // y el sistema marca siempre la red con «!» (conectado pero sin acceso a internet). Algunas apps por eso se declaran
    // solas offline y se niegan a cargar contenido. Basta cambiarlo por un endpoint nacional que devuelva 204.
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
    // Si ya está conectado, no se complique más
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
    // Si el interruptor está desactivado (el usuario pulsó sin querer / antes se hizo -svc wifi disable), se activa primero
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Se abre la página de ajustes Wi-Fi y se usa uiautomator para encontrar la fila de AndroidWifi y pulsarla.
    // Más estable que pulsar por coordenadas: cambian según resolución / idioma.
    await sh('am start -a android.settings.WIFI_SETTINGS');
    await new Promise((r) => setTimeout(r, 2500));
    await sh('uiautomator dump /sdcard/ui.xml');
    const xml = await new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', 'cat', '/sdcard/ui.xml'],
          { timeout: 10000, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 },
          (e, out) => resolve(e ? '' : String(out || '')));
      } catch (_) { resolve(''); }
    });
    // El nodo tiene esta forma: <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await sh(`input tap ${cx} ${cy}`);
        await new Promise((r) => setTimeout(r, 6000));
        if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // Respaldo: se intenta una reconexión directa (en algunas versiones el dump no trae text, solo content-desc)
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * Arrancar + reintentos automáticos.
   * @param {Function} probe callback asíncrono que devuelve 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // Clave: emulator.exe es solo un lanzador y, tras lanzar qemu, él mismo sale, pero el objeto proc
      // se queda ahí (killed sigue siendo false). Mirar solo eso toma «la máquina ya apagada» por
      // «sigue viva»: al reiniciar para cambiar de panel, ensure() justo después tropezó con esto y start() devolvió
      // reused; el llamador fue a adb con un serial ya muerto y dio `device not found`,
      // y el síntoma fue «cambiar a una app de otra orientación falla directamente».
      // Por eso hay que confirmar que en el puerto de consola corre una máquina de verdad antes de dar algo por reutilizado.
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('El emulador anterior ya se ha cerrado; reiniciando…');
      this.proc = null;
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('El motor del entorno de ejecución no está instalado; completa primero la implementación en la página «Entorno de ejecución»');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('La imagen de sistema no está lista; descarga primero la imagen de sistema de Android en la página «Entorno de ejecución»');
    }

    const s = this.settings;
    // Antes de arrancar, se echa un vistazo al disco: el emulador escribe el AVD (partición de datos + instantáneas, varios GB),
    // y solo el espacio libre de la unidad donde está decide si se puede arrancar; el directorio de runtime solo escribre logs y exige mucho menos.
    // Antes se tomaba el mínimo de ambos y, con «datos ya movidos a la unidad D y solo 400 MB libres en C»,
    // se juzgaba erróneamente poco disco: mover el directorio no servía de nada.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Espacio insuficiente en disco: la carpeta de datos de Android (${avdHome}) el disco donde se encuentra solo queda ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `El entorno de ejecución necesita al menos ${(needMB / 1024).toFixed(1)} GB disponibles. Ve a «Ajustes → Integración del sistema → Carpeta de datos de Android»`
        + 'Cámbiala a una unidad con espacio suficiente (p. ej., D:) o libera espacio en el disco primero. Tus aplicaciones y datos no se eliminarán automáticamente.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `Carpeta del entorno de ejecución (${loc.root}) el disco donde se encuentra solo queda ${(diskMB / 1024).toFixed(1)} GB，`
        + 'No hay espacio ni siquiera para los registros y archivos temporales. Libera espacio en el disco o cambia también la «Carpeta de datos del entorno de ejecución» a otra unidad.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Se hace que todas las llamadas adb de este proceso y el emulator usen el mismo puerto de servidor
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // Estas cuatro cosas no dependen entre sí y se hacen en paralelo: antes era «comprobar aceleración → versión → sondear puerto → limpiar servidor adb» en serie,
    // y se perdían 3~5 s antes del arranque en frío, justo el tiempo en que el usuario ve el cuadro de carga tras pulsar la app.
    // El servidor adb de la ejecución anterior puede tener aún registros de dispositivos antiguos (que expulsan al emulador nuevo a offline),
    // así que limpiar el servidor se sigue haciendo, solo que no hay que esperarlo aparte.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Controladores (parches de compatibilidad): primero se ve cómo es esta máquina y después si alguien le escribió un parche.
    // Este paso solo lee JSON y no ejecuta código; si no hay coincidencia, el efecto es vacío y el comportamiento idéntico al anterior.
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`Error al cargar el controlador: ${e.message}`);
      onLog(`Error al cargar el controlador (se ignoró; se inicia con los parámetros predeterminados):${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`Se aplicó el controlador:${drv.applied.map((d) => `${d.name} v${d.version}`).join('、')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('No se encontró ningún controlador coincidente; se inicia con los parámetros predeterminados');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`Hay ${drv.errors.length} archivos de controlador no se cargaron correctamente (puedes ver el motivo en Ajustes → Controladores)`);
    }

    // Se comparte un único punto de entrada con la página de ajustes / el informe de diagnóstico, para garantizar que «lo que se muestra» sea «lo que se ejecuta»
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // Cuando el controlador fija el backend de renderizado / exige simulación por software, cada ronda sigue esa decisión:
    // el usuario instala un controlador justo para decir «esta máquina solo sirve para este nivel», y seguir probando primero el backend que ya se cayó solo hace perder el tiempo.
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`El controlador fija el backend de renderizado en ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / el controlador requiere emulación por software` }));
        onLog('El controlador requiere desactivar la aceleración por hardware (usar emulación por software)');
      }
    }

    // Se recuerda el backend GPU que «se cayó al arrancar» para ponerlo al final la próxima vez.
    // En pruebas: en una AMD Radeon 780M, `-gpu host` pasa la comprobación de hardware del propio emulator,
    // pero a los diez y pico segundos de levantar la VM el proceso sale con exit 1 (en el log solo dice "AEHD is operational"),
    // y cada vez había que esperar 20 y pico segundos antes de retroceder a swangle. La clave lleva la versión de emulator,
    // para que al actualizar el runtime se le dé otra oportunidad automáticamente.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`Última vez ${badGpu} El backend de renderizado se bloquea al iniciar; esta vez se usa ${variants[1].gpu} probar primero`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // Las especificaciones de pantalla se mantienen iguales durante todo el arranque; cambiar la resolución en cada reintento limpiaría la instantánea sin parar.
    // La resolución sale del perfil de doctor (en Ajustes se puede cambiar la «calidad»); con auto se elige según el estado de aceleración.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Antes del arranque en frío se limpian los huérfanos: si el qemu de la ejecución anterior sigue ocupando el bloqueo del AVD,
    // todos los intentos dan al instante FATAL "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // Un puerto ocupado también provoca fallos; se vuelve a detectar en cada reintento
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Se reinicia el código de salida en cada ronda: un 0xC0000005 de la ronda anterior no puede arrastrarse al diagnóstico de la siguiente
      this.lastExitCode = null;
      // El log también se divide por rondas: el log en memoria se acumula entre rondas y, si la línea de cierre de la 1ª queda al final,
      // la 2ª ronda (p. ej. un conflicto de puerto al cambiar de backend) se diagnosticaría como el mismo cierre.
      const logStart = this._log.length;
      onLog(`Iniciando el entorno de ejecución (n.º ${i + 1}/${variants.length} veces:${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe también debe participar en «borrar la instantánea antigua»: tras reiniciar datos, la instantánea antigua fallará al cargar sin falta
        // (en pruebas da Failed to load snapshot y vuelve al arranque en frío), así que hay que limpiarla antes de reconstruir.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Instrumentación: la capa superior (main) lo usa para activar la supresión de ventanas negras **antes** de lanzar el emulador.
      // La ventana de consola aparece decenas de ms después del spawn; volver a escanear después necesariamente da un parpadeo,
      // así que aquí hay que activarla primero y luego lanzar el proceso.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot solo afecta a este spawn, para que los arranques posteriores no degeneren en arranques en frío largos
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Los parámetros erróneos / la DLL ausente salen de inmediato
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // Llenar el disco no es un problema que «se arregle cambiando de parámetros»: seguir reintentando solo dará fallos repetidos,
        // y encima el último juego de parámetros de la historia llevaba wipe y borraría los datos del usuario. Se termina ya y se informa del error real.
        if (d.code === 'DISK_FULL') {
          onLog('Espacio insuficiente en el disco; se han detenido los reintentos (tus aplicaciones y datos no se modificarán).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Las conclusiones de aceleración / imagen pueden ser datos antiguos en caché: se invalidan y se vuelve a detectar en el próximo arranque
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}, se cambiará automáticamente a otro conjunto de parámetros…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // La restauración de la instantánea suele arrancar en pocos segundos, y sondear fijamente cada 3 s significa esperar 1,5 s de media para «descubrir»
      // que ya está lista. Aquí se empieza en 200 ms y se va ampliando hasta 1,2 s: al principio del arranque se detecta al instante
      // y en los arranques largos no se gasta CPU en sondear.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // Si adb puede ejecutar un shell, el núcleo ya está arrancando; la información normal de Vulkan/EGL en el log no cuenta como fallo
        if (state === 'booting') sawBooting = true;
        // A los 45 s sin haber conectado casi nada, y con un error fatal claro en el log → se cambia de plan antes, sin esperar 4 minutos
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // Una línea de progreso cada 15 s: antes se usaba «módulo» y, con intervalo adaptativo, salían dos o tres líneas repetidas seguidas
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Iniciando el sistema… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // Esta vez arrancó de verdad: se borra el registro del fallo anterior para que un «diagnóstico» posterior no saque cuentas viejas
        this._clearFailure();
        // Hay que guardar la instantánea quickboot sí o sí: el proceso del emulador termina cuando sale ApkBuddyStart (el objeto
        // job de Electron se lleva por delante a los hijos), y tener instantánea o no decide si la próxima apertura tarda 25 o 7 segundos.
        // Al instalar una app nueva, installer invalida la instantánea para evitar que «la app desaparezca tras el reinicio».
        this.snapshotWorthSaving = true;
        onLog(`Entorno de ejecución listo (${Math.round(bootMs / 1000)}s，${plan.label}）`);
        // Que el arranque salga bien no significa que se pueda usar: de paso se revisa la red. Sin red en la máquina virtual, las páginas que la necesitan quedan negras,
        // y el usuario solo dirá «esta app sale negra», difícilmente pensará en la red. Aquí se comprueba una vez y se dice claramente.
        //
        // Pero no vale «comprobar una vez y concluir»: la asociación Wi-Fi + DHCP suele ir 5~20 s detrás de sys.boot_completed,
        // y antes se llamaba a checkNetwork() una sola vez, con lo que **en cada arranque en frío** salía un aviso
        // «⚠ Sin red, restablece los datos de Android» cuando a los 5 s la red ya estaba lista: si el usuario hacía caso,
        // perdía todas las apps instaladas. Ahora se da una ventana de espera de 12 s (se vuelve en cuanto está listo) y solo se avisa al agotarse,
        // y ya no se sugiere una operación destructiva.
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* Que falle la comprobación no cuenta como fallo de arranque */ }
        if (network && !network.ok) {
          onLog('⚠ La máquina virtual de Android no está conectada a internet en este momento (Wi-Fi no asociado o sin dirección).'
            + 'Las aplicaciones que necesitan red pueden quedarse en negro al abrirlas: ciérralas y vuelve a abrirlas más tarde;\n            '
            + 'Si sigue sin haber red, usa «Ajustes → Reparar red» para reconectar (no se borran las aplicaciones instaladas).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}：${d.hint}` : 'Tiempo de espera de arranque agotado (puede deberse a que el primer inicio es lento o a que la aceleración de hardware no surtió efecto)';
      onLog(`${lastError}, se cambiará automáticamente a otro conjunto de parámetros…`);
      // Un diálogo de autorización atascado no es problema del backend de renderizado; no se apunte el GPU actual a la lista negra de «arranca y cae»,
      // o el próximo arranque se saltaría sin motivo un backend que la máquina del usuario sí podía usar.
      if (d.code !== 'ADB_UNAUTHORIZED') this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `El entorno de ejecución no pudo iniciarse tras varios intentos (${d.title}）。\n${d.hint}\n\n`
      + `Intentado:${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `Informe de diagnóstico:${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Guardar la instantánea quickboot (la próxima vez se restaura el estado de memoria directo, como el arranque rápido de WSA / Tencent MyApp).
   *
   * El momento importa: antes se guardaba a los 6 s de arrancar y justo se peleaba por el disco con la app que el usuario acababa de abrir
   * (la instantánea escribe 1~3 GB), y la sensación era más lenta. Se cambió a «guardar cuando haya reposo» y lo dispara Runtime
   * al cerrarse la última ventana de app; si no dio tiempo antes de apagar, también se guarda una vez.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // El comando save del emulator puede devolver OK a mitad de la escritura; aquí se confirma por integridad del archivo,
    // y solo cuenta si snapshot.pb se guardó de verdad (si no, la próxima carga fallaría y se perderían unos segundos).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Programar un «guardado de instantánea cuando haya reposo».
   * Solo se programa una vez; si a la hora hay una app en primer plano, se retrasa hasta que haya reposo de verdad.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Si no queda espacio para escribir la instantánea (tamaño de memoria + 1 GB de margen), se omite: forzarla solo llenaría el disco
        // y haría que el próximo arranque fallara directamente. La instantánea solo afecta a la velocidad de arranque; no escribirla no toca los datos.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Se omite el guardado de la instantánea: quedan ${(freeMB / 1024).toFixed(1)}GB < se necesitan ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Parada elegante: en máquinas lentas se guarda primero la instantánea quickboot, luego se apaga por consola y al final se mata el árbol de procesos */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // La instancia adoptada no tiene handle de proc, pero en el puerto corre una máquina de verdad; no se puede devolver true y ya
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    // Antes de apagar, se juzga la salud del guest y solo en esta ocasión se pregunta una vez a adb:
    //  - sano → se guarda otra instantánea (si la ruta de reposo no dio tiempo, así la próxima vez sigue siendo instantánea);
    //  - no sano (adb atascado en unauthorized / arranque sin completar) → no se guarda y **se invalida la instantánea al salir**:
    //    `adb emu kill` hace que el emulator guarde por su cuenta un estado quickboot, que también congela el estado no autorizado.
    //    Si no se limpia aquí, la próxima restauración será otra instantánea venenosa «que siempre da timeout al arrancar».
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // Escribir 3 GB de memoria tarda de unos segundos a más de veinte; el tiempo de espera se da generoso para que no se mate la instantánea a medias.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('Al apagar, el invitado no está autorizado/no está listo: se descartará la instantánea y se volverá a inyectar la autorización de depuración en el próximo arranque en frío');
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Se espera a que complete su proceso de «escribir en disco → salir». Antes se esperaban fijamente 6 s y se mataba a la fuerza,
    // justo cortando la escritura de la instantánea y dejando un cascarón con solo ram.img y sin snapshot.pb.
    //
    // Ojo: no se puede esperar a this.proc: emulator.exe es solo un lanzador y, tras hacer spawn de qemu, él mismo sale,
    // y tomar su exit como «apagado terminado» entra directo en la rama de matar a la fuerza. Aquí se rige por el puerto de consola.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    // Si se cerró limpiamente, se descarta el handle del lanzador. Conservarlo haría que running() devolviera siempre true
    // y start() creyera que aún se puede reutilizar (véase el comentario en start()).
    this.proc = null;
    // El proceso ya salió; ahora se invalida la instantánea venenosa que pudo guardarse automáticamente al salir. El orden importa:
    // debe ir después de emu kill + cierre del puerto, o el emulator volverá a escribir la instantánea que acabamos de borrar.
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * Registrar el backend GPU que «se cayó al arrancar» para ponerlo al final la próxima vez.
   * Solo surte efecto en modo auto: si el usuario eligió backend explícitamente, se respeta y no se cambia a escondidas.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // El renderizado por software es la opción de respaldo: ya es la más lenta y más estable, no hay otra peor a la que retroceder
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** ¿Queda alguna máquina corriendo en el puerto de consola de esta instancia (5554)? Sirve para juzgar «si se cerró del todo» */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * ¿Está el guest en un estado sano «seguro para guardar una instantánea»: adb authorized + arranque completado?
   * En un arranque en frío, si el diálogo «¿Permitir depuración USB?» sigue colgado, el state es unauthorized — guardar ahí
   * memoria + disco deja al guest sin el adbkey.pub del host, y al restaurar sigue unauthorized,
   * y cada sondeo del shell lanza una excepción: se esperan 240 s y encima se diagnostica como problema de gráficos / virtualización.
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // Si no se puede leer, se trata como no sano
    }
  }

  /**
   * Disparar una vez el guardado de instantánea con adb (devuelve false si falla y el llamador decide si reintenta).
   * Solo se guarda si el guest está sano: antes un arranque en frío de 20 y pico segundos que una instantánea venenosa «que siempre falla al arrancar».
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
      this.log('Se omite el guardado de la instantánea: el invitado no está autorizado o el arranque no terminó (para evitar guardar una instantánea no autorizada y dañina)');
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Tomar solo las líneas de log generadas en «este intento de arranque».
   * El log en memoria se acumula entre rondas (el informe de diagnóstico quiere ver todos los intentos), pero la conclusión debe mirar solo esta ronda:
   * si no, un `emulator exit 3221225477` de la 1ª ronda haría que cualquier fallo de la 2ª se juzgara como el mismo cierre.
   * Cuando no hay ninguna línea de esta ronda (el proceso ni arrancó), se vuelve a la cola completa para dar al menos una conclusión.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Leer las últimas n líneas del archivo emulator.log (cuando el búfer en memoria está vacío).
   * Al reiniciar ApkBuddyStart y exportar el informe, this._log en memoria ya está vacío,
   * y antes el informe solo decía UNKNOWN: la causa real del cierre estaba toda en el archivo de log.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Si se lee desde el principio, la primera línea puede estar truncada; se descarta
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
