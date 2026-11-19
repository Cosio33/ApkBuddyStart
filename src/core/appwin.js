'use strict';
/**
 * Ventana de aplicación: una app de Android en ejecución = una ventana limpia de Windows.
 *
 * La ventana solo tiene una franja de título de 38 px arriba (girar / minimizar / maximizar / cerrar);
 * toda la imagen de debajo es la ventana del emulador incrustada (SetParent), así que no se ve el escritorio de Android,
 * ni la barra de herramientas lateral del emulador, ni aparece un segundo icono en la barra de tareas.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { physicalRect } = require('./geometry');

const TITLEBAR_H = 38;
/**
 * La ventana del emulador lleva 8 px de relleno gris alrededor (margen del borde de Qt),
 * y la imagen LCD real empieza en +8 px. Si se amplía la ventana hija 16 px y se desplaza 8 px hacia arriba/izquierda,
 * ese borde gris queda justo fuera del área cliente y la imagen cubre los bordes limpiamente.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // Fuentes de handles candidatos de la ventana de imagen: ahora solo hay una base, siempre null,
    // y el agente de ventanas la busca por ámbito de proceso (estas ventanas las crea el emulator que nosotros lanzamos).
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // El hook global de ratón solo se instala si «la ventana de la app está en primer plano y hay al menos una asignación activa».
    // pointerConfig se pasa como función: si se cambia un interruptor en Ajustes, surte efecto en el próximo foco sin reiniciar.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Tamaño objetivo del contenido de la ventana en vertical / horizontal (se escala automáticamente para caber en pantalla) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Margen suficiente: 38 de título + 24 arriba y abajo, 40 a izquierda y derecha
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Doble seguridad: nunca superar el área disponible de pantalla, o el sistema la recortaría y se vería «con bordes negros / sin llenar»
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    // workArea está en DIP (píxeles lógicos). El proceso del agente de ventanas es per-monitor DPI-aware y
    // SetWindowPos recibe píxeles físicos, así que en modo de ventana independiente hay que multiplicar este valor por sf
    // antes de pasárselo a agent.layout. sf y area proceden de la misma pantalla, así que con varios monitores no se usa la escala equivocada.
    return { x: a.x, y: a.y, w: a.width, h: a.height, sf: d.scaleFactor || 1 };
  }

  /**
   * La ventana nativa del emulador bloquea la relación de aspecto según el panel del dispositivo; dar una proporción errónea la hace volver a la correcta.
   * Aquí se calcula la relación w/h que debe tener la ventana actual (incluida la altura del título) para dar el tamaño correcto a la primera.
   * En modo de ventana independiente, la ventana del shell está oculta y bounds puede ser el valor vertical por defecto,
   * así que hay que corregir según la orientación del panel (horizontal: ancho > alto, ratio > 1).
   */
  _panelRatio() {
    const b = this.win ? this.win.getBounds() : this._area();
    if (b && b.width > 0 && b.height > 0) {
      // Con un panel horizontal, los bounds de la ventana del shell pueden seguir verticales (oculta en modo detached);
      // leerlos directamente da 0.56 (9:16), pero el panel real es 16:9.
      // En ese caso se usa h/w de portrait como ancho (horizontal = panel vertical girado 90°)
      if (this.state.landscape && b.height > b.width) {
        return b.height / b.width;
      }
      return b.width / b.height;
    }
    return 0.5625; // Respaldo vertical 9:16
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Convertir un rectángulo en DIP (píxeles lógicos) a píxeles físicos para el SetWindowPos del agente de ventanas.
   * Las coordenadas de screen/BrowserWindow de Electron son siempre DIP; pero agent.ps1 declara conciencia DPI
   * per-monitor v2 en lo alto del archivo, y el SetWindowPos de Win32 recibe píxeles físicos. Mezclarlos
   * con escalado del 125 %/150 % es la causa de «la ventana sale a medias / se va a una esquina / los clics están desplazados»
   * (issue #99). _rect() ya multiplicó por sf; aquí se añade el eslabón que faltaba en el modo de ventana independiente.
   */
  _physical(rect, sf) {
    return physicalRect(rect, sf || this._scale());
  }

  /**
   * Abrir (o reutilizar) la ventana de la aplicación.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached,
   *                     showWhileWaiting, onClosed }
   *        con detached=true se usa el «modo de ventana independiente»: el shell solo se carga sin mostrarse y la imagen está en la ventana nativa del emulador.
   *        con showWhileWaiting=true, **durante la espera** se muestra antes el shell (con un texto de aviso);
   *        cuando se conecta la ventana del emulador, openDetached() lo recoge. Cambiar a una app de otra orientación
   *        requiere reiniciar el runtime (unos 40 s) y antes no aparecía nada en pantalla, y el usuario pensaba que se había colgado.
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached } = o;
    this.detachedMode = !!detached;
    this._showWhileWaiting = !!o.showWhileWaiting;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      // En modo de ventana independiente, el shell nunca debe asomar (no tiene contenido, es solo un negro).
      // Si el usuario vuelve a pulsar la misma app, lo que quiere es «traer al frente la ventana que está viendo»;
      // se delega al agente de ventanas para que eleve la ventana nativa del emulador.
      if (this.detachedMode) this.agent.show().catch(() => {});
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    // Se recuerda la ruta original del icono: en modo independiente hay que ponérsela a la ventana nativa del emulador (Win32
    // LoadImage solo acepta rutas de archivo, no las data URL que usa HTML).
    this.iconFilePath = iconPath || '';
    this.portrait = portrait || { w: 540, h: 960 };
    // En modo independiente, «pantalla completa» debe aplicarse a la ventana del emulador (nuestra capa shell está oculta;
    // maximizar una ventana oculta no tiene ningún efecto visual; openDetached leerá esta marca).
    this._wantFullscreen = !!fullscreen;
    this.state = { label: label || 'Aplicación', tip: 'Iniciando el entorno Android…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkBuddyStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // El título de la página cambiaría el título de la ventana por el <title> de shell.html y la barra de tareas dejaría de reconocer la app,
    // aquí se bloquea para que el título del SO siga siendo siempre el nombre de la app (lo usan la información al pasar el ratón por la barra y Alt+Tab).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkBuddyStart'); } catch (_) { /* La ventana puede haberse destruido */ }
    });
    this.win.once('ready-to-show', () => {
      // En modo independiente, la imagen de Android está en la ventana nativa del emulador y nuestra capa no tiene contenido que mostrar;
      // dejarla solo añadiría una ventana vacía negra. Así que solo se carga, no se muestra (el caparazón sigue existiendo para la lógica de estado/cierre).
      // Excepción: showWhileWaiting (al cambiar de app no hay animación de arranque que lo cubra): entonces más vale mostrar este
      // caparazón de «Abriendo xxx…» que dejar al usuario mirando un escritorio vacío 40 segundos.
      if (this.detachedMode && !this._showWhileWaiting) return;
      this.win.show();
      this._push();
    });

    // Al maximizar Electron, el tamaño de la ventana se estabiliza en varios pasos (animación del SO, recálculo DPI),
    // y un único fit con 40 ms de antirrebote suele cazar un estado intermedio, de modo que la imagen incrustada solo ocupa una franja arriba
    // y queda un gran espacio en blanco a la derecha: lo que el usuario captura como «al maximizar no llena».
    // Se cambia a varias rondas consecutivas de ajuste convergente, recalculando cada ronda según el getContentBounds más reciente.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() se encarga del remate cuando termina park
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Las rutas de cierre que no pasan por close() (Alt+F4, cerrar desde la barra de tareas, apagado del sistema) también deben detener la app de Android
      // y desacoplar la ventana del emulador. Si no, la ventana desaparece pero la app sigue corriendo en segundo plano y al volver a pulsar se cambia
      // directamente a ella por «ya está en ejecución»: el usuario lo ve como «no se puede cerrar».
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Solo se instala el hook global si «la ventana de la app está realmente en primer plano» y hay al menos una asignación de ratón activa;
    // al perder el foco o cerrar se descarga de inmediato: ApkBuddyStart no debe ralentizar el ratón de todo el sistema en segundo plano.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    // Ojo: maximize() muestra directamente una ventana con show:false.
    // En modo independiente la imagen está en la ventana nativa del emulador, así que este maximize hace aparecer
    // un caparazón negro vacío en mitad de la pantalla: la mitad de los «abro una app y salen varias ventanas» que reportan los usuarios viene de aquí.
    if (fullscreen && !this.detachedMode) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // En modo juego / baja latencia no se instala en absoluto el hook global de ratón: WH_MOUSE_LL llama a la callback de forma síncrona
    // para cada evento de ratón del escritorio y aumenta notablemente la latencia del puntero; un FPS necesita que la ventana Qt reciba la entrada cruda directamente.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Ajustes de mapeo de ratón cambiados en la página de Ajustes: se resincroniza según el foco actual (sin reinstalar el hilo del hook) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // La ventana no está en primer plano: solo se descarga, para que el hook no esté girando en vacío en segundo plano
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* La ventana puede haberse cerrado hace poco */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Incrustar la ventana del emulador en la ventana actual y rellenar el área debajo del título.
   * No se desactiva la supresión residente: omite «la ventana ya incrustada en la nuestra» y sigue conteniendo las demás (incluidas las ventanas
   * negras de consola de qemu / netsimd) — desactivarla solo daría una oportunidad más de que vuelvan a asomar.
   * La ventana del emulador a veces aún no se ha creado (en máquinas donde la restauración de la instantánea es muy rápida); aquí se reintenta dos veces.
   */
  /**
   * Modo de ventana independiente: **no** se incrusta el emulador en nuestra ventana, sino que se le deja abrir su ventana nativa.
   *
   * Por qué existe esta vía: incrustar (SetParent) da una imagen unificada, pero arrastra una larga serie de molestias —
   * orden Z entre primer/segundo plano, bordes negros, desajuste de coordenadas, no llenar tras maximizar, y el panel de Qt peleándose con la proporción del anfitrión.
   * Todas son el coste inherente de «meter la ventana de otro en la propia».
   *
   * En modo independiente, la ventana del emulador es nativa del sistema: orientación, escalado y entrada los gestiona ella,
   * y toda esa clase de problemas desaparece de raíz. El coste es un icono más en la barra de tareas y una imagen menos unificada.
   *
   * @returns {Promise<boolean>} si se consiguió pasar al modo independiente
   */
  async openDetached() {
    if (!this.isOpen) return false;
    // En modo independiente el caparazón nunca debe asomar (no tiene contenido, solo sería negro).
    // Pero con showWhileWaiting ahora mismo está visible como «aviso de espera»; aquí se encarga de recogerlo.
    try { this.win.hide(); } catch (_) { /* ignore */ }
    // Primero se asegura de que no siga incrustado (al venir del modo incrustado, el padre de _emu sigue siendo el anfitrión).
    // keep=true: se dice al agente que esto es «pasar a ventana independiente» y no «terminar la incrustación» —
    // si no, escondería como trastos la ventana del emulador que el usuario está viendo.
    const dt = await this.agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    // El título debe ponerse antes del show.
    // El proceso agente es residente y guarda en caché «el último título puesto» (_ourTitle); en cuanto se muestra una ventana nueva de emulator
    // se le pone ese título viejo — al cambiar de app, la ventana parpadea 0,5 s con el **nombre de la app anterior**, y en el primer arranque
    // sale "Android Emulator - apkstart:5554". Antes el orden era show() → setTitle(), así que medio segundo se veía seguro.
    const title = this.state && this.state.label ? this.state.label : 'ApkBuddyStart';
    await this.agent.setTitle(title).catch(() => {});
    await sleep(600);
    // Se consigue que la ventana del emulador sea realmente visible
    const shown = await this.agent.show().catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (!shown || shown.ok === false) { this.lastEmbedError = this._detachedDebug; return false; }
    // El icono también se cambia al de la app actual: la ventana nativa del emulador trae el robot verde de Google y en modo independiente
    // se delataría en la barra de tareas / Alt+Tab. Win32 LoadImage funciona mejor con .ico (PNG no siempre se acepta);
    // installer ya generó un .ico con el mismo nombre para cada app, así que se usa ese primero.
    const icoForNative = this.iconFilePath
      ? this.iconFilePath.replace(/\.png$/i, '.ico')
      : '';
    if (icoForNative && fs.existsSync(icoForNative)) {
      try { await this.agent.setIcon(icoForNative); } catch (_) { /* ignore */ }
    } else if (this.iconFilePath) {
      try { await this.agent.setIcon(this.iconFilePath); } catch (_) { /* ignore */ }
    }
    await sleep(300);
    // Se centra y dimensiona según el área disponible de pantalla.
    // Ojo: la ventana nativa del emulador bloquea su relación de aspecto según el panel del dispositivo (vertical 9:16);
    // si se le da un w/h que no encaja, vuelve a fijar el ancho al valor que corresponde a la altura y sale «le puse 1280 de ancho
    // y solo tiene 400». Por eso aquí se calcula el tamaño según la proporción del panel y se da bien a la primera.
    //
    // Con pantalla completa («pantalla completa al arrancar») se llena todo el área disponible; con un panel horizontal la relación de aspecto ya encaja
    // con la pantalla, y llenar no deja bordes negros — esa es la razón por la que el horizontal merece más la pantalla completa que el vertical.
    const area = this._area();
    const ratio = this._panelRatio();
    let w;
    let h;
    let x;
    let y;
    if (this._wantFullscreen) {
      w = area.w;
      h = area.h;
      x = area.x;
      y = area.y;
      // Se sincroniza la marca de pantalla completa; si no, la primera vez que se pulse «Maximizar» se interpretaría como «entrar en pantalla completa» en vez de restaurar.
      this._detachedFullscreen = true;
    } else {
      this._detachedFullscreen = false;
      const maxH = Math.min(area.h - 140, 1000);
      const maxW = Math.min(area.w - 80, 1280);
      w = maxW;
      h = Math.round(w / ratio);
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + 60);
    }
    // area/x/y/w/h son DIP (píxeles lógicos) de Electron, mientras que el SetWindowPos del agente recibe
    // píxeles físicos. Sin convertir con escalado del 150 %, la ventana sale a 2/3 y desplazada a la esquina superior izquierda: es el
    // «sale a medias» de la issue #99. _rect() (modo incrustado) ya multiplicó por sf; aquí se cubre el hueco del modo independiente.
    const lay = await this.agent.layout(this._physical({ x, y, w, h }, area.sf))
      .catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedError = this._detachedDebug;
    this.lastEmbedOk = false;
    return !!(lay && lay.ok !== false);
  }

  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // Si el exterior da handles candidatos (interfaz histórica, ahora siempre null); si no se consiguen, se espera un momento y se reintenta
      // — los handles se reasignan en cada arranque y guardar uno viejo incrustaría la ventana en el sitio equivocado.
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) { this.lastEmbedOk = true; return true; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Se propaga el motivo del fallo: la capa superior lo escribe en app.log y, si hay un problema, se ve a simple vista si fue «no se encontró la ventana del emulador»
    // o «falló SetParent», sin tener que adivinar.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});  }

  /** Rectángulo que debe ocupar la ventana hija del emulador (píxeles físicos, con los 8 px de relleno empujados fuera del área visible) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // Ese -EMU_PAD de arriba se apoya sobre la barra de título; el agente de ventanas se encarga de recortarlo (véase clipTop en agent.fit)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds cuántas rondas consecutivas de ajuste (cada ronda recalcula los bounds más recientes al cambiar el tamaño de la ventana)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Cambiar entre horizontal y vertical (botón de girar de la barra) = cambiar de verdad el «panel físico» a horizontal o vertical.
   *
   * Por qué hay que hacerlo así (trampas ya pisadas):
   *   - Cambiar wm size: solo altera la resolución lógica de Android; la LCD física del emulador sigue vertical,
   *     y Qt pega la imagen arriba a la izquierda → imagen tumbada 90°, una sola franja, bordes negros y clics desplazados;
   *   - Cambiar wm density: el tamaño del framebuffer no cambia, la imagen no llena y al maximizar queda un gran espacio a la derecha;
   *   - adb emu rotate: solo gira el contenido de la imagen; el sistema sigue en vertical.
   * La única forma de conseguir una imagen horizontal «derecha y que llene» es poner hw.lcd.width/height a
   * 1280x720 y reiniciar el emulador. El reinicio tarda unos 30~60 s, así que aquí se hace una sola vez y se da un aviso claro.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] implementación del reinicio inyectada por la capa superior
   */
  async rotate(onRestart) {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    this.setState({ tip: next ? 'Cambiando a horizontal (se reinicia el entorno de ejecución de Android, unos 30-60 segundos)…' : 'Volviendo a vertical (reiniciando el entorno,unos 30-60 segundos)…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // Cambió el tamaño del panel y la relación de aspecto de la ventana cambia con él; se ajustan varias rondas hasta converger
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Si no se inyectó la implementación del reinicio (o falla), se vuelve a la solución de density, que al menos cambia la distribución
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Si hace falta, se cambia a la orientación indicada (pantalla completa=horizontal, ventana=vertical) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  async toggleMaximize() {
    if (!this.isOpen) return;
    // En modo de ventana independiente la imagen está en la ventana nativa del emulador y el caparazón está oculto — maximizar una ventana
    // oculta no produce ningún efecto visual (esa es la razón de «el botón de arriba a la derecha no hace nada»). Aquí se cambia a
    // llenar el área de trabajo / restaurar el tamaño anterior de la ventana del emulador.
    if (this.detachedMode) {
      const area = this._area();
      if (this._detachedFullscreen) {
        // Restaurar: volver al tamaño recordado antes de la pantalla completa (si lo hay); si no, al valor por defecto centrado proporcionalmente
        this._detachedFullscreen = false;
        if (this._preFullscreenRect) {
          await this.agent.layout(this._preFullscreenRect).catch(() => {});
          this._preFullscreenRect = null;
        } else {
          await this.openDetachedLayoutOnly(area);
        }
      } else {
        // Antes de la pantalla completa se guarda la posición y el tamaño actuales de la ventana, para usarlos al restaurar
        try {
          const probe = await this.agent.probe().catch(() => null);
          if (probe && probe.w > 0 && probe.h > 0) {
            this._preFullscreenRect = { x: probe.x, y: probe.y, w: probe.w, h: probe.h };
          }
        } catch (_) { /* Si no se puede obtener, al restaurar se usa el valor por defecto */ }
        this._detachedFullscreen = true;
        await this.agent.layout(this._physical({ x: area.x, y: area.y, w: area.w, h: area.h }, area.sf))
          .catch(() => {});
      }
      return;
    }
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  /**
   * Solo recolocar el tamaño de la ventana del emulador (sin volver a detach/show), para reutilizar el cálculo de openDetached
   * en el cambio pantalla completa / restaurar. Se extrae para no repetir el proceso de detach.
   */
  async openDetachedLayoutOnly(area) {
    const maxH = Math.min(area.h - 140, 1000);
    const maxW = Math.min(area.w - 80, 1280);
    const ratio = this._panelRatio();
    let w = maxW;
    let h = Math.round(w / ratio);
    if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    await this.agent.layout(this._physical({
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + 60),
      w, h,
    }, area.sf)).catch(() => {});
  }

  minimize() {
    if (!this.isOpen) return;
    // En modo de ventana independiente, lo que se minimiza es la ventana nativa del emulador (agent.hide la oculta),
    // no el caparazón invisible.
    if (this.detachedMode) { this.agent.hide().catch(() => {}); return; }
    this.win.minimize();
  }

  /**
   * Cerrar la ventana. Por defecto detiene también esta app de Android (ahorra memoria), pero conserva el motor, así que la próxima apertura es instantánea.
   *
   * El orden importa: primero hay que «desacoplar y ocultar» la ventana del emulador de la ventana anfitriona y después destruir el anfitrión.
   * Al revés, Windows vuelve a colgar en el escritorio la ventana hija entre procesos y conserva su estado de visibilidad anterior,
   * y aparece de la nada en el escritorio del usuario una ventana negra "Android Emulator - apkstart5554".
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this.lastEmbedOk = false;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
