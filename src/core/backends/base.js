'use strict';
/**
 * Capa de adaptación de backend (backend driver): separa del Runtime la cuestión de «de dónde viene Android».
 *
 * Contexto: ApkBuddyStart originalmente solo tenía una base (el Google Android Emulator / QEMU incluido),
 * y el ciclo de vida del motor (arranque, instantáneas, reciclado en inactividad, descarga de imágenes)
 * estaba completamente codificado en core/engine.js.
 * Pero la experiencia de «hacer doble clic en un APK para instalarlo, doble clic en el icono para abrirlo
 * y una ventana limpia por aplicación» solo exige tres cosas de la base:
 *
 *   1. Un dispositivo adb al que se pueda conectar (instalación / arranque / entrada / capturas dependen de él);
 *   2. Una ventana de imagen de Android de la que se pueda obtener el HWND (incrustarla con SetParent en nuestra propia ventana);
 *   3. Poder arrancar / detener ese dispositivo.
 *
 * Desde la 0.5.6 solo se conserva una implementación: builtin (emulator + imagen del sistema incluidos).
 * Esta capa de interfaz se mantiene para que en engine.js la cuestión «de dónde viene Android» siga teniendo
 * un único punto de entrada, y para facilitar un futuro cambio de runtime sin tocar el flujo principal del motor;
 * pero **ya no se admite ningún emulador de terceros / runtime a nivel de sistema** (no se conectan MuMu / LDPlayer / BlueStacks / WSA).
 *
 * Convenciones (todas las implementaciones deben cumplirlas):
 *  - Todos los métodos pueden llamarse de forma concurrente; las implementaciones deben ser idempotentes;
 *    llamar dos veces a ensure() no debe arrancar dos instancias.
 *  - Cualquier fallo devuelve { ok:false, error }; no lances excepciones hacia arriba (la capa superior solo muestra avisos).
 *  - No asumas que tienes el servidor adb en exclusiva: usa el adb incluido si está disponible;
 *    si usas el de otro, conecta tú mismo.
 */

/** Bits de capacidad de la base: la capa superior decide qué menús/callbacks mostrar u omitir */
const CAPS = {
  /** Puede descargar/desplegar por sí mismo el runtime (imagen, emulator, adb) */
  provision: 'provision',
  /** Puede guardar instantáneas de arranque rápido (segundo arranque en segundos) */
  snapshot: 'snapshot',
  /** Puede ajustar el tamaño de la partición de datos */
  resizeData: 'resizeData',
  /** Puede restablecer por completo los datos de Android (/data) */
  resetData: 'resetData',
  /** Puede cambiar la orientación del panel físico (horizontal real, mediante reinicio) */
  rotatePanel: 'rotatePanel',
  /** Puede ajustar la prioridad del proceso (ceder la máquina virtual a la aplicación en primer plano) */
  priority: 'priority',
  /** Puede apagarse por completo (se llama al desinstalar/salir) */
  shutdown: 'shutdown',
  /** La ventana de imagen la crea software de terceros; no hay que «tomar prestada» demasiado su ventana (evita quitarle al usuario su propio emulador) */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param {object} appRoot Directorio raíz del programa (tras empaquetar: resources/app)
   * @param {object} deps    Dependencias compartidas: { store, log }
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** Número de serie de adb (p. ej. emulator-5554 / 127.0.0.1:16384) */
    this.serial = '';
    /** Ruta absoluta de adb.exe */
    this.adbPath = '';
    /** Último error, para diagnóstico */
    this.lastError = '';
  }

  /** id estable de la base (se escribe en la configuración; no cambiar a la ligera) */
  static get id() { return 'base'; }

  /** Nombre mostrado en la interfaz */
  static get label() { return 'Backend sin nombre'; }

  /** Breve descripción; la página de ajustes la usa para explicar qué es esta base */
  static get summary() { return ''; }

  /** Si esta base cumple el requisito de «ventana incrustada» (las que no, solo sirven para attach) */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** Conjunto de bits de capacidad, véase CAPS */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** Si la base actual ya está en marcha (no requiere estar conectado a adb) */
  running() { return false; }

  /**
   * Sondeo: comprobar si esta base existe en la máquina.
   * Se usa para «elegir automáticamente una base usable»; debe ser rápido (<1.5 s) y sin efectos secundarios.
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * Comprobación de disponibilidad: si el usuario puede usarla ya para instalar aplicaciones.
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: 'No implementado' }; }

  /** Resolver la ruta de adb usable (primero la incluida, luego la de la base y por último el PATH del sistema) */
  async resolveAdb() { return ''; }

  /**
   * Asegurar que el runtime esté disponible: arrancar si no está encendido, conectar si no está conectado.
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: 'No implementado' }; }

  /**
   * HWND candidatos de la ventana de imagen de Android (array de cadenas hexadecimales o decimales, ordenado por prioridad).
   * La capa superior (WinAgent) prueba SetParent con cada uno; el primero que funcione se considera incrustado con éxito.
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * Si la ventana de imagen está lista (se puede dejar de ocultar / empezar a incrustar).
   * Por defecto: si se obtienen ventanas candidatas, se considera lista. La ventana del emulator incluido
   * la levantamos nosotros, así que la implementación por defecto basta; se conserva este gancho para tener
   * dónde esperar a la imagen si en el futuro se cambia de runtime.
   *
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * Ocultar la ventana de imagen (durante el arranque / precalentamiento, el usuario no debe ver el emulador).
   * Si no se obtiene la ventana, devuelve null silenciosamente.
   * @returns {Promise<string|null>} El HWND que se ocultó
   */
  async hideWindow() { return null; }

  /** Detener el runtime */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: 'No implementado' }; }

  /** Descargar/desplegar componentes que faltan (solo deben implementarlo las bases con CAPS.provision) */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: 'Este backend no admite la implementación automática' }; }

  /** Estadísticas de ocupación (página de ajustes «Uso del runtime») */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** Información de la partición de datos */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** Ajustar la partición de datos */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: 'Este backend no admite ajustar la partición de datos' }; }

  /** Restablecer por completo los datos de Android */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: 'Este backend no admite restablecer los datos' }; }

  /** Liberar recursos (se llama al salir de ApkBuddyStart; por defecto no hace nada) */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** Información de diagnóstico (se escribe en el informe de incidencias) */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
