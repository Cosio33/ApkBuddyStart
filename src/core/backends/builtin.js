'use strict';
/**
 * Base: el Google Android Emulator incluido (virtualización completa del sistema con QEMU)
 *
 * Es la base predeterminada de ApkBuddyStart y la única «totalmente autosuficiente»:
 * adb / emulator / imagen del sistema los descarga y gestiona el propio ApkBuddyStart,
 * sin depender de qué emulador tenga ya instalado el usuario.
 *
 * La implementación real está en core/engine.js (Runtime) y core/emulator.js (EmulatorEngine);
 * este archivo solo hace una capa de adaptación delgada, traduciendo sus interfaces a las
 * convenciones de esta capa, para que la capa superior no necesite saber lo complejo que es
 * la base propia internamente.
 *
 * Nota: este backend depende de la instancia de Runtime, que se inyecta en el constructor
 * mediante deps.runtime.
 */
const fs = require('fs');
const path = require('path');
const { Backend, CAPS } = require('./base');
const { freeDiskMB } = require('../doctor');
const { diskRequiredMB, diskVerdict, hostProfile, memoryLimits, memVerdict, diskLimits } = require('../resources');

class BuiltinBackend extends Backend {
  static get id() { return 'builtin'; }

  static get label() { return 'Entorno integrado (Android Emulator + QEMU)'; }

  static get summary() {
    return 'Cero dependencias de terceros: apkstart descarga y gestiona él mismo la imagen de Android 14; las aplicaciones ARM usan la capa de traducción incluida en la imagen.'
      + 'El primer arranque tarda unos 25 segundos; después, la instantánea quickboot lo reduce a segundos.';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.rt = deps.runtime || null;
  }

  get caps() {
    return new Set([
      CAPS.provision, CAPS.snapshot, CAPS.resizeData,
      CAPS.resetData, CAPS.rotatePanel, CAPS.priority, CAPS.shutdown,
    ]);
  }

  // serial se implementa como campo escribible y no como getter: el constructor de la clase base
  // hace `this.serial = ''`; si definimos un getter aquí, esa asignación lanzaría TypeError
  // (un getter en el prototipo no es escribible). Cuando se necesita el valor en tiempo real,
  // ensure() lo obtiene del Runtime y lo escribe aquí.
  syncSerial() {
    if (this.rt) this.serial = this.rt.emuSerial || '';
    return this.serial;
  }

  running() { return !!(this.rt && this.rt.emuRunning); }

  async probe() {
    if (!this.rt) return { ok: false, found: false, detail: 'Entorno no inicializado' };
    const p = this.rt.provisioner.paths();
    const found = fs.existsSync(p.emulatorExe) || fs.existsSync(p.adbExe);
    return { ok: true, found, path: p.emulatorExe, detail: p.root };
  }

  async check() {
    if (!this.rt) return { ok: false, reason: 'Entorno no inicializado' };
    const env = await this.rt.provisioner.checkEnv().catch(() => null);
    if (!env) return { ok: false, reason: 'Error al detectar el entorno' };
    if (!env.adb.ok) return { ok: false, reason: 'Falta adb', needs: 'adb' };
    if (!env.emulator.ok) return { ok: false, reason: 'Falta Android Emulator', needs: 'emulator' };
    if (!env.sysimg.ok) return { ok: false, reason: 'Falta la imagen del sistema', needs: 'sysimg' };
    return { ok: true, env };
  }

  async resolveAdb() { return this.rt ? this.rt.adbPath() : ''; }

  async ensure({ onLog = () => {} } = {}) {
    if (!this.rt) return { ok: false, error: 'Entorno no inicializado' };
    const r = await this.rt.ensure({ onLog });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'El entorno Android no pudo iniciarse' };
    // serial es un campo escribible (véase la nota de syncSerial); sincronizar una vez tras ensure correcto
    this.syncSerial();
    this.adbPath = this.rt.adbPath();
    return {
      ok: true, serial: this.serial, adbPath: this.adbPath, reused: !!r.reused, client: r.client, engine: 'emulator',
    };
  }

  /**
   * La ventana de imagen del emulator incluido no ofrece identificadores candidatos: WinAgent la
   * encuentra con FindEmulator() según el ámbito del directorio del proceso (véase core/win/agent.ps1),
   * de modo que no haya confusiones aunque cambie el título de la ventana.
   */
  async windowTargets() { return []; }

  /**
   * Si la ventana de imagen ya está incrustada en el host.
   * isEmbedded lo inyecta WinAgent (pregunta a agent.ps1 si el padre actual de _emu es el host);
   * si no se inyecta, se devuelve true de forma conservadora: la base incluida siempre usa la ruta
   * antigua y no necesita esta comprobación.
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded !== 'function') return { ok: true };
    return { ok: !!isEmbedded };
  }

  async stop({ graceful = true } = {}) {
    if (!this.rt) return { ok: false, error: 'Entorno no inicializado' };
    const ok = await this.rt.stop({ graceful }).catch((e) => ({ error: e.message }));
    return { ok: ok !== false };
  }

  async install(component, onProgress = () => {}) {
    if (!this.rt) return { ok: false, error: 'Entorno no inicializado' };
    const prov = this.rt.provisioner;
    switch (component) {
      case 'runtime': return prov.installRuntimePack(onProgress);
      case 'adb': return prov.installAdb(onProgress);
      case 'emulator': return prov.installEmulator(onProgress);
      case 'sysimg': return prov.installSystemImage(onProgress);
      case 'playimg': return prov.installPlayImage(onProgress);
      case 'aehd': return prov.installAehd(onProgress);
      case 'qemu': return prov.installQemu(onProgress);
      default: return { ok: false, error: `Componente desconocido ${component}` };
    }
  }

  usage() { return this.rt ? this.rt.usage() : { total: 0, items: [] }; }

  dataInfo() { return this.rt ? this.rt.emulator.dataInfo() : { ok: false }; }

  /**
   * Para mostrar en la página de ajustes: límites del host + asignación actual.
   * La memoria/CPU del runtime incluido se escribe en la línea de comandos de qemu; los cambios
   * se aplican la próxima vez que arranque Android. La partición de datos se puede ampliar in situ
   * (resizeData) sin perder las aplicaciones instaladas.
   */
  resources() {
    const info = this.dataInfo() || {};
    const host = hostProfile();
    const eng = (this.rt && this.rt.settings && this.rt.settings.engine) || {};
    const freeMB = info.avdDir ? freeDiskMB(info.avdDir) : 0;
    const memMB = Number(eng.memoryMB) || 0;
    return {
      backend: 'builtin',
      host,
      limits: { ...memoryLimits(host.totalMB), ...diskLimits(freeMB) },
      wanted: { memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0, cores: Number(eng.cores) || 0 },
      current: {
        memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0,
        cores: Number(eng.cores) || 0,
        dataGB: Number(info.configuredGB) || 0,
        imageGB: Number(info.imageGB) || 0,
      },
      freeMB,
      pending: false,
      verdict: memVerdict(memMB, host.totalMB),
      note: 'La memoria/CPU del entorno integrado se aplica la próxima vez que arranque Android; para ampliar la partición de datos, pulsa «Ampliar ahora» —'
        + 'Si se puede ampliar in situ, se conservan las aplicaciones instaladas; cuando Android esté usando una instantánea diferencial se te pedirá restablecer y reconstruir con el nuevo tamaño.',
    };
  }

  /**
   * Comprobación previa de paquetes grandes: además del disco físico, hay que ver si la partición
   * /data misma tiene espacio suficiente. La causa más común de que no quepan juegos de 50 GB no es
   * un fallo de descarga, sino que la imagen userdata sigue siendo la predeterminada de 6/8 GB:
   * el error INSTALL_INSUFFICIENT_STORAGE no aparece hasta la fase de dexopt.
   */
  checkDiskFor(bytes) {
    const info = this.dataInfo() || {};
    const need = diskRequiredMB(bytes);
    const phys = diskVerdict(info.avdDir ? freeDiskMB(info.avdDir) : 0, need);
    if (!phys.ok) return phys;
    const capGB = Number(info.configuredGB) || 0;
    if (capGB && capGB * 1024 < need) {
      return {
        ok: false,
        message: `Partición de datos de Android insuficiente: actualmente ${capGB} GB; para este juego se recomiendan al menos ${Math.ceil(need / 1024)} GB。`
          + 'Aumenta «Capacidad de la partición de datos» en Ajustes → Motor y reinicia Android (se ampliará in situ, sin perder aplicaciones).',
      };
    }
    return { ok: true, requiredMB: need };
  }

  async resizeData(mb) { return this.rt ? this.rt.emulator.resizeDataPartition(mb) : { ok: false }; }

  async resetData() { return this.rt ? this.rt.resetAndroidData() : { ok: false }; }

  dispose() {
    // Se delega a Runtime.dispose(): conserva el proceso qemu para poder retomarlo en el próximo arranque
  }

  diagnose() {
    const p = this.rt ? this.rt.provisioner.paths() : {};
    return {
      backend: 'builtin',
      serial: this.serial,
      root: p.root || '',
      emulator: p.emulatorExe || '',
      running: this.running(),
    };
  }
}

module.exports = { BuiltinBackend, BACKEND_ROOT: path.dirname(__dirname) };
