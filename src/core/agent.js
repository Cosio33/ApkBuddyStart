'use strict';
/**
 * Agente de ventanas de Windows: se comunica con el proceso residente de src/core/win/agent.ps1.
 *
 * ¿Por qué no lanzar un PowerShell cada vez?: al arrastrar la ventana siguiendo al ratón, el tamaño cambia constantemente,
 * y arrancar un powershell.exe tarda 150~300 ms, por lo que el arrastre iría a tirones.
 * Aquí se inicia una sola vez y después se usa TCP de bucle local (un JSON por línea), con ida y vuelta <2 ms.
 *
 * El agente puede hacerse cargo del hook de ratón WH_MOUSE_LL: volver con el botón derecho / desplazamiento con la rueda /
 * avanzar y retroceder con los botones laterales. El hook es global e interviene en cada evento de ratón del sistema,
 * por lo que solo se instala cuando «la ventana de la app está en primer plano» y hay al menos una asignación activa;
 * se desinstala en cuanto se pierde el foco; la callback solo gestiona los 7 mensajes que nos interesan.
 * Véase setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Iniciar el agente y esperar a que conecte por TCP (idempotente) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Proxy de ventana no disponible')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('El agente de ventanas se ha cerrado');
        if (wasReady) this.emit('exit');
        fail(new Error('Error al iniciar el agente de ventanas'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Tiempo de espera del agente de ventanas agotado')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Conexión con el agente de ventanas perdida');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Los eventos llevan carga útil (dx/dy/nx/ny de la rueda); los listeners antiguos pueden ignorar los argumentos de más
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Enviar un comando y esperar la respuesta */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Proxy de ventana sin conexión');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tiempo de espera del proxy de ventana: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- Métodos de conveniencia ----------------

  /**
   * Declarar «de qué directorios se considera que los procesos son nuestros».
   * Debe llamarse antes de bootHide / embed: el agente de ventanas solo puede tocar ventanas creadas por esos procesos.
   * Si no se pasa (o se pasa vacío), el agente no toca ninguna ventana: mejor dejar escapar alguna ventana negra de vez en cuando
   * que ocultar o acoplar ventanas de otras apps Qt (WeChat 4.x usa Qt6, MuMu, reproductores de música).
   * @param {string[]} dirs directorio raíz del runtime / directorio engine incluido en el paquete
   * @param {number} [appPid] pid del proceso principal: el agente solo puede acoplar ventanas a ventanas de este proceso,
   *        y con eso decide si «la ventana actual del evento de ratón es nuestra» (evita reutilización de handles reciclados)
   */
  async scope(dirs, appPid) {
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const req = { cmd: 'scope', dirs: list.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * Acoplar la ventana de imagen a la ventana anfitriona y colocarla en x,y,w,h (coordenadas del área cliente del anfitrión).
   *
   * @param {number|string} hostHwnd handle de la ventana anfitriona
   * @param {object} rect { x, y, w, h, clipTop }
   * @param {string[]} [targets] handles candidatos informados por una base de terceros ("0x…").
   *        Si no se pasa = comportamiento anterior: el agente busca por su cuenta la ventana del emulator incluido según el ámbito de proceso.
   *        Si se pasa = acoplar solo uno de esos handles (la ventana de imagen de MuMu / otros emuladores).
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** Cuántos de los handles candidatos siguen existiendo (para la puerta de listo de bases de terceros) */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // La ventana Qt del emulador tiene un marco EMU_PAD además de la LCD; lo hacemos desbordar hacia arriba/izquierda para
      // sacar ese marco del área cliente; la franja que desborda sobre la barra de título se recorta (si no, al pulsar los botones de la barra aparece un borde negro).
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Avisar al agente de que entre en modo de baja latencia: reducir mucho la frecuencia de escaneo de ventanas y dejar la CPU para el renderizado de Android */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param {boolean} keep true= pasar a modo de ventana independiente (no ocultar la ventana del emulador y conservar su handle) */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** Modo de ventana independiente: colocar la ventana nativa del emulador en el rectángulo de pantalla indicado (sin acoplar) */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * Cambiar el título de la ventana nativa del emulador de "Android Emulator - apkstart:5554" a un nombre comprensible para el usuario.
   * Si se pasa una cadena vacía, se usa "ApkBuddyStart" por defecto. El agente sigue poniéndolo en sus inspecciones (Qt a veces lo cambia de nuevo).
   */
  async setTitle(text = 'ApkBuddyStart') {
    return this.call({ cmd: 'title', text: String(text || 'ApkBuddyStart') }, 4000);
  }
  /**
   * Poner un icono a la ventana nativa del emulador (en modo independiente, barra de tareas/Alt+Tab muestran el icono de la app actual).
   * @param {string} file ruta absoluta a PNG/ICO
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** Listar las ventanas de nivel superior visibles ahora (para verificar que «solo está la interfaz del software / solo la ventana de la app Android») */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * «Descolgar y ocultar» la ventana más sospechosa.
   * Debe llamarse antes de destruir la ventana anfitriona: Windows vuelve a colgar en el escritorio las ventanas hijas entre procesos
   * cuando se destruye la ventana padre, y conserva su estado de visibilidad original — de ahí sale la ventana negra de Android Emulator
   * que aparece de la nada en el escritorio.
   * Aunque el agente esté ocupado (puede estar compilando C#), no se puede tardar en cerrar la ventana, por lo que se pone un límite duro de 700 ms.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Activar la «supresión residente»: la ventana principal del emulador (QWindowIcon) + la barra de herramientas + las ventanas negras de consola
   * de qemu / netsimd no deben mostrarse nunca, salvo la que está acoplada a nuestra ventana.
   * Esta es la clave de «al abrir el programa solo se ve la interfaz del programa»: el emulator lanza procesos de consola qemu / netsimd
   * detached a los que no llega windowsHide de Node, y solo el agente de ventanas puede mantenerlos ocultos periódicamente.
   * Ahora además el emulador lleva -qt-hide-window (la ventana se oculta al crearla), doble seguridad: ni el primer fotograma parpadea.
   *
   * maxWaitMs: el propio agente hay que compilarlo y arrancarlo al momento (algunos cientos de ms, en casos anómalos puede ser decenas de segundos).
   * El punto de llamada es «antes de lanzar el emulator»; un fallo del agente no puede retrasar el arranque, por eso se pone un límite duro.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Desactivar la supresión residente (normalmente ya no hace falta: tras acoplar, la supresión omite sola la ventana acoplada) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Interruptor global del hook de ratón (idempotente).
   * Solo se instala con la ventana de la app en primer plano y al menos una asignación activa; si cambian las opts no se reinstala el hilo,
   * solo se envían los nuevos valores al agente residente, para evitar instalar/desinstalar el hook cada vez que se cambia el foco o los ajustes.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Con el estado por defecto desactivado, no se lanza PowerShell «para desactivar» (coste cero en arranque en frío)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Primero se desinstala el hook global y después se termina el proceso: aunque el agente reciba un kill, no queda ningún hook residual en el sistema
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // Deliberadamente no se mata al proceso del agente: al desconectarse entra solo en estado de «guardia» (véase _lingerUntil en agent.ps1).
    // El emulador puede seguir arrancando y mostrar la ventana decenas de segundos después; si para entonces el agente ha muerto,
    // quedaría una ventana negra de Android Emulator en el escritorio. Cuando el proceso del emulador desaparece,
    // el agente sale por sí solo, con un máximo de 3 minutos de guardia.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
