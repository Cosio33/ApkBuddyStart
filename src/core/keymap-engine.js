'use strict';
/**
 * Motor de runtime de mapeo de teclas
 *
 * Cuando la ventana de la aplicación está en primer plano: intercepta eventos de teclado →
 * consulta la tabla de mapeo de la aplicación actual → los convierte en comandos adb input.
 * Trabaja en paralelo con pointer.js (gancho del ratón): el ratón usa Qt nativo + ganchos de
 * botón derecho/rueda, y el teclado pasa por aquí. Ambos no se interfieren.
 *
 * Restricciones de diseño:
 *  - Módulo Node puro, sin dependencias de Electron BrowserWindow (facilita las pruebas unitarias);
 *  - Los comandos adb se envían mediante el callback inyectado `execInput(cmd)`, desacoplando AdbClient;
 *  - Cada comando tiene un intervalo mínimo (50 ms por defecto) para evitar que el adb shell se
 *    atasque por acumulación de comandos al pulsar teclas rápido;
 *  - Las tablas de mapeo se guardan por nombre de paquete de la aplicación y cambian automáticamente
 *    al cambiar de aplicación.
 */

const { lookup, toCommand } = require('./keymap');

class KeymapEngine {
  /**
   * @param {object} opts
   * @param {Function} opts.execInput  (cmd) => Promise — Envía comandos adb shell input
   * @param {Function} opts.getSize    () => {width, height} — Tamaño actual del LCD
   * @param {number}   [opts.minInterval=50]  Intervalo mínimo entre dos comandos (ms)
   */
  constructor({ execInput, getSize, minInterval = 50 } = {}) {
    this._exec = execInput || (() => Promise.resolve());
    this._getSize = getSize || (() => ({ width: 720, height: 1280 }));
    this._minInterval = minInterval;
    this._lastExec = 0;
    this._enabled = false;
    // pkg → mappings[]
    this._maps = new Map();
  }

  /** Establece la tabla de mapeo de una aplicación */
  setMap(pkg, mappings) {
    if (!pkg) return;
    if (!mappings || !mappings.length) { this._maps.delete(pkg); return; }
    this._maps.set(pkg, mappings);
  }

  /** Obtiene la tabla de mapeo de una aplicación */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** Activar/desactivar */
  enable(on) { this._enabled = !!on; }
  get enabled() { return this._enabled; }

  /**
   * Procesa un evento de teclado.
   * @param {string} key Electron KeyboardEvent.key
   * @param {string} pkg Nombre de paquete de la aplicación en primer plano
   * @returns {Promise<boolean>} Si se consumió la tecla (true = mapeada y enviada)
   */
  async handleKey(key, pkg) {
    if (!this._enabled || !pkg) return false;
    const mappings = this._maps.get(pkg);
    if (!mappings || !mappings.length) return false;
    const hit = lookup(mappings, key);
    if (!hit) return false;
    const { width, height } = this._getSize();
    const cmd = toCommand(hit, width, height);
    if (!cmd) return false;
    // Limitación de caudal: evita la acumulación de comandos en adb shell al pulsar rápido
    const now = Date.now();
    const wait = Math.max(0, this._minInterval - (now - this._lastExec));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastExec = Date.now();
    try { await this._exec(cmd); } catch (_) { /* Un fallo al inyectar la entrada no afecta al juego */ }
    return true;
  }
}

module.exports = { KeymapEngine };
