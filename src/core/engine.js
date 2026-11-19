'use strict';
/**
 * Motor de runtime: la máquina virtual QEMU + Android-x86 que incluye ApkBuddyStart.
 *
 * Principios de diseño:
 *  - por defecto, totalmente autónomo (builtin): adb / QEMU / imagen de sistema los gestiona ApkBuddyStart, sin depender de ningún emulador de terceros;
 *  - todas las operaciones sobre Android pasan por adb, de modo que el motor se pueda sustituir;
 *  - la máquina virtual se arranca bajo demanda y se recicla al estar inactiva; tras arrancar, se mantiene para reutilizarla, y abrir/instalar una app no espera casi nada.
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Comprobar si alguien escucha en un puerto TCP (para ver si sigue el emulador que quedó de la sesión anterior) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // Sesión del contenedor: las ventanas de app abiertas ahora
    // En modo multiventana, las apps de segundo plano convertidas en lápida (force-stop pero conservando datos); al volver a pulsar se recuperan en caliente.
    this._tombstoned = new Set();
    // Último resultado del chequeo de red. La barra de estado debe mostrar «red OK / sin conexión», pero el estado se sondea con alta frecuencia,
    // así que no se puede ir a ejecutar un shell al guest cada vez; aquí solo se cachea la conclusión y, si caduca (>5 min), no se tiene en cuenta.
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // El puerto se elige dinámicamente y el serial cambia con él
    /**
     * Capa de adaptación de backend: extrae «de dónde viene Android» de esta clase.
     *
     * Desde la 0.5.6 aquí **solo hay una implementación**: builtin (emulator + imagen de sistema incluidos).
     * Ya no existen las ramas mumu / fydeos / attach: cualquier máquina, cualquier ajuste y cualquier configuración residual
     * obtienen solo el runtime incluido, garantizando que ApkBuddyStart funcione siempre de forma independiente y sin relación con emuladores de terceros.
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * Instancia de backend actual (solo hay una: builtin).
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * Comprobar si la base que pide los ajustes existe en esta máquina.
   *
   * Ahora solo está el runtime incluido, que siempre está disponible (que falte una imagen es cosa de la fase provision, no «la base no existe»).
   * Se conserva este método para no cambiar los puntos de llamada de la capa superior.
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** id del backend, siempre 'builtin'; lo usan la interfaz y los logs */
  get backendId() { return this.backend.id; }

  /** Descartar conexiones y suposiciones de puerto antiguas (se llama al cambiar el directorio de runtime / resetear datos) */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** ¿Está corriendo el motor emulator? */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- Base ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // Nuestro adb va siempre primero: un mismo dispositivo solo reconoce un estado de adb, y así no hay tartaleos de offline una y otra vez.
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // Al cambiar de puerto / de adb, no se deje el antiguo shell adb residente ocupando la conexión
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- Estado ----------------

  /**
   * Instantánea de red para la barra de estado (última conclusión del chequeo).
   * Si pasan más de 5 minutos no se tiene en cuenta: pudo haberse cortado la red entre medias, y más vale mostrar «desconocido» que mentir al usuario.
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * Chequeo de red en segundo plano (sin bloquear la respuesta de status).
   * La barra de estado debe mostrar el estado de la red, pero status() se sondea con alta frecuencia y no se puede ir al guest a ejecutar un shell cada vez.
   * Así que la primera vez (o tras caducar) se ejecuta en segundo plano, se guarda la conclusión en _lastNetwork y la próxima ronda de sondeo ya la puede mostrar.
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // Se acaba de comprobar hace un minuto, no se repite
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* Si no se encuentra nada, se deja como está y se prueba de nuevo en la siguiente ronda */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // «Por qué no arrancó la última vez»: si no está en memoria se recurre al registro en disco, para que la página de ajustes / el diagnóstico puedan mostrar la causa real
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Falta adb: pulsa «Desplegar en un clic» para descargarlo automáticamente';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // Ya no se trata «no tener aceleración por hardware» como un paso bloqueante: doctor retrocede automáticamente a simulación por software
    // y, si el arranque falla, reintenta por combinaciones GPU / aceleración / memoria.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

/**
 * Lista de dispositivos ya conectados al adb local (solo para diagnóstico, solo lectura).
 *
 * Desde la 0.5.6 ya no existe el modo «conectarse a un runtime existente»: aquí no se hace connect a otros puertos de emulador,
 * solo se listan con fidelidad los dispositivos que adb ve ahora, para al diagnosticar confirmar «si es nuestro emulator-5554».
 */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- Arrancar / parar la máquina virtual ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkBuddyStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Primera opción: el emulator oficial (trae modelos de dispositivo y traducción GPU, la mejor experiencia)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Arrancar Android con el emulator oficial.
   * A diferencia de QEMU+ISO, aquí no hay un paso de «instalar el sistema»: la imagen ya es el sistema y arranca la primera vez.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No se detectó aceleración de hardware: se usará automáticamente la emulación por software (el primer arranque será mucho más lento; no hay que configurar nada manualmente)');
    }

    this.vmStarting = true;
    try {
      // probe se delega al bucle de arranque de EmulatorEngine: si el proceso sale / hay un log fatal, cambia de parámetros y reintenta
      // En cada ronda se envía una sola orden adb: antes eran get-state + getprop + pm path, tres arranques de proceso,
      // y al restaurar una instantánea cada ronda perdía 300~500 ms, justo en la percepción de «abrir la app».
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // Si esta llamada a start() ya hizo un arranque en frío por «no autorizado» e invalidó la instantánea
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: 'Autorización de depuración Android pendiente (diálogo de autorización)',
        hint: 'El sistema se ha quedado en el diálogo «¿Permitir depuración USB?»; se ha descartado la instantánea antigua y se ha reiniciado en frío una vez para que el entorno'
          + 'Se volvió a inyectar la clave pública de adb. Si vuelve a ocurrir, elimina %USERPROFILE%\\.android\\adbkey* y vuelve a intentarlo.',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // Rama clave: un error de adb shell puede significar «aún no arrancó» o «el diálogo de autorización está atascado».
          // En el segundo caso, cada ronda del shell lanza una excepción, y la implementación antigua lo tomaba por un offline normal:
          // reiniciaba el servidor y seguía esperando en vano 240s×4 juegos de parámetros, y al final informaba de «el runtime no pudo completar el arranque»,
          // haciendo creer al usuario que era tema de gráficos / virtualización. Aquí se confirma unauthorized primero por el texto del error
          // y después por la columna state de devices (get-state no distingue authorized), y al acertar se invalida la instantánea,
          // se hace un arranque en frío y se da un diagnóstico exacto, sin seguir esperando.
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('adb está esperando en el diálogo de autorización «Permitir depuración USB»; se descartará la instantánea actual y se reiniciará en frío para volver a inyectar la clave pública…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // Se fuerza un arranque en frío en la próxima ronda para que el emulator vuelva a inyectar la clave pública adb
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // Se deja a start() cambiar de parámetros y reintentar enseguida; tras el arranque en frío, el problema del diálogo desaparece
            return 'fatal';
          }
          // Otras anomalías de transferencia adb: se mantiene la autorreparación de reiniciar el servidor
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('Conexión adb anómala; se reiniciará el servidor adb y se seguirá esperando…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // Cuando start() falla, devuelve {ok:false} en lugar de lanzar una excepción (poco disco, reintentos agotados, etc.).
      // La implementación antigua no miraba este campo y devolvía ok:true hacia arriba: la capa superior creía que «ya estaba listo»,
      // y entonces adb empezaba a dar device not found y el usuario veía «pulsé y no pasa nada» en lugar de la causa real.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'El entorno Android no pudo iniciarse',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // La instantánea pasa a guardarse «cuando haya reposo»: guardarla de inmediato escribes 1~3 GB y se pelea por el disco con la app que acaba de abrir el usuario
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Se lanza tal cual a la UI la conclusión del reintento automático / diagnóstico, para no añadir otra capa de «fallo de arranque» ambiguo
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- Calentamiento previo (dejar el entorno residente como WSA) ----------------

  /** Guardar la instantánea quickboot cuando haya reposo: solo se escribe a disco si no hay ventanas de app, para no pelearse con el arranque de apps */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** Para que lo llamen desde fuera, p. ej. el instalador: tras instalar una app se guarda otra instantánea y el próximo arranque sigue siendo instantáneo */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Forzar el guardado de una instantánea, **sin esperar al reposo**.
   *
   * ¿Cuándo hace falta? Justo después de arreglar la red y cuando se va a arrancar una app enseguida. El scheduleSnapshotSave normal
   * solo escribe cuando no hay ventanas de app, pero en cuanto arranca una app nunca hay reposo,
   * así que el estado «red conectada» nunca se guardaba — el próximo arranque volvía a restaurar la instantánea antigua
   * con el estado sin red y había que reconectarse cada vez. Aquí se omite explícitamente la comprobación de reposo: una escritura a cambio de ahorrarla siempre después.
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

/**
 * Calentamiento previo: antes de que el usuario pulse una app, se arranca el entorno de Android en segundo plano.
 * WSA / la versión de PC de Tencent MyApp siguen esta idea — entorno residente y, al pulsar el icono, solo queda un am start.
 *  - Totalmente silencioso: sin avisos ni errores; un fallo no afecta a la apertura normal de la app;
 *  - Idempotente: si ya está arrancando o listo, se reutiliza la misma Promise y no se levanta una segunda máquina;
 *  - Ahorro de recursos: tras arrancar, se baja qemu a la prioridad mínima y se deja aparcado.
 */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Precalentamiento:${m}`) });
        if (r && r.ok) {
          // Durante el calentamiento puede ser que el usuario ya haya pulsado una app: entonces no se le puede bajar a prioridad idle
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Precalentamiento completado (${Math.round(ms / 1000)}s）`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU no está instalado; completa primero la implementación del entorno de ejecución');
    if (install && !env.iso.ok) throw new Error('Imagen del sistema (ISO) no lista');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Android aún no está instalado en el disco virtual');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Iniciando el entorno de ejecución (${env.hypervisor.whpx ? 'Aceleración por hardware WHPX' : 'Emulación pura por software'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Error al iniciar:${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`El entorno de ejecución se ha cerrado (code=${code}）`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU no pudo iniciarse; consulta el registro:${logFile}`);

    // En modo de instalación, la ISO contiene el instalador de Linux y no hay adb; no se puede tratar como «esperar adb»
    if (install) {
      onLog('El instalador se ha iniciado; sigue las instrucciones en la ventana de la máquina virtual para completar la instalación');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'La máquina virtual arrancó pero adb no pudo conectarse: activa «Opciones de desarrollador → ADB sobre red» dentro de la máquina virtual e inténtalo de nuevo',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'El kernel de Android terminó de arrancar, pero los servicios del sistema no están listos (puede estar en la configuración inicial; completa el asistente en la ventana de la máquina virtual)'
          : 'Android arrancó pero los servicios aún no están listos (puede haberse detenido en la configuración inicial; completa el asistente en la ventana de la máquina virtual)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Esperar a que Android esté realmente utilizable: adb en línea ≠ sistema utilizable.
   * Hay que esperar a sys.boot_completed=1 y a que el gestor de paquetes responda, o am start fallará directamente.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`El núcleo de Android se ha iniciado; esperando a que los servicios del sistema estén listos… (${Math.round((Date.now() - start) / 1000)}s）`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android está listo (${Math.round((Date.now() - start) / 1000)}s）`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Esperando al servicio del sistema… ${Math.round((Date.now() - start) / 1000)}s`
          : `Iniciando Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // Los emulator-5554 y similares los registra el propio emulator, no hace falta adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Esperando a que Android arranque… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // El entorno en chino (idioma del sistema + método de entrada) se configura una sola vez **por arranque**.
    // El idioma del sistema se inyecta con emulator -prop (protegido por SELinux, no se puede cambiar en tiempo de ejecución); aquí se completa
    // el locale / la zona horaria a nivel de app y se instala y activa en silencio el teclado Pinyin incluido.
    // El usuario puede desactivar la configuración automática en Ajustes (engine.chineseIme=false).
    if (!this._chineseReady && this.settings.engine.chineseIme !== false) {
      try {
        const locale = this.settings.engine.locale || 'zh-CN';
        await client.ensureChineseLocale(locale);
        const path = require('path');
        const apk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        const r = await client.ensureChineseIme(apk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // Solo se marca cuando salió bien. Si falla, se permite que el próximo prepare() lo reintente —
        // si no, un simple tartaleo de adb dejaría esta máquina sin teclado chino para siempre.
        if (r && r.ok) this._chineseReady = true;
        this.log(`Método de entrada en chino:${r.ok ? (r.installed ? 'Instalado y habilitado' : 'Listo') : (r.reason || 'No listo')}`);
        // -change-locale solo se ejecuta en el «arranque completo» y reinicia el framework; al restaurar desde una instantánea quickboot
        // se omite. La instantánea antigua está en inglés, así que si se detecta que el idioma no es correcto se invalida la instantánea y
        // se fuerza un arranque en frío (con -change-locale). La nueva instantánea ya será china y no hará falta reiniciar más.
        // El marker garantiza que se corrija una sola vez en la vida.
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`Se omite la inicialización del entorno en chino:${e.message}`);
      }
    }
    this.startWatchdog();
  }

/**
 * Corrección del idioma de la interfaz del sistema (una sola vez).
 *
 * Conclusión probada (muy fácil equivocarse): después de -change-locale **no** se escribe persist.sys.locale,
 * y ro.product.locale sigue siendo el en-US de la imagen; lo que cambia de verdad es
 * `settings system system_locales` (la página de idiomas muestra «Chino (China)» y toda la interfaz del sistema pasa al chino).
 * Por eso, para juzgar si «el chino ya está aplicado» hay que mirar system_locales, no getprop.
 *
 * -change-locale solo se ejecuta en el «arranque completo» y reinicia el framework; al restaurar desde una instantánea quickboot
 * se omite. La instantánea antigua está en inglés, así que si se detecta que no es correcto se invalida la instantánea y se fuerza un arranque en frío.
 * La nueva instantánea ya será china y no hará falta reiniciar más. El marker garantiza que se corrija una sola vez.
 */
  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'zh-CN');
    if (want === 'off' || want === 'en-US') return;
    // Ya está aplicado (system_locales es el idioma objetivo, o el primer elemento de la lista de idiomas lo es)
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.indexOf(want) === 0 || /^zh[-_]/.test(s)) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`El idioma del sistema sigue siendo ${s || '(vacío)'}, se descarta la instantánea anterior y en el próximo arranque en frío se cambia a ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`Se omite la corrección del idioma del sistema:${e.message}`);
    }
  }

  /** Parada elegante: el emulator apaga por consola, QEMU lo hace por monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // Un emulador adoptado (adoptExisting) no tiene handle de proc en este proceso y la lógica antigua hacía directamente
    // return false — con el resultado de que el perro guardián de inactividad nunca podía apagarlo y el contenedor seguía ocupando CPU/memoria.
    // Esta ruta usa el apagado por consola adb y, si hace falta, recurre a matar por puerto.
    //
    // Ojo: emulator.exe es solo un lanzador — tras hacer spawn de qemu, él mismo sale, así que las máquinas «que arrancamos nosotros»
    // también caen a menudo en esta rama. Antes de apagar hay que llamar una vez a saveSnapshotNow, o la instantánea nunca se guarda
    // y cada pulsación del usuario es un arranque en frío completo (la diferencia entre 25 s y 8 s está aquí).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('Tiempo de espera del monitor agotado')));
      sock.on('error', (e) => {
        // QEMU cierra la conexión por su cuenta tras ejecutar quit y otros comandos (ECONNRESET/EPIPE): es normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Instalar el sistema en el disco virtual ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Descarga o importa primero la imagen de sistema de Android (ISO)');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'Error al iniciar el entorno de instalación');
    return r;
  }

  /** Tras instalar: se cierra el instalador → se escribe la marca → a partir de ahí se arranca directo del disco */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

/**
 * Adoptar el emulador que dejó la ejecución anterior.
 * Cada emulador tiene su propio puerto de consola (5554/5556/…), y el puerto adb es +1.
 * Si se puede conectar al puerto y el system ya hizo boot_completed, se usa directamente como nuestro runtime,
 * de modo que «cerrar ApkBuddyStart y volver a pulsar una app» sea instantáneo y no arranque otra máquina en frío.
 */
/**
 * Encontrar todos los puertos de consola de emuladores aún vivos.
 * No se puede «probar en orden desde el 5554»: los puertos van subiendo con los arranques (5554→5556→5558…)
 * y probar un rango fijo siempre deja alguno sin probar, lo que haría abrir otra máquina. Aquí se buscan directamente
 * todos los puertos TCP que escucha qemu por nombre de proceso, y no se escapa ninguno.
 */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* Se vuelve a la detección por puerto */ }

    if (ports.size) {
      // Se escuchan tanto el puerto de consola (par) como el de adb (+1); se conserva solo el de consola
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Respaldo: sin información de procesos qemu, se detecta directamente (una conexión rechazada vuelve enseguida, coste muy bajo)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No se encontró el entorno de ejecución anterior; preparando el arranque en frío');
      return null;
    }
    onLog(`Encontrados ${alive.length} entorno(s) de ejecución residual(es) (puerto ${alive.join(', ')}), intentando tomar el control`);

    // En el servidor adb puede quedar el registro offline del proceso anterior (le pasa al emulador cuando reinicia adbd),
    // se limpia antes de conectar, o get-state devolvería siempre offline y se mataría una máquina perfectamente buena por «no lista».
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Se ha detectado el entorno de ejecución anterior (${serial}) pero no está listo; ciérralo y vuelve a arrancar`);
        // El directorio AVD tiene un bloqueo: dejar esta máquina haría que una instancia nueva saliera directamente, y el usuario ve «no hay forma de arrancar».
        // Como adb ni conecta, solo queda encontrar el proceso por el puerto de consola y matarlo a la fuerza.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Se ha tomado el control del entorno de ejecución en ejecución (${serial}）`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Qué proceso está escuchando en un puerto TCP (para matar a la fuerza un emulador atascado) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

/**
 * Limpiar emuladores huérfanos que quedaron de la ejecución anterior y no fueron adoptados.
 * Al cerrar ApkBuddyStart, el emulator está detached y qemu sigue vivo; en el próximo arranque sigue ocupando el bloqueo del AVD,
 * y el arranque en frío sale con FATAL "Running multiple emulators with the same AVD".
 * La implementación se concentra en EmulatorEngine y la ruta de reintento (killAttempt) usa la misma lógica.
 */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

/**
 * Entrada idempotente: el calentamiento previo y el clic del usuario pueden ocurrir a la vez y comparten una Promise,
 * para evitar que cada uno decida «no está en línea» y levante su propia máquina (conflicto de bloqueo de AVD + el doble de memoria).
 */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // Al salir ApkBuddyStart, el emulador se queda (para entrar rápido la próxima vez), pero el proceso nuevo no tiene su
    // handle y es posible que se reiniciara el servidor adb: con solo isOnline() se juzgaría «no hay runtime»
    // y se abriría otra máquina. Aquí se adopta primero el emulador que sigue vivo, para no abrir otro que coma memoria.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // Emulador que dejó la sesión anterior / que levantó otro proceso: se reutiliza aunque cambie de puerto; nunca se abre otro
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* Si no se encuentra, se arranca con normalidad */ }

    // El proceso sigue vivo pero el dispositivo está offline (casi siempre atascado en el arranque): se para y se vuelve a arrancar, para no esperar en vano
    if (this.emulator.running()) {
      onLog('Se detectó un entorno de ejecución atascado; reiniciando…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Única ruta: el runtime incluido
    // En la distribución de un solo archivo, la imagen viene comprimida, así que se expande primero (si ya está expandida, pasa al instante).
    // Si la expansión falla, no se trague el error: si no, después checkEnv() solo diría «falta la imagen de sistema»,
    // y el usuario pensaría que no se descargó en lugar de que falló la descompresión (disco lleno / archivo dañado).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Error al expandir la imagen del sistema:${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Ruta del emulator: la imagen es el sistema, no hay paso de «instalar en disco»
    if (env.emulator.ok && env.sysimg.ok) {
      // Tras cerrar ApkBuddyStart puede quedar un emulador no adoptado (el qemu detached sigue vivo),
      // y ocupa el bloqueo del AVD, con lo que el arranque en frío sale FATAL "Running multiple emulators with the same AVD".
      // Si la adopción falla, primero se limpian estos huérfanos y luego se arranca en frío, para garantizar que «cerrar y abrir» siempre funcione.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // Ruta QEMU (el usuario trae su propia ISO y ya la instaló en el disco virtual)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'Falta la imagen del sistema: haz clic en «Descargar imagen del sistema»'
          : 'Los componentes del entorno de ejecución aún no se han implementado por completo',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- Sesión del contenedor a nivel de app ----------------

/**
 * Implementación concreta de «abrir como un contenedor»:
 * el entorno de Android se arranca una sola vez y queda residente (instantánea quickboot + adopción con adoptExisting),
 * y después cada apertura de una app es solo un am start + colgar la ventana ya existente, sin volver a ejecutar todo el sistema.
 * Aquí se hace además otras tres cosas para reducir la carga del sistema:
 *   - se detienen los procesos de otras apps de usuario, para que el entorno solo ejecute lo que necesita la app actual;
 *   - cuando hay una ventana, se da a qemu una prioridad «cede el primer plano»;
 *   - la sincronización de archivos / el sondeo de notificaciones solo se activan si hay una ventana (lo hace el callback onActive en la capa de UI).
 */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Nivel de planificación cuando hay una app en primer plano. balanced usa normal (no below):
    // below hace que qemu se muera de hambre cuando el sistema está ocupado, y se ve como decodificación de vídeo con tirones y clics que tardan en responder —
    // es la causa principal de «el ratón no va suave». normal solo iguala al escritorio y no consume CPU/memoria/GPU de más.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // Hay una app a punto de abrirse: se retrasa el «guardar instantánea por reposo» para no pelearse con el arranque de la app
      this.emulator.cancelSnapshotSave();
    }
    // En cada apertura / cambio a una app se asegura de que la prioridad esté bien puesta: endApp baja a idle un qemu inactivo,
    // y si al volver no se vuelve a subir, se queda en prioridad baja y «va pesado». setPriority es idempotente,
    // si ya está en el valor objetivo el script no cambia nada y el coste es mínimo.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* Que falle el arranque del sondeo no afecta a la apertura de la app */ }
    }

    // Modo multiventana (plan B): al abrir una app nueva **ya no** se hace force-stop de las demás, o no habría multiventana.
    // En su lugar se recicla con la estrategia de lápidas a las que «llevan mucho sin verse», permitiendo varias a la vez sin que la memoria se descontrola.
    // Al desactivar multiWindow se vuelve al comportamiento antiguo de «quedar solo el actual», para garantizar que se pueda revertir.
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // Se anota la que se puso en espera para recuperarla en caliente al volver a pulsar
        this.log(`Multiventana: primer plano ${pkg}, conservando en segundo plano ${roles.background.length - tombstone.length} en segundo plano (tombstone) ${tombstone.length} elementos`);
      } else {
        this.log(`Multiventana:${roles.count} aplicaciones coexistiendo, no es necesario recuperar`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // La app acaba de recibir am start; limpiar el segundo plano ahora podría afectar al proceso que entra en primer plano; la limpieza la hace endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

/**
 * Cerrar una ventana de app: se detiene su proceso y, si es la última ventana, se pone el contenedor en
 * estado «residente pero casi sin consumo» (se limpia el segundo plano + Android en idle + qemu baja de prioridad).
 * No se apaga ni se borra el AVD — la próxima apertura sigue siendo instantánea.
 */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // En modo game se mantiene alta prioridad aunque no haya ventanas de app,
      // o la próxima vez habría que volver a subirla y el primer input tendría una latencia notable.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Ahora mismo está lo más inactivo: se guarda el estado de memoria como instantánea para que el próximo arranque restaure en vez de arrancar en frío
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Contenedor estacionado (Android residente, 0 procesos de aplicación, qemu con prioridad mínima)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Para que la página de ajustes restaure los paquetes del sistema desactivados al cambiar «recorte profundo» */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Reciclaje por inactividad ----------------

/**
 * Autorreparación de orientación: garantizar que el «espacio de visualización lógico» y el «panel físico» tengan la misma orientación.
 *
 * Criterio (dumpsys window displays en equipo real):
 *   init=1280x720 ... cur=1280x720   → normal (panel horizontal + lógica horizontal)
 *   init=1280x720 ... cur=720x1280   → tumbado: el espacio lógico se giró 90°
 * En cuanto cur tiene el orden de ancho/alto invertido respecto a init, alguna app / el sistema ha cambiado la orientación;
 * entonces basta con volver a fijarla e ignorar las solicitudes de orientación de la app para corregirlo, sin reiniciar la máquina.
 *
 * Solo se escribe en settings cuando hay una discrepancia real; en condiciones normales, cada 60 s solo hay un shell de solo lectura.
 */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // La orientación del panel no coincide con los ajustes → hay que reiniciar, esto no se arregla aquí (lo hace runLaunch.beforeStart)
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // Está realmente tumbado: se vuelve a fijar la orientación + se ignoran las solicitudes de la app + se restaura density
      this.log(`Autorreparación de orientación: init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} se ha caído, convergiendo de nuevo`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // «No estar tumbado» no significa que el estado sea correcto. El diseño de tableta depende de dos estados de runtime fáciles de perder:
    //   - mSetIgnoreOrientationRequest (en horizontal debe ser true, o la orientación de la app desvía el panel)
    //   - la sobreescritura de wm density a 190 (720 de ancho → sw606dp ≥ 600dp para que se use el diseño de tableta)
    // Si falta cualquiera de los dos se vuelve al formato de móvil — justo el síntoma de «el modo tableta es inestable».
    // Aquí se hace una comprobación ligera y se repone lo que falte (son comandos idempotentes; en condiciones normales no se escribe).
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // Solo se cuenta como correcta la línea «Override density: N» si existe y es igual al valor objetivo
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`Estado de visualización convergido: ignore-orientation=${ignoreOk} density=${densityOk} → completar`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // La density solo se repone cuando **no hay ninguna app en primer plano**.
      // Cambiar la densidad dispara un cambio de configuración + reconstrucción de la Activity, y las apps que cachean DisplayMetrics
      // (Modu) recalculan los dp con la densidad antigua y la imagen se reduce a un bloque pequeño arriba a la izquierda, con todo blanco a la derecha —
      // lo que el usuario ve es «Modu no llena la ventana». Si hay una app en marcha se deja para la próxima ruta de arranque:
      // resetDisplayOverrides de installer.launch la fija antes del am start.
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} falta pero hay una aplicación en primer plano: se omite y se configurará en el próximo inicio (para evitar que la imagen se reduzca)`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // Autorreparación de orientación: el arranque de una app / la reconstrucción de la Activity / un aviso del sistema pueden volver a cambiar
      // user-rotation o «ignorar solicitudes de orientación de la app». en cuanto se cambian, la imagen en el panel horizontal queda tumbada 90°
      // (lo que el usuario dice: «el software en modo tableta siempre está tumbado a 90 grados»). Aquí cada ronda se lee el estado real,
      // y solo se corrige si **hay una discrepancia real**, sin escribir nada en condiciones normales.
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // Un emulador adoptado no tiene handle local de proc y vmRunning sería false:
      // antes se hacía return directamente y el contenedor nunca se reciclaba. Ahora se mira también si adb está en línea.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Diagnóstico / adelgazamiento (para que lo llame la UI) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // Los attempts en memoria solo valen para esta sesión; si el usuario reinicia y exporta el informe, están vacíos.
    // Entonces se usa el registro de fallo guardado en el disco y se añade la cola de emulator.log — si no, el informe
    // solo diría UNKNOWN y no se vería la causa real (las issues #20/#25 tropezaron justo aquí).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

/**
 * Reciclar imágenes / AVD / archivos de bloqueo / instantáneas antiguos del runtime.
 * La causa raíz de «le doy a limpiar y no limpia nada»: con el runtime en marcha, keepSnapshots excluía la instantánea de arranque rápido
 * del AVD actual (ram.img de varios GB), y con un solo AVD casi no quedaba nada que limpiar.
 * Ahora el llamador puede pasar includeSnapshots explícitamente: se para primero el runtime y se poda, y la instantánea sí se recicla.
 */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // Si se paró la máquina durante la vista previa, se avisa al usuario: al terminar puede reiniciar el runtime a mano
    return { ...report, apply, stoppedVm };
  }

/**
 * Resetear por completo los datos de Android (vaciar la partición de usuario /data + las apps instaladas + la instantánea de arranque rápido),
 * dejando el AVD en el estado limpio de «sistema recién instalado, sin ninguna app de terceros».
 * Esto borra de verdad una imagen de datos de usuario de 8–16 GB, así que exige confirmación doble (la hace la UI) y solo toca
 * el AVD activo actual (apkstart.avd), sin tocar la imagen base de solo lectura ni otros AVD.
 * Se conservan config.ini / hardware-qemu.ini; el AVD sigue siendo válido y la próxima apertura hará un arranque en frío que recrea los datos.
 * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
 */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Se borra: la imagen de datos de usuario (incluidos el differencing qcow2 y la base), la instantánea de arranque rápido y los archivos / directorios de bloqueo residuales.
          // Se conserva: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / todos los *.ini / *.txt / *.cache — son la identidad y la infraestructura del AVD,
          //       y borrarlos lo deja inservible o hace que el próximo arranque falle. Al volver a pulsar una app, el emulador recrea /data con semántica -wipe-data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* Lo que está ocupado se omite por ahora y se limpia la próxima vez */ }
        }
      }
      // Tras borrar la imagen de datos de usuario, hay que limpiar también el registro de «apps instaladas» del lado usuario,
      // o el escritorio / el lanzador seguirían mostrando apps que ya no existen.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

/**
 * Conectar el AndroidWifi «guardado pero que no se conecta solo» (no destructivo: no reinicia ni borra datos).
 * La implementación concreta y la causa en equipos reales están en emulator.repairWifi.
 *
 * @returns {Promise<boolean>} si se consiguió conectar
 */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

/**
 * Esperar a que la máquina virtual tenga red.
 *
 * En pruebas reales: `sys.boot_completed` solo significa que el sistema arrancó; la asociación Wi-Fi + DHCP tarda además
 * desde unos segundos hasta más de un minuto en conseguir el 10.0.2.16. Apps como Hongguo tiran de los datos de la portada al entrar,
 * y sin red la página se dibuja como un bloque negro entero (el aviso de privacidad es una página local y sí se ve bien),
 * y el usuario ve «tras pulsar Aceptar y continuar, sigue en negro». Por eso se espera a la red antes de lanzar la app.
 *
 * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
 */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // Una máquina recién reiniciada pasa un rato en que ni adb está en línea; no se puede desistir en cuanto se ve offline
        // (antes era así: justo después de resetear datos devolvía device-offline y se declaraba «falló la reparación»).
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` significa «la Wi-Fi ni se asoció», no «se asoció y espera DHCP».
        // Esperar a que agote el tiempo en este estado es perder el tiempo: en este arranque no se conectará sola (en equipos reales, AndroidWifi
        // suele quedar como «guardada pero no se conecta automáticamente»). Si esto se repite varias veces seguidas, se termina antes
        // para que el llamador haga enseguida la reconexión que sí funciona, en lugar de quemar 20 segundos en vano.
        // Se toman 3 intentos (≈9 s) en vez de 2: al arrancar, la Wi-Fi tarda unos segundos en asociarse,
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Esperando a que la máquina virtual Android se conecte a la red… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

/**
 * Reparar «la máquina virtual Android no tiene red».
 * En la inmensa mayoría de los casos es solo que la Wi-Fi se asocia más despacio que el arranque, y basta reiniciar y esperar un poco;
 * **no hace falta** borrar los datos del usuario; solo si se agota el tiempo de espera se avisa al usuario de que haga «Resetear datos de Android».
 *
 * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
 */
/**
 * Asegurar que la máquina virtual tenga red: primero se espera y, si no se consigue, se hace un arranque en frío (esquivando una instantánea que pudiera estar «sin red») y se espera otra vez.
 * Es la solución definitiva de «Hongguo sale negro tras pulsar Aceptar»: la app debe arrancar solo cuando la red está lista.
 *
 * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
 */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Primero se prueba lo barato: pulsar el AndroidWifi «guardado pero que no se conecta solo».
    // Este paso es órdenes de magnitud más ligero que un arranque en frío o un borrado de datos: no reinicia la máquina ni toca los datos.
    // En equipos reales, esta es la causa real de casi todos los «la máquina no tiene red» (véase el comentario de emulator.repairWifi).
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('La máquina virtual no puede conectarse a Wi-Fi; se está intentando reconectar…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`La red se restauró (${net.ip || ''}), se está guardando el estado de disponibilidad; la próxima vez será directo.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* Si la reparación falla, se pasa a la ruta pesada de abajo */ }
    }
    // El arranque en frío es caro (decenas de segundos) y en un proceso solo se hace una vez: si no, cada apertura de una app tendría que repetirlo,
    // y el usuario sentiría «pulsar y esperar varios minutos».
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('La red sigue sin estar lista; se arrancará la máquina virtual en frío una vez (sin cargar la instantánea) y se volverá a intentar…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // En cuanto la red funciona se guarda la instantánea, para que al restaurar se recupere también el estado de la tarjeta de red
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

/**
 * Reparar «la máquina virtual Android no tiene red».
 * Orden: arranque en frío (sin tocar datos) → esperar red → solo si sigue sin funcionar, resetear datos (pierde datos internos de la app).
 *
 * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
 */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Reparación por escalones, empezando por lo más barato: si se puede evitar perder datos, no se pierden:
      //   1) reconectar la Wi-Fi (sin reiniciar ni tocar datos)
      //   2) arranque en frío (sin cargar la instantánea, y sin tocar datos tampoco)
      //   3) solo al final, resetear datos
      onLog('Reparando la red de la máquina virtual: primero se intentará volver a conectar el Wi-Fi (no afecta a las aplicaciones instaladas)…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'La máquina virtual no pudo arrancar', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`La red se restauró (${net1.ip || ''}), se ha guardado una instantánea válida.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // Paso 2: arranque en frío, esquivando la instantánea que pudiera estar «sin red»
      onLog('La reconexión no funcionó; se arrancará la máquina virtual en frío una vez (sin instantánea, los datos se conservan)…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'La máquina virtual no pudo arrancar', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`La red se restauró (${network.ip || ''}), se ha guardado una instantánea válida.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // Paso 3: sigue sin red, solo queda resetear datos (pierde datos internos de la app)
      onLog('Sigue sin haber red; se reiniciarán los datos de Android y se volverá a arrancar (la lista de aplicaciones se conserva y se reinstalan al abrirlas)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Se da un poco de tiempo al qemu / netsimd anterior para que terminen de salir, o -wipe-data chocaría con el bloqueo del AVD
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'La máquina virtual no pudo arrancar', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Se guarda de inmediato el estado «red funcionando» como instantánea: al restaurar se recupera el estado de la tarjeta de red,
        // o si no, al cerrar y volver a abrir se volvería al estado sin red.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`La red se restauró (${network.ip || ''} Puerta de enlace ${network.gateway || 'Accesible'}), se ha guardado una instantánea válida.`);
      } else {
        onLog('Sigue sin haber red tras el restablecimiento. Comprueba que el firewall o la red local no bloqueen el emulador (netsimd usa un puerto de bucle local).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // La capa de adaptación de backend solo tiene el runtime incluido; dispose solo hace su propia limpieza y no toca ningún emulador externo
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // Aquí **no se puede** matar a qemu a la fuerza:
    //  1) matarlo a la fuerza corta una instantánea quickboot que se está escribiendo, y deja solo el cascarón de ram.img de varios GB;
    //     al arrancar falla la carga → arranque en frío completo: esa es la causa directa de «cada vez que abro hay que esperar dos minutos»;
    //  2) si se deja, la próxima vez se puede adoptar directamente y las apps abren al instante (mismo comportamiento que WSA / la versión de PC de Tencent MyApp).
    // En la desinstalación se sigue otra vía (app:removeSelf limpia los procesos explícitamente).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
