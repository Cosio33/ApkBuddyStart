'use strict';
/**
 * ApkBuddyStart: proceso principal
 * Responsabilidades: ventanas / área de notificación / instancia única / despacho de línea de comandos (doble clic en apk, inicio desde acceso directo del escritorio) / IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// Logotipo de marca (generado por build/render-logo.js); si falta, se recurre al icono antiguo dibujado programáticamente
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* se usa el icono programático */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}

// El área de notificación usa un «icono simplificado de pequeño tamaño»: reducir el logotipo principal de 512 a 16 px lo desdibuja todo y se pierden textura y texto
function loadTrayIcon() {
  try {
    const p = path.join(LOGO_DIR, 'tray-16.png');
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  } catch (_) { /* se usa como respaldo el icono programático */ }
  return nativeImage.createFromBuffer(drawAppIcon(16));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { KeymapEngine } = require('./core/keymap-engine');
const { PRESETS: KEYMAP_PRESETS } = require('./core/keymap');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater, findUninstaller } = require('./core/updater');
const leftovers = require('./core/leftovers');

// En Windows, capturePage obtiene un fotograma antiguo cuando la ventana está tapada; las capturas automáticas necesitan desactivar el cálculo de oclusión
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * Cuando la unidad del sistema se está llenando, mueve la caché de Chromium (Cache / GPUCache / Local Storage …)
 * a la unidad donde está el «directorio de datos de Android».
 * Por defecto estas cachés se escriben en %APPDATA%\apkstart — si la unidad C solo tiene unos cientos de MB, incluso el arranque puede fallar,
 * y el usuario suele haber movido ya los datos de Android a otra unidad, mientras la caché sigue ocupando espacio en C.
 * Debe configurarse antes de app ready; cambiarlo después no surte efecto.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* si no se puede colocar, se mantiene el valor por defecto, sin afectar al arranque */ }
}
relocateUserDataIfCrowded();

// La ventana de la aplicación incrusta el emulador como ventana hijo mediante SetParent. Chromium usa por defecto
// una capa semitransparente de DirectComposition (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP) para dibujar la página web; esta capa la compone DWM a nivel de ventana,
// y tapa directamente la ventana hija incrustada: el síntoma es «pantalla en negro pero Android sí está funcionando».
// La interfaz del marco solo tiene una barra de título de 38 px y la máscara de arranque; con composición por software no hay ningún tirón,
// al desactivar la aceleración hardware, Chromium dibuja directamente en el HWND y el orden de ventanas hijas empieza a funcionar de verdad.
// Para comparar el efecto, se puede arrancar con APKSTART_HWACCEL=1.
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * Registro ligero en archivo: tras empaquetar no hay consola; si hay problemas, el usuario puede enviar app.log.
 * Solo registra hitos y excepciones; en la ruta normal, unos miles de líneas no lo desbordan.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* un fallo del registro no debe afectar al flujo principal */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * La versión completa (con entorno integrado) toma el control automáticamente:
 * El paquete incluye runtime/ junto a ApkBuddyStart.exe (emulator + platform-tools + AEHD + imagen de compatibilidad ARM).
 * En el primer arranque (cuando settings.json aún no existe), apunta runtime.dir a esa carpeta y activa el modo de compatibilidad,
 * sin descargas ni configuración: listo para usar. Después el usuario puede volver a la versión en línea desde ajustes.
 */
/**
 * Directorio del entorno que viene con el instalador (runtime/ junto al exe de la versión completa, o el de la MSIX de Microsoft Store:
 * app\resources\runtime). No vacío = emulador e imagen son locales: la animación de arranque no debe mencionar
 * la «descarga», ni autoDeploy debe conectarse a la red.
 *
 * Debe declararse antes de bootstrapBundledRuntime(): esa función se ejecuta en cuanto se carga el módulo,
 * declararla con `let` después chocaría con la TDZ (la asignación lanzaría un error, el catch lo tragaría y el marcador quedaría siempre vacío).
 */
let bundledRuntimeDir = null;

function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // La versión portátil coloca el entorno junto al exe; el modo portable de electron-builder extrae los recursos en
    // resources/, y el exe del proceso está al mismo nivel que resources, así que se revisan varias ubicaciones candidatas.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // El entorno integrado solo exige «tener emulator + cualquier sistema de imágenes completo», sin fijar la versión de API:
    // La distribución de archivo único puede incluir una imagen AOSP más pequeña; fijar API34 la haría confundirse y creer que no hay entorno.
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // En la distribución de archivo único la imagen se guarda comprimida (system.img.xz / .gz) y se extrae en el primer arranque.
            // Reconocer solo system.img haría que «el paquete sí trae imagen» se juzgara como que no, y se fuera a descargar por red.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // La versión anterior solo tomaba el control si settings.json no existía: si el usuario instalaba antes la versión en línea y luego descomprimía la completa,
    // se quedaba siempre en el asistente de despliegue por «faltan componentes». Ahora toma el control en cuanto el directorio actual no tiene emulator.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // Tras mover o actualizar la versión portátil (extraída en un directorio nuevo), settings sigue guardando la ruta antigua:
    // hay que reconocer solo «el runtime bajo el directorio del EXE actual»; si no, se seguirían usando componentes del paquete antiguo
    // (probado: el emulator del paquete antiguo no tenía emulator-check → fallaba la detección de aceleración → se retrocedía a emulación TCG por software).
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // Un directorio elegido por el usuario (fuera del árbol del EXE, p. ej. D:\ApkBuddyStartRuntime u otra unidad)
    // se respeta siempre: quizá lo hizo para ahorrar espacio en C o para compartir un entorno entre varias versiones portátiles.
    // La versión anterior lo sobrescribía aquí sin condiciones con el runtime incluido junto al exe; el resultado era
    // «cambié el directorio de datos del entorno en ajustes y sigue descargando en la ruta antigua / AppData» (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Si ya hay un entorno usable (incluida la versión en línea), se respeta: los datos de usuario del AVD están en ese directorio y no se pueden mover sigilosamente
    if (currentOk) {
      // El entorno está dentro del árbol del EXE = viene con el instalador (versión completa / tienda)
      bundledRuntimeDir = current;
      // Pero se activan los parámetros automáticos: los valores fijos 4 G/4 núcleos y el modo GPU obsoleto de configuraciones antiguas ya no deben usarse
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // El modo de compatibilidad solo se activa si el paquete trae una imagen de Google Play; las imágenes AOSP traen bibliotecas x86_64 nativas
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* ignorar */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* un fallo al tomar el control no bloquea el arranque; se sigue la guía en línea */ }
}
bootstrapBundledRuntime();

// En escenarios automatizados como las capturas de humo se omite la consulta al registro (evita depender de reg.exe)
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// «Qué ventanas cuentan como nuestras» se asigna en whenReady (véase agentScope). Se pone a nivel de módulo porque
// runLaunch / el temporizador de precalentamiento se definen antes que ese código, y la const de la clausura no es visible desde su ámbito.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

/**
 * El estado de la ventana de la animación de arranque se guarda a nivel de módulo.
 *
 * Antes se escribía dentro de la callback de app.whenReady() (const splashWin/splashDone), pero
 * runLaunch() / autoDeploy() se definen en un ámbito más externo, de modo que en ellos
 * `typeof splashDone === 'function'` siempre era false, y por eso:
 *   - el texto de progreso nunca se actualizaba (siempre «Preparando…»);
 *   - tras arrancar correctamente, el splash nunca se cerraba y la ventana alwaysOnTop de 480x360 quedaba clavada en
 *     el centro de la pantalla, tapando la imagen de Android.
 * Eso era lo que los usuarios reportaban como «al abrir la app aparecen varias ventanas»: ventana de gestión / splash / ventana de aplicación a la vez.
 * Al elevarlo a nivel de módulo, estas llamadas por fin surten efecto.
 */
let splashWin = null;
let splashProgress = () => {};
let splashDone = () => {};

// ---------------- Análisis de línea de comandos ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron mete en argv sus propias opciones y la ruta de la app; solo se aceptan nombres de paquete con forma com.foo.bar
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium sí decodifica WebP, nativeImage no; se usa una ventana oculta para convertir el icono del APK a PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** Inicio automático: activado por defecto, sin que el usuario tenga que marcarlo en ajustes */
function applyAutoStart() {
  if (!app.isPackaged) return; // en desarrollo no se escribe en el registro
  const on = !!store.getSettings().autoStart;
  try {
    // Hay que dar name explícitamente; si no, la entrada de inicio en el registro se llamaría "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkBuddyStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // Se elimina la entrada que dejó la versión anterior (sin name) para evitar arranques duplicados
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* ignorar si la directiva de grupo lo prohíbe */ }
}

// ---------------- Modo de visualización: pantalla completa adaptable / ventana vertical ajustable ----------------

function displaySettings() { return store.getSettings().display || {}; }

/**
 * Identidad ante la barra de tareas / las notificaciones de Windows.
 *
 * Por qué cambiarla según la aplicación: el acceso directo de escritorio de cada app Android escribe su propio AUMID
 * (`RoutineMiku.ApkBuddyStart.<nombre-de-paquete>`, véase installer.createShortcut), y el icono del acceso directo
 * es **el icono de esa aplicación**. Windows solo fusiona la ventana en ejecución con el elemento fijado en la barra de tareas
 * cuando «el AUMID del proceso == el AUMID del acceso directo», y adopta el icono del acceso directo.
 * Si la identidad no coincide, aparece «el elemento fijado muestra el icono de la app pero la barra de tareas abre otro icono de ApkBuddyStart».
 *
 * La documentación recomienda llamar setAppUserModelId una sola vez; en la práctica afecta a las ventanas **creadas después** (los contenedores con varias apps por proceso,
 * como VS Code, lo hacen así). Aquí solo se cambia antes de abrir la ventana y todo va con try/catch —
 * si alguna versión de Windows lo ignora, simplemente se muestra el icono del exe, sin afectar a la funcionalidad.
 */
const APP_AUMID = 'RoutineMiku.ApkBuddyStart';
function setAumid(id) {
  try { app.setAppUserModelId(String(id || APP_AUMID).slice(0, 128)); } catch (_) { /* ignorar en sistemas no Windows o versiones antiguas */ }
}

/**
 * ¿Debe usar esta aplicación un panel horizontal o vertical?
 *
 * El panel físico del emulador (hw.lcd) es la «forma real» de la imagen; Android no gira
 * todo el panel por una aplicación cuya orientación no coincide — solo le da a la app una franja estrecha con barras negras
 * a los lados. Por eso la única forma de «llenar la ventana» es: orientación del panel = orientación de la app.
 *
 * Prioridad: modo forzado en ajustes > anulación manual por aplicación > orientación natural del manifiesto del APK
 * > orientación actual del panel (si la app sigue al sensor, no se reinicia innecesariamente).
 */
function wantLandscapeFor(pkg) {
  const ds = displaySettings();
  const mode = ds.orientationMode || 'auto';
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  const app = pkg ? store.getApp(pkg) : null;
  const override = app && app.orientationOverride;
  if (override === 'landscape') return true;
  if (override === 'portrait') return false;
  const natural = app && app.orientation;
  if (natural === 'landscape') return true;
  if (natural === 'portrait') return false;
  return !!ds.landscape;
}

/**
 * «Aprender» en tiempo de ejecución la orientación real de la aplicación.
 *
 * El análisis sin conexión de AndroidManifest basta para apps como Hongguo (decenas de Activity fijadas a portrait),
 * pero algunas declaran todo como sensor / fullSensor y el manifiesto no revela la preferencia. En esos casos se espera a que arranque de verdad
 * y se le pregunta una vez a Android (requestedOrientation de ActivityRecord es el valor final
 * calculado por el sistema según la petición real de la app). Una vez aprendido se escribe en apps.json y el próximo arranque elige el panel correcto.
 */
async function learnAppOrientation(pkg) {
  const app = store.getApp(pkg);
  if (!app || app.orientation || app.orientationOverride) return null;
  let out = '';
  try {
    out = await runtime.client().shell(
      'dumpsys activity activities | grep -m1 requestedOrientation', { timeout: 8000 });
  } catch (_) { return null; }
  const s = String(out || '');
  let value = null;
  if (/requestedOrientation=SCREEN_ORIENTATION_(PORTRAIT|SENSOR_PORTRAIT|REVERSE_PORTRAIT|USER_PORTRAIT)/.test(s)) value = 'portrait';
  else if (/requestedOrientation=SCREEN_ORIENTATION_(LANDSCAPE|SENSOR_LANDSCAPE|REVERSE_LANDSCAPE|USER_LANDSCAPE)/.test(s)) value = 'landscape';
  if (!value) return null;
  store.upsertApp({ package: pkg, orientation: value });
  appLog(`learned orientation ${pkg} = ${value}`);
  return value;
}

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** La inyección de la rueda necesita conocer la resolución de Android; se cachea una vez y caduca al girar / reiniciar el entorno */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* el entorno aún no ha arrancado */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Tras cambiar las teclas del ratón en ajustes, se sincroniza la configuración del hook según el foco actual */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * Rotar = cambiar el tamaño del panel físico y reiniciar el emulador.
 *
 * Es la única forma de lograr una horizontal «derecha + a pantalla completa» (se probaron tres caminos erróneos):
 *   - wm size: solo cambia la resolución lógica, la LCD física sigue vertical -> imagen tumbada 90° y ocupando solo una franja arriba a la izquierda;
 *   - wm density: el tamaño del framebuffer no cambia -> la imagen no llena y queda mucho espacio en blanco a la derecha al maximizar;
 *   - adb emu rotate: solo gira el contenido, el sistema sigue en vertical.
 * Solo al cambiar hw.lcd.width/height a horizontal y reiniciar, Qt abre la ventana con panel horizontal y la imagen se ve derecha y a pantalla completa.
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Cambiar a horizontal: reiniciando el entorno de ejecución de Android…' : 'Volver a vertical: reiniciando el entorno de ejecución de Android…');
  try {
    // Primero se separa la ventana incrustada para no dejar una ventana negra en el escritorio durante el reinicio
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    // reloadApp=false: quien llama (runLaunch) ya arrancará la aplicación; aquí no se hace antes
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // Devuelve el nuevo rt: beforeStart lo sustituirá por el antiguo (el client viejo ya caducó con stop)
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/**
 * Llega la imagen de Android ante el usuario. Dos modos:
 *   - Incrustado (por defecto): SetParent en nuestra propia ventana, aspecto unificado;
 *   - Ventana independiente: el emulador abre su ventana nativa, evitando toda una serie de problemas inherentes a la incrustación
 *     (barras negras, desajuste de coordenadas, imagen que no llena, conflicto de orientación del panel Qt). Lo controla el ajuste display.windowEmbed.
 */
async function attachAppWindow() {
  if (!appWin || !appWin.isOpen) return false;
  const embedMode = displaySettings().windowEmbed !== false;
  if (!embedMode) {
    // En modo de ventana independiente no se necesita esa zona de la barra de título; se deja que la ventana del emulador se muestre sola
    return appWin.openDetached().catch(() => false);
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/**
 * Abre (o reutiliza) eso de «una aplicación, una ventana limpia».
 *
 * Al cambiar de aplicación hay que cerrar de verdad la **anterior**, o aparece lo que reportaban los usuarios:
 * «abro la segunda app y la primera no responde / ANR»:
 *   - appWin.open() cierra la ventana antigua con close({keepApp:true}), que solo recoge la ventana
 *     y **no llama a endApp**, así que el proceso anterior no se fuerza a detener y sigue en
 *     runtime._activeApps;
 *   - al llamar beginApp con la app nueva, `first = _activeApps.size === 0` se evalúa mal,
 *     y se desordenan la prioridad y la lógica de instantáneas;
 *   - dos aplicaciones compiten por el primer plano del mismo emulador → la antigua se cuelga y salta ANR.
 * Por eso aquí se espera (await) a detener del todo la app anterior antes de abrir la ventana nueva.
 */
async function openAppWindow(pkg, tip) {
  // Solo hay que cerrar la anterior al «cambiar a otra aplicación»; si se vuelve a pulsar la misma, se reutiliza sin interrumpir.
  if (currentAppPkg && currentAppPkg !== pkg && appWin && appWin.isOpen) {
    const prev = currentAppPkg;
    try {
      // Primero se retira la imagen y luego se detiene el proceso: en modo de ventana independiente, la ventana nativa del emulador es la que el usuario está viendo,
      // park la oculta bien para no dejar una ventana negra en el escritorio al destruir la ventana anfitriona.
      await appWin.close({ keepApp: true });
      await runtime.endApp(prev, { onIdle: onContainerActive }).catch(() => {});
      appLog(`switch: closed ${prev} before launching ${pkg}`);
    } catch (e) {
      appLog(`switch close ${prev} failed: ${e && e.message}`);
    }
  } else if (currentAppPkg && currentAppPkg !== pkg) {
    // La ventana ya no está, pero el proceso quizá siga en _activeApps; también hay que cerrarlo.
    await runtime.endApp(currentAppPkg).catch(() => {});
  }
  const rec = store.getApp(pkg);
  const land = wantLandscapeFor(pkg);
  const p0 = portraitSize();
  const detached = displaySettings().windowEmbed === false;
  // Si la orientación del panel y de la app no coinciden → beforeStart reinicia el entorno una vez (unos 40 s).
  const willRestart = land !== !!displaySettings().landscape;
  // En modo de ventana independiente el marco no se muestra normalmente, pero **durante la espera** hay que dar al usuario una señal visible:
  //   - si hay animación de arranque (primer inicio), se encarga ella;
  //   - si no la hay (cambio de app), hay que mostrar el marco; si no, no aparece nada en 40 segundos
  //     y el usuario pensaría que el programa se ha caído.
  const splashVisible = !!(splashWin && !splashWin.isDestroyed());
  const label = (rec && rec.label) || pkg;
  // Primero se cambia la identidad a esta aplicación y luego se abre la ventana: así la barra de tareas usa el icono del acceso directo de esa app
  setAumid(`${APP_AUMID}.${pkg}`);
  appWin.open({
    pkg,
    label,
    iconPath: rec && rec.icoPath,
    // En horizontal la ventana se abre con proporción horizontal; si no, una imagen horizontal en ventana vertical deja grandes barras negras
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // La pantalla completa tiene dos caminos: elegir explícitamente el modo «Pantalla completa» o marcar «Pantalla completa al arrancar».
    // Antes esta última era una opción muerta (solo se declaraba en los ajustes por defecto y ningún código la leía); aquí se añade.
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached,
    showWhileWaiting: detached && !splashVisible,
  });
  appWin.setIcon(rec && rec.icoPath);
  // Al abrir se inicializa con la orientación guardada (la orientación física del panel la decide doctor.lcdFor)
  appWin.setState({
    // Cuando haya que reiniciar para cambiar el panel, se escribe «por qué va lento» en el aviso; que el usuario no tenga que adivinar ante 40 s de pantalla vacía
    tip: willRestart
      ? `Cambiando para «${String(label).slice(0, 20)}» a ${land ? 'Horizontal' : 'Vertical'}(reinicia el entorno Android, unos 40 segundos, solo una vez)…`
      : (tip || 'Iniciando el entorno Android…'),
    ready: false,
    landscape: land,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // En modo de ventana independiente la imagen está en la ventana nativa del emulador; maximizar el marco no tiene efecto visual,
    // hay que usar appWin.toggleMaximize para llenar/restaurar la ventana del emulador.
    if (displaySettings().windowEmbed === false) {
      appWin.toggleMaximize().catch(() => {});
    } else if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // Ojo: aquí **ya no** se cambia también la orientación del panel.
    // Pantalla completa y horizontal son dos cosas distintas: la orientación del panel la decide ahora «la orientación declarada por la app»
    // (véase wantLandscapeFor). Antes F11 reiniciaba el entorno y cambiaba a horizontal, con el resultado de que una app vertical
    // acababa en un panel horizontal → barras negras a los lados → el usuario pensaba que «la pantalla completa no funcionaba».
  }
  return next.display.mode;
}

/** En el primer arranque se instalan adb / emulator / la imagen del sistema de una vez, sin dividirlo en pasos 1 a 5 */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Enfriamiento tras fallo de descarga: antes, si checkEnv() seguía echando componentes en falta, cada arranque de ApkBuddyStart volvía a
  // bajar el paquete de 1,5 GB del entorno; el usuario veía «descargas repetidas sin parar».
  // Tras un fallo se guarda una marca de tiempo y no se reintenta automáticamente en 30 min; si el usuario pulsa «Desplegar en un clic»,
  // con force=true se puede reintentar al instante. El éxito o un forzado manual eliminan el enfriamiento.
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy en enfriamiento (último error en ${new Date(lastFail).toISOString()}), se omite el reintento automático`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => {
    send('provision:progress', { ...p, component: p.component || 'all' });
    // Se envía también a la ventana de la animación de arranque
    if (typeof splashProgress === 'function') splashProgress(p);
  };
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // Runtime incluido en el paquete (instalador completo / versión de Microsoft Store): **nunca conecta a la red**.
    // La imagen ya está en el paquete (comprimida); engine.ensure() la expande in situ en el primer arranque;
    // descargar otros 1.5 GB aquí sería un desperdicio y es justo la queja de «instalado pero sigue descargando».
    if (bundledRuntimeDir && env.adb.ok && env.emulator.ok && env.sysimg.ok) {
      // Runtime incluido = no hay nada que descargar, esto es un «éxito».
      // La versión anterior no marcaba succeeded, así que el finally grababa un deployFailedAt falso
      // y bloqueaba los reintentos 30 min, impidiendo incluso la expansión de la imagen en engine.ensure()
      // — el usuario veía «instalado pero nunca funciona».
      succeeded = true;
      // Si la imagen sigue comprimida, limpia la marca de error anterior para que el cooldown no bloquee la primera expansión.
      if (env.needsExtract) {
        try { store.saveSettings({ runtime: { deployFailedAt: 0 } }); } catch (_) { /* ignorar */ }
      }
      appLog(`autoDeploy omitido: el entorno de ejecución viene incluido en el paquete (${bundledRuntimeDir}), no se necesita conexión a la red`
        + (env.needsExtract ? ', la imagen se expandirá localmente en el primer arranque' : ''));
      return { ok: true, source: 'bundled', needsExtract: !!env.needsExtract };
    }
    if (bundledRuntimeDir && !env.emulator.ok) {
      appLog(`autoDeploy omite la descarga por internet: la carpeta del entorno de ejecución se incluye en el paquete (${bundledRuntimeDir}), se pasa al proceso de diagnóstico`);
      return { ok: false, error: 'bundled', bundled: true };
    }
    // La versión ligera prefiere «el paquete completo del entorno en el GitHub del proyecto»: un solo archivo con emulator + imagen del sistema,
    // La fuente de descarga y la de actualización se unifican en GitHub (mucho más estable que dl.google.com en China).
    // Si no se consigue el paquete completo (sin red / asset aún no publicado / limitación de tasa), se instala cada pieza desde las fuentes oficiales.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Descargando el entorno de ejecución desde GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'El paquete completo del entorno de ejecución está incompleto; se usa la fuente oficial para completarlo…' });
      } catch (e) {
        progress({ message: `El entorno de ejecución de GitHub no está disponible (${e.message}), se usa la fuente oficial…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparando adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparando el entorno de ejecución de Android…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparando la imagen del sistema Android…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Solo un «fallo real» entra en enfriamiento; si el despliegue tiene éxito, hay que borrar el registro de fallos anterior.
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* si no se puede guardar, no afecta al resultado de esta vez */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** Copia recursivamente el contenido de un directorio (a lo sumo, sin borrar el origen; se usa para migrar archivos antiguos de una vez al cambiar la ruta compartida) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* el fallo de un archivo no afecta a los demás */ }
  }
}

/** Habilita una característica opcional de Windows con permisos de administrador (p. ej. VirtualMachinePlatform / HypervisorPlatform) */
/**
 * Activa con elevación una característica opcional de Windows.
 *
 * Devuelve { ok, cancelled, code, feature }:
 *   cancelled usa 1223 (ERROR_CANCELLED) para distinguir «el usuario pulsó No en UAC» de «fallo real» —
 *   antes ambos eran ok:false y la interfaz solo podía decir «no se pudo activar», sin que el usuario supiera que él mismo pulsó Cancelar.
 */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)}); exit $p.ExitCode } `
      + 'catch { exit 1223 }';
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({
      ok: code === 0, cancelled: code === 1223, restart: true, code, feature,
    }));
    proc.on('error', () => resolve({ ok: false, feature, error: 'No se puede iniciar PowerShell' }));
  });
}

/**
 * Activa el WHPX (Windows Hypervisor Platform) incluido en el sistema.
 *
 * Ojo: la característica que realmente permite al emulador Android usar WHPX se llama
 * **«Plataforma de hipervisor de Windows» (HypervisorPlatform)**;
 * «Plataforma de máquina virtual» (VirtualMachinePlatform) es para WSL2; activar solo esa no hace que WHPX funcione.
 * Se activan ambas para cubrir diferencias entre máquinas (primero la realmente necesaria).
 *
 * Tampoco se usa ya la existencia de WinHvPlatform.dll como criterio: ese DLL ya está presente en Windows moderno
 * (en esta máquina WinHvPlatform.dll existe, pero se ejecuta AEHD) — usarlo para decidir «se puede activar WHPX»
 * solo dejaría fuera a las máquinas que sí lo necesitan.
 */
async function enableWhpxFeatures() {
  const steps = [];
  for (const f of ['HypervisorPlatform', 'VirtualMachinePlatform']) {
    // eslint-disable-next-line no-await-in-loop
    steps.push(await enableWindowsFeature(f));
  }
  return { ok: steps.some((s) => s.ok), cancelled: steps.every((s) => s.cancelled), steps };
}

/** Texto de guía manual exclusivo de la versión de la tienda: el paquete MSIX tiene mediumIL fijo y normalmente no se puede elevar */
const MSIX_ACCEL_HINT = 'La versión de la tienda no puede elevar privilegios por sí sola. Actívala manualmente una vez:'
  + 'Pulsa Win+R → escribe optionalfeatures → marca «Plataforma de hipervisor de Windows»'
  + '(HypervisorPlatform, la que realmente necesita WHPX); acepta y reinicia el equipo.';

// ---------------- Ventana principal ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: Number(process.env.APKSTART_WIN_W) || 1140,
    height: Number(process.env.APKSTART_WIN_H) || 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // En las pruebas de humo se envían los errores del proceso de renderizado a stdout: una interfaz en blanco o botones que no responden
  // son casi siempre una excepción por cambiar un id en app.js; en el uso normal no se ve.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // Todos los enlaces externos van al navegador del sistema (cuentas oficiales / GitHub, etc.); la ventana de la app nunca navega a ellos
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkBuddyStart sigue ejecutándose en segundo plano', 'Haz clic en el icono de la bandeja para volver a abrir; haz clic derecho en la bandeja para salir.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  // Volver a la ventana de gestión = volver a la identidad de ApkBuddyStart (si no, la barra de tareas usaría el icono de la app anterior)
  setAumid(APP_AUMID);
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- Área de notificación ----------------

function buildTray() {
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // En modo de ventana independiente la interfaz principal está oculta, así que el área de notificación es el único acceso siempre disponible —
    // «Cerrar aplicación actual» tiene que estar aquí; si no, el usuario no podría cerrar la app en ejecución.
    // Para saber «si hay una app en ejecución» hay que mirar a la vez currentAppPkg y runtime.activeApps:
    // endApp elimina el paquete de activeApps, así que al cerrar esto pasa a false automáticamente.
    // Pero currentAppPkg puede seguir apuntando a la app anterior (endApp no lo limpia), por eso se comprueba dos veces.
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir ApkBuddyStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Todavía no hay aplicaciones instaladas', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Cerrar la aplicación actual (${runningLabel}）` : 'Cerrar la aplicación actual',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // Se reutiliza la misma ruta de app:stop; no se duplica la lógica en dos sitios
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: displaySettings().landscape ? 'Volver a vertical (requiere reiniciar el entorno de ejecución)' : 'Cambiar a horizontal (requiere reiniciar el entorno de ejecución)',
        enabled: !!currentAppPkg,
        click: () => { restartForOrientation(!displaySettings().landscape).catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Volver a la ventana vertical' : 'Pantalla completa (se adapta a la pantalla)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Recrear los accesos directos del escritorio / menú Inicio', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sincronizar la carpeta compartida', click: () => sharer.sync() },
      { label: 'Ajustes', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `Se encontró una nueva versión ${updateInfo.tag}` : 'Buscar actualizaciones',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'Se encontró una nueva versión',
              message: `ApkBuddyStart ${info.tag} publicado, versión actual v${app.getVersion()}. ¿Actualizar ahora?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Actualizar ahora', 'Más tarde'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Ya es la última versión', `ApkBuddyStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Salir',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkBuddyStart — Ejecutor de aplicaciones Android');
  // Por convención, en Windows un clic simple en el área de notificación abre la ventana principal (el doble clic también, por supuesto).
  // Antes solo se enlazaba double-click; con un clic simple no pasaba nada y el usuario pensaba que el icono no funcionaba.
  // El menú solo sale con clic derecho, así que aquí el clic simple llama directamente a showWindow sin conflictos.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- Acciones principales ----------------

let installBusy = null;   // Ruta del archivo en instalación: los dobles clics sucesivos en un APK pasan por second-instance; no se puede instalar en paralelo
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // El mismo paquete se está instalando (el usuario pulsó varias veces / arrastró varias veces) → se avisa una sola vez, no se repite la instalación
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'Este APK se está instalando; espera un momento…' });
      return { ok: false, error: 'Instalando' };
    }
    send('toast', { type: 'info', message: 'Ya hay una instalación en curso; espera a que termine.' });
    return { ok: false, error: 'Ya hay una tarea de instalación en curso' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // El icono nuevo del escritorio debe refrescarse en el Explorador al instante; si no, el usuario pensaría que «no se creó el acceso directo»
    windowctl.refreshShell().catch(() => {});
    notify('Instalación completada', `${result.app.label} instalado${result.app.shortcutPath ? ', se ha creado el acceso directo en el escritorio' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // El mismo error solo muestra una notificación del sistema cada 8 s: al reintentar seguidos no se inunda la esquina inferior derecha
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // Con la ventana en primer plano el usuario ya ve el aviso en la interfaz; no hace falta otra notificación
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Error de instalación', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * Descarga e instala la versión nueva; después el script update-apply se encarga de «sustituir + reiniciar».
 * La interfaz y el menú del área de notificación comparten esta ruta.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Actualizando' };
  // La versión de la tienda (MSIX) no puede actualizarse sola: el directorio C:\Program Files\WindowsApps es de solo lectura,
  // Sobrescribir el exe no solo fallaría, sino que podría invalidar la comprobación de integridad del paquete e impedir que la app arranque.
  // Las actualizaciones van por Microsoft Store (protocolo ms-windows-store:).
  if (store.STORE_BUILD) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return { ok: false, error: 'Las actualizaciones de la versión de tienda las gestiona Microsoft Store; se ha abierto «Descargas y actualizaciones» en la tienda', manual: true };
  }
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Ya es la versión más reciente' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'Esta versión no tiene un paquete de instalación directa; se ha abierto la página de lanzamientos de GitHub', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Preparando la descarga…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Reemplazando el programa y reiniciando…' });
    updater.apply(job);
    // Se da tiempo a la interfaz para mostrar «reiniciando en breve» y luego se sigue el flujo normal de salida (before-quit ocultará la ventana del emulador)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

/**
 * Serialización del arranque.
 *
 * Un arranque puede tardar hasta 80 s (reinicio para cambiar panel + arranque en frío). Durante ese tiempo el usuario puede perfectamente pulsar otra app,
 * o hacer doble clic en el mismo icono dos veces, o pulsar en el menú del área de notificación — antes todo eso lanzaba una segunda ejecución en paralelo:
 * openAppWindow cerraba la app que se estaba arrancando (close + endApp) justo cuando la máquina virtual se reiniciaba,
 * con lo que fallaban ambos lados y el registro mostraba `cmd: Can't find service: activity` / `device not found`;
 * el usuario veía «pulsé y no pasó nada, y luego volvió la interfaz principal».
 *
 * Ahora: misma aplicación → se reutiliza la ejecución en curso (varios clics cuentan como uno); otra aplicación → se espera a que termine la anterior
 * antes de empezar, en lugar de quitarle el entorno.
 */
let launchInFlight = null;
// El aviso de «emulación por software» se muestra una vez por proceso, para no soltar una notificación en cada cambio de app
let accelWarned = false;

async function runLaunch(pkg) {
  if (launchInFlight) {
    if (launchInFlight.pkg === pkg) {
      appLog(`launch reused in-flight ${pkg}`);
      return launchInFlight.promise;
    }
    appLog(`launch queued ${pkg} (Esperando ${launchInFlight.pkg} inicio completado)`);
    await launchInFlight.promise.catch(() => {});
  }
  const entry = { pkg };
  entry.promise = launchOne(pkg).finally(() => {
    if (launchInFlight === entry) launchInFlight = null;
  });
  launchInFlight = entry;
  return entry.promise;
}

async function launchOne(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // Estado de «conectar la imagen antes de tiempo»: se conecta en cuanto aparece el proceso, pero el resultado final solo se conoce cuando vuelve la callback.
  // Se pone en el ámbito de la función para usarlo en la decisión final posterior.
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  appLog(`launch start ${pkg}`);
  try {
    // 0) Primero se recoge la ventana de gestión y después se abre la ventana de la aplicación.
    // El orden importa: antes se hacía hide() después de openAppWindow() y de armAgent(),
    // y armAgent espera al arranque en frío del agente de ventanas (300~600 ms); durante ese rato «ventana de gestión +
    // ventana de aplicación (+ animación de arranque)» estaban a la vez en pantalla — eso era lo de «ventanas por todas partes» que veía el usuario.
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();
    // 1) Después se abre la «ventana de aplicación» para mostrar la animación de arranque: en todo el proceso no se ve el escritorio Android ni la ventana del emulador
    await openAppWindow(pkg, 'Iniciando el entorno Android…');
    // Durante el arranque se ocultan la ventana principal del emulador + las ventanas negras de consola de qemu / netsimd, evitando cualquier destello.
    // La supresión es permanente (tras embed omite automáticamente la ventana incrustada, véase appwin.embed).
    // Aquí hay que usar await: si se sigue sin esperar a que surta efecto, la ventana negra se muestra al arrancar.
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }

    const r = await installer.launch(pkg, {
      onLog: (m) => {
        send('runtime:log', m); appLog(`  rt ${m}`);
        // Se sincroniza con la animación de arranque
        if (typeof splashProgress === 'function') splashProgress({ message: m });
      },
      onMark: mark,
      // En cuanto aparece el proceso de la app se conecta la imagen, sin esperar los 4 s siguientes de observación «confirmar que no se cae».
      // Esos 4 s tienen sentido para la estabilidad, pero el usuario ve «pulsé y no pasó nada»; mejor dejarle ver que la app está cargando,
      // la diferencia de percepción es enorme (medido: de pulsar a ver imagen, 7,2 s → unos 3 s).
      // Aquí se omite await a propósito: conectar la imagen y comprobar que sigue vivo van en paralelo; el que termine primero no afecta al otro.
      onAppUp: () => {
        attachDoneEarly = true;
        mark('app up (conectar la pantalla antes)');
        attachAppWindow()
          .then((ok) => {
            earlyAttachOk = ok;
            mark(`early attach=${ok}`);
            // La imagen ya está ante el usuario → la animación de arranque puede desvanecerse.
            // Se pone aquí y no después del launch ok porque, con early attach, la ventana del emulador
            // ya se ha mostrado; si se espera al launch ok (4 s más de confirmación),
            // el splash y la ventana del emulador quedarían visibles a la vez varios segundos y el usuario vería el splash «empujado hacia atrás».
            if (ok && typeof splashDone === 'function') splashDone();
          })
          .catch(() => { earlyAttachOk = false; });
        // Justo al arrancar, la Activity se está reconstruyendo y gira una vez más según su orientación declarada (portrait),
        // sobrescribiendo la orientación recién fijada — de ahí «en modo tableta/horizontal la imagen siempre está tumbada 90°».
        // Cuando se estabilice, se aplica una vez más la autocorrección de orientación (lee init/cur y solo escribe si realmente está tumbada).
        setTimeout(() => {
          runtime._healOrientation?.().catch(() => {});
          // De paso se anota la orientación real de la app (las que declaran todo sensor solo se aprenden así)
          learnAppOrientation(pkg).catch(() => {});
        }, 1800);
      },
      // Antes de arrancar se corrige la orientación del panel a la que piden los ajustes.
      // La horizontal solo se logra con el panel físico (intercambiar hw.lcd.width/height) + reinicio, y esto se escribe
      // en config.ini al arrancar. Si el usuario cambió el ajuste a «horizontal» pero la máquina virtual sigue con panel vertical
      // (algo muy común con el precalentamiento), wm size / wm user-rotation solo tumban la imagen.
      // Por eso, si hay discrepancia, se reinicia una vez antes; reloadApp=false hace que la app se arranque con normalidad más abajo.
      beforeStart: async (rt) => {
        mark('engine ready');
        // La orientación del panel debe coincidir con la declarada por la app; si no, Android solo da una franja con barras negras
        // (todo negro a los lados). wantLandscapeFor combina «modo forzado en ajustes / anulación por app /
        // orientación del manifiesto del APK»; véase el comentario de la función.
        const wantLand = wantLandscapeFor(pkg);
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        if (cur !== null && cur !== wantLand) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}) reiniciar para corregir`);
          appWin.setState({ tip: wantLand ? 'Cambiando a horizontal…' : 'Cambiando a vertical…' });
          // restartForOrientation devuelve el nuevo rt tras reiniciar el entorno (el client antiguo ya no sirve).
          // Se lo devuelve a installer.launch; las siguientes llamadas resetDisplayOverrides / startApp
          // usan el client nuevo; si no, fallan todas en silencio (el catch lo traga y la app no muestra imagen).
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Abriendo la aplicación…' });
        // Modo inmersivo + animaciones desactivadas + ocultar la pantalla de bloqueo: se hace una sola vez; después cada arranque entra al instante
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // Si no hay reinicio, devuelve null (installer usa el rt original)
        return null;
      },
    });
    mark('app started');

    // 2) Solo cuando la app sigue realmente viva se conecta la imagen ante el usuario (si no, vería un destello del escritorio / de la pantalla de error)
    // Pero si onAppUp ya conectó la imagen (adhesión anticipada), aquí solo se «confirma»; no se conecta dos veces —
    // Hacerlo dos veces en modo de ventana independiente oculta/muestra de nuevo la ventana recién colocada y la imagen parpadea.
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // La redacción del registro debe distinguir ambos modos: en modo de ventana independiente, embedded=true significa
    // «la imagen ya está ante el usuario (en la ventana nativa del emulador)», no «incrustada en nuestra ventana».
    // Si no, quien lea el registro pensaría que el ajuste no se aplicó.
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // Tras incrustar, se saca la ventana de debajo de las demás. Si no, una ventana superior (el navegador, etc.) tapa la imagen de Android,
    // el usuario ve «pantalla negra / imagen que no llena» y el ratón no llega a la app (todo lo come la ventana superior).
    // Se pone topmost un instante y se retira enseguida: solo se toma prestada la prioridad una vez para subir el orden Z al frente, sin acaparar la capa superior.
    // En modo de ventana independiente se omite: la imagen está en la ventana del emulador y mostrar el marco vacío solo la taparía.
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* la ventana ya está cerrada */ }
          }
        }, 700);
      } catch (_) { /* la ventana puede haberse cerrado justo ahora */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // Sesión del contenedor: el entorno ya está listo; aquí solo se «recorta según la app + abre el sondeo en segundo plano»,
    // sin volver a arrancar Android para esta app. El hook de teclas del ratón lo decide el evento focus de la ventana
    // según los ajustes y se descarga al perder el foco.
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // Modo juego / baja latencia: el agente de ventanas reduce la frecuencia de escaneo para disminuir los tirones de todo el sistema que causa EnumWindows en todo el escritorio
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    // Con emulación por software se avisa una vez al arrancar la primera app: el usuario ya está esperando, y el banner / los elementos de autocomprobación
    // están en ajustes y probablemente ni los ha visto. La notificación del sistema puede superponerse a la ventana de la app y es el punto de aviso más eficaz.
    if (!accelWarned) {
      runtime.provisioner.emulatorAccel().then((a) => {
        if (!a || a.ok) return;
        accelWarned = true;
        notify('Ejecutando en modo de emulación por software (muy lento)', store.STORE_BUILD
          ? 'Activa «Plataforma de hipervisor de Windows» y reinicia una vez; la velocidad puede mejorar de 5 a 10 veces.'
            + 'Ajustes → Revisión del entorno → Reparar abrirá directamente esa ventana.'
          : 'Ajustes → Revisión del entorno → Reparar permite activarlo con un solo clic (requiere autorización de administrador); después reinicia una vez.');
      }).catch(() => {});
    }
    // Respaldo: si early attach no disparó splashDone (p. ej. modo incrustado), se hace una vez aquí
    if (typeof splashDone === 'function') splashDone();
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Si el arranque falla, se sigue manteniendo oculta la ventana del emulador (que no aparezca como «ventana independiente del emulador»),
    // la próxima vez que se pulse la app se sigue la misma ruta ocultar → embed.
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Error al iniciar:${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * Interruptor de tareas en segundo plano según haya o no ventanas de aplicación en el contenedor.
 * La sincronización de archivos recorre el directorio compartido cada 8 s y ejecuta adb find/stat; el puente de notificaciones también sondea;
 * antes se arrancaba sin condiciones en cuanto se iniciaba ApkBuddyStart, aunque no hubiera ninguna app Android abierta.
 * Ahora solo se activa si realmente hay una app en el contenedor y se detiene en cuanto se cierra la última ventana.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * Cierra una aplicación Android en ejecución: el menú del área de notificación y el menú contextual comparten esta ruta.
 *
 * Hace tres cosas:
 *  1. forceStop del proceso de la app (la lógica de estacionamiento de endApp va después de este paso)
 *  2. Retira la imagen: en modo incrustado cierra el marco; en modo independiente oculta primero la ventana del emulador y luego cierra el marco
 *     (el orden importa: destruir antes el marco hace que la ventana del emulador destelle en el escritorio antes de ser estacionada con park)
 *  3. Limpia currentAppPkg para que «Cerrar aplicación actual» en el menú del área de notificación se desactive al instante
 *
 * @param {string} pkg nombre del paquete de la app a cerrar
 * @param {object} [opts] { keepWindow } con keepWindow=true no se recoge la ventana
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'No hay aplicaciones en ejecución' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // Modo de ventana independiente: primero se oculta la ventana del emulador y luego se cierra el marco.
      // Al revés, quedaría una ventana del emulador que destella y desaparece en el escritorio.
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // Se limpia el marcador de app actual: «Cerrar aplicación» en el menú del área de notificación y en el contextual se grisan según esto
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Puente de notificaciones: sondea solo cuando hay ventanas de aplicación y se detiene al cerrarlas, evitando girar en vacío */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // Forma de arranque (automático / doble clic): la tarjeta de bienvenida decide con esto si se muestra sola
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Elegir carpeta (para mover el entorno / la imagen / las apps instaladas a una unidad que no sea del sistema)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar carpeta de almacenamiento de datos',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* ignorar si el entorno aún no ha arrancado */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona el APK que deseas instalar',
      filters: [{ name: 'Aplicación de Android', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * Cierra una aplicación Android en ejecución.
   *
   * Antes no existía este acceso: endApp solo se disparaba al «cerrar la ventana de la aplicación», y en modo de ventana independiente
   * esa ventana está oculta y nunca se cierra, así que la app no se podía cerrar una vez arrancada,
   * y el usuario solo podía ir al área de notificación y salir de todo ApkBuddyStart (perdiendo también la máquina virtual).
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('La aplicación no existe');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  /**
   * Memoria / CPU / partición de datos determinan directamente cómo arranca la máquina virtual y qué tamaño de juegos se pueden instalar,
   * antes de guardar se normalizan: los valores absurdos por editar settings.json a mano o por restos de versiones antiguas se corrigen aquí,
   * para que qemu no se cierre al arrancar por -memory 32, o para que la partición no sea mayor que el disco.
   */
  const sanitizeResourcePatch = (patch) => {
    if (!patch || !patch.engine) return patch;
    const res = require('./core/resources');
    const host = res.hostProfile();
    const eng = { ...patch.engine };
    if ('memoryMB' in eng) {
      const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
      eng.memoryMB = c.mb;
      if (c.mb > 0) eng.autoMemory = false;
    }
    if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
    if ('dataPartitionGB' in eng) {
      eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
    }
    return { ...patch, engine: eng };
  };

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = sanitizeResourcePatch(rawPatch);
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // Cambió el tamaño base en vertical: solo afecta al tamaño de ventanas futuras, sin interrumpir la app en ejecución
      appWin.portrait = portraitSize();
    }
    // Se completa en cuanto se activa «acceso directo en el menú Inicio», sin esperar a la próxima instalación
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Cambiaron las teclas del ratón: se reinstala/desinstala el hook según el foco actual, sin esperar al próximo cambio de ventana
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // Se cambió la fuente de actualización / el prefijo del espejo / la URL del paquete completo: la conclusión anterior sobre «cuál es más rápido» ya no vale; se limpia la caché de velocidad;
    // Las URL del paquete del entorno / motor / imagen siguen en caché en provisioner._cache; si no se limpian, solo se aplican al reiniciar el proceso.
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * Cambia el directorio compartido local: migra de una vez los archivos existentes al nuevo directorio (a lo sumo, sin borrar los antiguos),
   * y luego guarda los ajustes. Sharer lee dinámicamente store.getSettings().sharedDir en cada sincronización, así que surte efecto sin reiniciar.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'La carpeta no puede estar vacía' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Modo de visualización / accesos directos / despliegue en un clic ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // Pantalla completa = diseño horizontal de tableta (véase la descripción de toggleDisplayMode)
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // Cuando el usuario pulsa «Desplegar en un clic» manualmente, se fuerza el reintento y se omite el enfriamiento por fallo
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Al desactivar la «poda profunda» se restauran los paquetes del sistema desactivados con pm disable-user
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Cambio de teclas del ratón: solo se sincroniza la configuración; ya no se descarga sin condiciones (el botón derecho para atrás / la rueda pueden seguir necesitando el hook)
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Compatibilidad con la interfaz antigua: el significado pasa a ser «resincronizar según los ajustes»
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  // ---------------- Autocomprobación local / configuración automática ----------------
  // Lo que se puede detectar automáticamente (memoria, núcleos, calidad, backend de renderizado) se hace solo;
  // Lo que requiere administrador (activar funciones de Windows, instalar AEHD) se deja como botón; lo que solo se arregla en la BIOS se explica claramente.

  ipcMain.handle('preflight:run', async () => {
    const preflight = require('./core/preflight');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* el entorno aún no está desplegado */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    return { ok: true, hw, report, edition };
  });

  /**
   * Aplica las recomendaciones de la autocomprobación: escribe ajustes + convierte el parche de esta máquina en un controlador.
   * Solo escribe los elementos seguros listados explícitamente por preflight (memoria / núcleos / calidad / backend de renderizado / si se fuerza emulación por software).
   */
  ipcMain.handle('preflight:apply', async () => {
    const preflight = require('./core/preflight');
    const drv = require('./core/drivers');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    const patch = sanitizeResourcePatch(report.patch);
    const next = store.saveSettings(patch);

    // Fija los parámetros de esta máquina como controlador: en adelante cada arranque los usará, sin repetir la autocomprobación.
    // Se valida antes de guardar en disco: lo generado por la autocomprobación tampoco puede saltarse la lista blanca.
    let driverFile = '';
    let driverError = '';
    try {
      const v = drv.validateDriver(report.driver);
      if (!v.ok) throw new Error(v.errors.join('；'));
      const dir = drv.userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      driverFile = path.join(dir, `${v.driver.id}.json`);
      fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
      const prev = (next.drivers && next.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
    } catch (e) {
      driverError = e.message;
    }

    appLog(`Configuración automática de la revisión del sistema: ${JSON.stringify(patch.engine)} driver=${driverFile || '(sin escribir)'}`);
    return {
      ok: true,
      settings: store.getSettings(),
      driverFile,
      driverError,
      summary: report.summary,
      recommended: report.recommended,
    };
  });

  // ---------------- Controladores (parches de compatibilidad) ----------------
  // Un controlador es un JSON: declara «qué máquinas coinciden» + «qué parámetros de arranque cambiar al coincidir».
  // Aquí solo se «lee el directorio / valida / compara / importa / exporta plantilla / activa-desactiva», sin ejecutar código.

  /** Compila el perfil de la máquina actual + todos los controladores + el resultado de coincidencias (para la página de ajustes) */
  async function driverOverview() {
    const drv = require('./core/drivers');
    const doctor = require('./core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* no hay entorno instalado */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  ipcMain.handle('drivers:list', () => driverOverview());

  ipcMain.handle('drivers:openFolder', async () => {
    const dir = require('./core/drivers').userDir(store);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('drivers:import', async () => {
    const drv = require('./core/drivers');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar el archivo de controlador (.json)',
      filters: [{ name: 'JSON del controlador', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
    if (out.ok) {
      // Al importar se activa: un parche que el usuario importó a propósito debe surtir efecto de inmediato por defecto
      const s = store.getSettings();
      store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
      send('runtime:log', `Se importó el controlador:${out.driver.name} v${out.driver.version}`);
    }
    return { ...out, overview: await driverOverview() };
  });

  ipcMain.handle('drivers:exportTemplate', async () => {
    const drv = require('./core/drivers');
    const overview = await driverOverview();
    const tpl = drv.templateFromHost(overview.host);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar plantilla de controladores de este equipo',
      defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
      filters: [{ name: 'JSON del controlador', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
    return { ok: true, file: r.filePath, template: tpl };
  });

  ipcMain.handle('drivers:setEnabled', async (_e, { id, enabled } = {}) => {
    const did = String(id || '');
    if (!did) return { ok: false, error: 'Falta el id del controlador' };
    const s = store.getSettings();
    const prev = (s.drivers && s.drivers.state) || {};
    store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
    return { ok: true, overview: await driverOverview() };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- Diagnóstico / reducción de peso ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // Si ya arrancó, se usan los parámetros reales; si no, se deducen de «la versión real del motor + el estado real de aceleración»,
    // si no, la página de ajustes mostraría el obsoleto swiftshader_indirect / emulación por software, distinto de la ejecución real.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * Verificación automática de problemas del sistema: antes del arranque / durante la ejecución se comprueban las causas habituales de «no se instala, no arranca»,
   * y se ofrecen sugerencias de reparación accionables (en el banner de inicio + el panel de ajustes, con reparación en un clic por problema).
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // Estos dos valores se asignan dentro del try y se devuelven fuera; hay que declararlos en un ámbito externo
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'Falta la biblioteca de tiempo de ejecución de VC++ (x64)',
          hint: 'El entorno de ejecución de Android depende de Microsoft VC++ 2015-2022; si falta, el emulador no podrá iniciarse (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        // Las vías de solución de la versión de la tienda y de la instalada son totalmente distintas; los avisos deben redactarse por separado:
        //   - La versión de la tienda (MSIX) no puede instalar controladores de kernel y normalmente no obtiene permisos de administrador → solo se puede guiar al usuario
        //     para que marque «Plataforma de hipervisor de Windows» en «Activar o desactivar características de Windows»;
        //   - Las versiones instalada / portátil pueden activarlo con elevación en un clic (y, si falla, recurrir al controlador AEHD).
        // Antes ambas versiones compartían un mismo texto y el usuario de la tienda veía «se recomienda instalar el controlador AEHD» —
        // cuando la versión de la tienda no puede instalar controladores: un callejón sin salida.
        issues.push(store.STORE_BUILD
          ? {
            code: 'accel',
            severity: 'error',
            title: 'Es necesario activar «Plataforma de hipervisor de Windows»',
            hint: 'Sin él solo se puede ejecutar emulación puramente por software, y el arranque tardará varios minutos.'
              + MSIX_ACCEL_HINT
              + '(La versión de tienda no puede elevar privilegios por ti: debes hacerlo manualmente una vez y después reiniciar.)',
            fix: 'virtualization',
          }
          : {
            code: 'accel',
            severity: 'warn',
            title: 'Aceleración de hardware no habilitada',
            hint: `${accel.note || 'Se recurrirá a la emulación por software (funciona, pero muy lento).'}`
              + 'Haz clic en «Reparar» a la derecha para activarlo automáticamente (requiere autorización de administrador y puede ser necesario reiniciar una vez);'
              + 'Si se produce un error, se instalará automáticamente el controlador AEHD.',
            fix: 'virtualization',
          });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Poco espacio en disco para el entorno de ejecución',
          hint: `「${runtime.provisioner.paths().root}」 el disco solo queda ${free} MB; el entorno de ejecución y la imagen podrían llenar el disco.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'La carpeta del entorno de ejecución contiene caracteres chinos/especiales',
          hint: 'Algunos componentes del entorno de ejecución son sensibles a las rutas en chino y pueden provocar errores de inicio. Se recomienda cambiar a una carpeta solo en inglés.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'Falta la cadena de herramientas de adb', hint: 'No se puede conectar con el entorno de ejecución de Android.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Entorno de ejecución no instalado', hint: 'Es necesario implementar primero el motor del entorno de ejecución (unos 440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'Imagen del sistema no lista', hint: 'Primero debes descargar la imagen de sistema de Android (aprox. 1.5GB).', fix: 'deploy' });
      }
      // Los archivos de bloqueo residuales hacen que el próximo arranque se juzgue como «AVD ocupado» y termine en FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Se ha detectado un archivo de bloqueo residual de la vez anterior', hint: 'Puede provocar que el próximo inicio se interprete como «AVD ya ocupado».', fix: 'lock' });
      }
    } catch (_) { /* un fallo de la autocomprobación no bloquea el uso */ }
    return { issues, accel, free };
  });

  // Biblioteca de ejecución Microsoft VC++ 2015-2022 x64: tanto el emulador Android (Qt6) como qemu dependen de ella.
  // Si falta, en «otros equipos» simplemente no arranca (0xc0000135 / falta MSVCP140).
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Se instala con elevación RunAs (VC++ es un componente de sistema y necesita administrador); /quiet sin interfaz, /norestart sin reiniciar
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // Cuadro de confirmación genérico (la capa de renderizado pasa siempre por aquí, evitando que cada sitio arme su propio texto de diálogo)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Confirmar',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancelar', opts.okLabel || 'Aceptar'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  /**
   * Resumen de asignación de recursos: límite del anfitrión, asignación actual, espacio libre en la unidad de datos.
   * Lo responde el resources() del propio entorno; la interfaz solo acepta esta estructura.
   */
  ipcMain.handle('engine:resources', async () => {
    try {
      const backend = runtime.backend;
      if (backend && typeof backend.resources === 'function') return await backend.resources();
      return { backend: backend ? backend.id : '', ok: false, note: 'El entorno de ejecución no está listo; por ahora no se puede leer la asignación de recursos' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Cuando no se puede ampliar in situ (disco diferencial de quickboot), se usa esta vía: reconstruir /data con la capacidad deseada.
   * Borra las aplicaciones instaladas y sus datos — quien llama debe haber obtenido confirmación explícita del usuario.
   */
  ipcMain.handle('runtime:resetAndResize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const want = res.clampDataGB(gb, freeMB).gb;
    if (!want) return { ok: false, error: 'Capacidad de destino no válida' };
    store.saveSettings({ engine: { dataPartitionGB: want } });
    await runtime.stop().catch(() => {});
    const r = await runtime.resetAndroidData().catch((e) => ({ ok: false, error: e.message }));
    appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
    return { ok: !!(r && r.ok), wantGB: want, ...r };
  });

  // Capacidad de la partición de datos (/data): aquí se instalan apps, juegos y sus paquetes de actualización.
  // «El juego dice que no hay espacio al actualizar» casi siempre se debe a que esto es demasiado pequeño; la ampliación se hace in situ y no pierde datos.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const b = runtime.backend;
    const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
    const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
      || doctor.freeDiskMB(runtime.provisioner.paths().root);
    return { ...info, freeDiskMB };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const clamped = res.clampDataGB(gb, freeMB);
    const want = clamped.gb;
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // No se puede cambiar mientras qemu esté usando la imagen; primero se detiene el contenedor (la app se cierra también, es lo esperado)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Partición de datos ajustada', `Espacio libre en Android aprox. ${want} GB${stopped ? '(el entorno de ejecución se reinició)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // Dos confirmaciones explícitas: primero se muestra la lista y solo se borra tras la confirmación; además solo se limpia el directorio de ejecución propio de ApkBuddyStart
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancelar', `Limpiar ${preview.candidates.length} elementos`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirmar la limpieza de la caché del entorno de ejecución',
      message: `Se liberarán aprox. ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Primero se detendrá el entorno de ejecución; luego se eliminarán las imágenes antiguas, la instantánea de inicio rápido del AVD actual, los archivos de bloqueo y la caché de los AVD inactivos. Las aplicaciones instaladas se conservan (solo se limpia la instantánea),'
        : 'Solo se eliminan las imágenes antiguas, las instantáneas antiguas, los archivos de bloqueo y la caché de los AVD inactivos; las aplicaciones instaladas se conservan.')
        + 'Esta operación no se puede deshacer; se recomienda exportar primero el informe de diagnóstico.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // Restablecer por completo los datos de Android: vaciar la partición de usuario /data + apps instaladas + instantánea de arranque rápido,
  // el AVD vuelve a un estado limpio de «sistema recién instalado». Se eliminan varios GB reales, así que la interfaz debe pedir confirmación dos veces.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Reparar la red de la máquina virtual: restablece /data (se conserva la lista de apps; al abrirlas se reinstalan automáticamente).
  // Caso típico: todas las páginas con red en Android se quedan negras; en realidad wlan0 no se ha levantado y no hay ruta por defecto.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Solo comprueba la red, sin tocar ningún dato (la página de ajustes lo usa para mostrar el estado actual)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Restos de versiones anteriores ----------------

  /** Solo explora, no borra: primero muestra a la interfaz «qué se ha encontrado» tal cual y decide el usuario */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Arranque automático del entorno ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Instala el controlador AEHD con elevación: salta UAC y, tras la confirmación, instala en silencio */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'El paquete del controlador AEHD no está listo');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Se canceló la autorización de administrador (debes hacer clic en «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code}）`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Activa la virtualización automáticamente: el usuario no tiene que ir manualmente al panel «Características de Windows».
   * Primero se activa la función del sistema «Plataforma de máquina virtual» (WHPX); si ni siquiera existe el DLL (sistema antiguo),
   * se recurre a instalar y activar el controlador AEHD de Google. Ambas vías requieren permisos de administrador.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'La aceleración por hardware ya está disponible; no se necesita ninguna acción adicional' };

      // ---------------- Versión de la tienda (MSIX): solo el WHPX del sistema ----------------
      // El paquete MSIX lo lanza el modelo de despliegue AppX, con mediumIL fijo: no puede instalar controladores de kernel (AEHD)
      // y normalmente tampoco obtiene permisos de administrador. Por eso aquí solo se intenta WHPX y, si no se consigue, se recurre a la guía «activar manualmente»
      // — antes la implementación usaba directamente Start-Process -Verb RunAs, y el usuario de la tienda al pulsar
      // estaba abocado al fracaso, de modo que el banner «aceleración hardware no activada» nunca desaparecía.
      if (store.STORE_BUILD) {
        const whpx = await enableWhpxFeatures();
        runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
            note: 'Se ha solicitado activar «Plataforma de hipervisor de Windows»; la aceleración de hardware no surtirá efecto hasta que reinicies el equipo',
          };
        }
        return {
          ok: false,
          manual: true,
          settingsUri: 'ms-settings:optionalfeatures',
          steps: whpx.steps,
          accel,
          note: MSIX_ACCEL_HINT,
        };
      }

      // ---------------- Versión instalada / portátil ----------------
      // Primero se prueba WHPX (incluido en el sistema, sin descarga); si falla (el usuario pulsó No / el sistema no lo soporta), se recurre al controlador AEHD.
      // AEHD necesita descargar el paquete del controlador, por eso va después.
      const whpx = await enableWhpxFeatures();
      runtime.provisioner.invalidateEnvCache?.();
      if (whpx.ok) {
        return {
          ok: true, restartNeeded: true, steps: whpx.steps,
          accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
          note: whpx.steps.some((s) => s.cancelled)
            ? 'Se ha activado «Plataforma de hipervisor de Windows»; surtirá efecto tras reiniciar el equipo'
            : 'Se ha activado «Plataforma de hipervisor de Windows»; surtirá efecto tras reiniciar el equipo',
        };
      }
      if (whpx.cancelled) {
        return {
          ok: false,
          cancelled: true,
          error: 'Cancelaste la autorización de administrador; la aceleración de hardware no se modificó. Puedes hacer clic de nuevo en «Reparar», o activar manualmente «Plataforma de hipervisor de Windows».',
        };
      }

      // No se puede activar WHPX: se usa el controlador AEHD de Google (listo al instalar, sin reiniciar)
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'Error al preparar el paquete del controlador AEHD' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Se canceló la autorización de administrador (debes hacer clic en «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code}）`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      runtime.provisioner.invalidateEnvCache?.();
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'Aceleración por hardware AEHD activada' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona una imagen de sistema Android-x86 / Bliss OS',
      filters: [{ name: 'Imagen del sistema', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona el disco virtual con Android instalado',
      filters: [{ name: 'Disco virtual', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // En entornos de humo / sin shell: no se consulta el registro (reg.exe podría estar bloqueado por directivas)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // Se prefiere el ICO de marca con varios tamaños incluido en el paquete; si falta, se calcula al momento desde el PNG del logotipo
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Limpia los archivos de bloqueo del AVD que quedaron la última vez: si no, el próximo arranque se confunde con «AVD ocupado» y da FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Desinstalar ApkBuddyStart en un clic:
   * 1) Primero se cancela la asociación de archivos .apk (evita que, tras desinstalar, el doble clic en un APK apunte a un programa borrado)
   * 2) Versión instalada: se lanza el desinstalador NSIS (él mismo pide administrador / confirmación) y después sale este programa
   * 3) Versión portátil (carga lateral / sin instalación): no hay uninstaller.exe; se devuelve un aviso para que el usuario borre manualmente el programa y el directorio de datos
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* si no se puede cancelar la asociación, no afecta a la desinstalación */ }
      const exeDir = path.dirname(process.execPath);
      // Se usa el mismo criterio que updater.flavor: electron-builder genera
      // "Uninstall ApkBuddyStart.exe"; el código antiguo solo buscaba "uninstaller.exe",
      // lo que hacía que, en la versión instalada, «Desinstalar en un clic» se confundiera con portátil y solo mostrara el aviso sin desinstalar (issue #51).
      const unName = findUninstaller(exeDir);
      if (!unName) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const uninstaller = path.join(exeDir, unName);
      const { spawn } = require('child_process');
      // Antes de desinstalar se cierra el emulador residente: qemu bloquea los exe/dll en resources\runtime,
      // y si NSIS no puede borrarlos queda medio directorio de instalación. Esto solo se aplica cuando «realmente se está desinstalando», no afecta a la salida normal.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // Primero se cierra este programa y, después, un proceso independiente lanza el desinstalador 2 s más tarde:
      // El exe en ejecución bloquea archivos del directorio de instalación; lanzar el desinstalador directamente suele dejar restos.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  /**
   * Abre el cuadro de diálogo «Activar o desactivar características de Windows».
   *
   * ¿Por qué no ms-settings:optionalfeatures?: en Win11 esa página es la lista de «características opcionales»,
   * y ahí **no está** «Plataforma de hipervisor de Windows», así que el usuario buscaría en vano. El diálogo clásico
   * optionalfeatures.exe sí contiene esa opción (la que WHPX realmente necesita).
   * Abrirlo no requiere administrador; el UAC salta al pulsar «Aceptar».
   */
  ipcMain.handle('provision:openWindowsFeatures', () => {
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
      const { spawn } = require('child_process');
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      // Muy raro: bloqueado por directiva de grupo / archivo ausente. Se retrocede a la página de ajustes para dar al menos una vía de acceso
      shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- Ventana de aplicación (solo rotar / minimizar / maximizar / cerrar) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  // En modo de ventana independiente la imagen está en la ventana nativa del emulador y el marco está oculto — los botones deben actuar sobre la ventana
  // realmente visible. Se deja todo a appWin, que decide según el modo, evitando maximize/minimize sobre una ventana oculta.
  ipcMain.handle('shell:minimize', () => appWin.minimize());
  ipcMain.handle('shell:maximize', () => appWin.toggleMaximize());
  // Cerrar debe pasar por appWin.close(): primero separa la ventana del emulador del anfitrión y luego detiene la app Android.
  // La implementación antigua llamaba directamente a win.close(), saltándose esta limpieza: la ventana desaparecía pero el proceso Android seguía corriendo,
  // justo lo que los usuarios decían como «pulsar cerrar no cierra la app».
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  // El botón de rotar de la barra de título = «quiero usar esta app en horizontal / vertical».
  // Antes solo invertía el valor global landscape, así que pulsar rotar en Hongguo llevaba a **todas** las apps
  // al panel horizontal y la propia Hongguo acababa con barras negras. Ahora se escribe como anulación propia de esa app,
  // sin afectar a las demás (el modo «Forzar» de los ajustes sigue teniendo prioridad).
  ipcMain.handle('shell:rotate', () => {
    const pkg = appWin && appWin.pkg;
    // Se invierte tomando como base la «orientación real del panel», no appWin.state.landscape
    //(esta última es la «orientación deseada» y puede no haberse aplicado aún durante el cambio de panel al arrancar).
    const next = !displaySettings().landscape;
    if (pkg) {
      store.upsertApp({ package: pkg, orientationOverride: next ? 'landscape' : 'portrait' });
      appLog(`orientation override ${pkg} = ${next ? 'landscape' : 'portrait'}`);
    }
    return appWin.rotate(restartForOrientation);
  });

  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Ajustes del sistema Android (sin entrar al escritorio Android) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Ajuste desconocido ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---- Mapeo de teclas ----
  ipcMain.handle('shell:keyEvent', async (_e, key) => {
    if (!keymapEngine || !keymapEngine.enabled) return false;
    const pkg = currentAppPkg;
    if (!pkg) return false;
    return keymapEngine.handleKey(key, pkg);
  });
  ipcMain.handle('keymap:getPresets', () => {
    return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
  });
  ipcMain.handle('keymap:getMap', (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : []);
  ipcMain.handle('keymap:setMap', (_e, pkg, mappings) => {
    if (!keymapEngine) return { ok: false };
    keymapEngine.setMap(pkg, mappings);
    // Se guarda de forma persistente en ajustes
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    if (mappings && mappings.length) maps[pkg] = mappings;
    else delete maps[pkg];
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true };
  });
  ipcMain.handle('keymap:setEnabled', (_e, on) => {
    if (keymapEngine) keymapEngine.enable(!!on);
    store.saveSettings({ engine: { keymapEnabled: !!on } });
    return { ok: true };
  });
  ipcMain.handle('keymap:isEnabled', () => keymapEngine ? keymapEngine.enabled : false);
  ipcMain.handle('keymap:applyPreset', (_e, pkg, presetId) => {
    if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
    const mappings = KEYMAP_PRESETS[presetId].mappings;
    keymapEngine.setMap(pkg, mappings);
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    maps[pkg] = mappings;
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true, mappings };
  });

  // ---------------- Actualización en línea ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // Si el usuario pulsa «Buscar actualizaciones» → se omite la caché y se vuelve a preguntar a ambas fuentes
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // Las páginas de lanzamientos de GitHub y Gitee se pueden abrir directamente: cuando falla la comprobación, la interfaz se apoya en esto
    // para que el usuario descargue manualmente; permitir solo github.com dejaría fuera a los usuarios de China.
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- Ciclo de vida ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    // Identidad en la barra de tareas de Windows (AppUserModelID)
    // Si no se establece, Windows solo puede adivinar la identidad por la ruta del exe: elemento fijado, listas de salto y origen de notificaciones
    // acaban en "Electron" — y el usuario ve «el icono / nombre por defecto».
    // Ojo: aquí es la identidad del «proceso actual»; al cambiar a una app Android se sustituye por el AUMID propio de esa aplicación
    // (véase openAppWindow); si no, el elemento fijado y la ventana en ejecución no coinciden,
    // y el elemento fijado sigue mostrando el icono de ApkBuddyStart.
    setAumid(APP_AUMID);
    runtime = new Runtime(APP_ROOT);
    // Al arrancar se deja una línea de rastro: si hay problemas, el usuario envía app.log y se ven la versión y el directorio de datos
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);

    // ---- Ventana de la animación de arranque ----
    // Estilo inspirado en DSH de Douyin: logotipo con aparición gradual + barra de progreso + texto de estado.
    // En la primera instalación se muestran además los pasos de configuración; en las demás solo una animación reducida.
    // Cuando el entorno Android está listo, se desvanece y se cierra; la app entra al instante.
    const isFirstRun = !store.getSettings().runtime.installed;
    try {
      // Centrado en pantalla
      const { screen: electronScreen } = require('electron');
      const disp = electronScreen.getPrimaryDisplay();
      const sw = disp.workAreaSize.width;
      const sh = disp.workAreaSize.height;
      const splashW = 480, splashH = 360;
      splashWin = new BrowserWindow({
        width: splashW, height: splashH,
        x: Math.round((sw - splashW) / 2),
        y: Math.round((sh - splashH) / 2),
        frame: false, transparent: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#0b0c0e',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      // Se usa el nivel screen-saver para asegurarse de que no lo tape la ventana del emulador (antes el level por defecto de alwaysOnTop
      // competía en z-order con el SetForegroundWindow del agente y el splash quedaba relegado al fondo)
      splashWin.setAlwaysOnTop(true, 'screen-saver');
      splashWin.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      splashWin.once('ready-to-show', () => splashWin.show());
      // IPC: versión, marcador de primer arranque, cierre
      ipcMain.handle('splash:version', () => app.getVersion());
      ipcMain.handle('splash:isFirstRun', () => isFirstRun);
      // Si los componentes vienen incluidos: la animación cambia el texto según esto, para no decir «descargando» a usuarios que ya traen la imagen
      ipcMain.handle('splash:bundled', () => !!bundledRuntimeDir);
      ipcMain.on('splash:close', () => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
      });
    } catch (e) {
      appLog(`splash window failed: ${e.message}`);
      splashWin = null;
    }
    // Envía a splash las señales de progreso / finalización (variables a nivel de módulo, véase la nota al inicio del archivo)
    splashProgress = (p) => {
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:progress', p);
    };
    // La señal de desvanecimiento se envía una sola vez; además se coloca un «fusible»: si splash no se cierra solo en 2,5 s
    // (proceso de renderizado colgado / IPC perdido), el proceso principal lo cierra a la fuerza; la pantalla de arranque nunca se queda en el escritorio.
    let splashDoneSent = false;
    splashDone = () => {
      if (splashDoneSent) return;
      splashDoneSent = true;
      if (!splashWin || splashWin.isDestroyed()) return;
      try { splashWin.webContents.send('splash:done'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try {
          if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        } catch (_) { /* ignore */ }
        splashWin = null;
      }, 2500).unref?.();
    };
    // Tiempo de espera de respaldo: si ninguna ruta disparó splashDone (p. ej. arranque fallido y colgado), también hay que recogerlo,
    // si no, el splash seguiría flotando en el centro de la pantalla — la estampa más llamativa de «varias ventanas».
    setTimeout(() => { if (!splashDoneSent) splashDone(); }, 180000).unref?.();

    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows indexa para la búsqueda los .lnk del menú Inicio; poner solo el acceso en el escritorio hace que «no se encuentre la app»;
      // En Linux, el equivalente es el directorio de menú de aplicaciones freedesktop.
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // ---- Motor de mapeo de teclas ----
    const keymapEngine = new KeymapEngine({
      execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
      getSize: () => {
        // Se usa el tamaño actual del panel (horizontal 1280x720 / vertical 720x1280)
        const land = !!(store.getSettings().display || {}).landscape;
        return land ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      },
    });
    // Carga desde ajustes la tabla de mapeo de cada aplicación
    const savedMaps = (store.getSettings().engine || {}).keymaps || {};
    for (const [pkg, mappings] of Object.entries(savedMaps)) {
      if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
    }
    // Activado por defecto (el usuario puede desactivarlo en ajustes)
    keymapEngine.enable(store.getSettings().engine.keymapEnabled !== false);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // Para que el actualizador pueda leer «solo GitHub / solo Gitee / elegir el más rápido» y el ajuste de prefijo del espejo
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // Agregador de la rueda: los desplazamientos dentro de una ventana de tiempo se inyectan como un solo input swipe, por la shell adb residente.
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // Agente de ventanas: solo se encarga de incrustar la ventana del emulador. El hook global del ratón se instala según la configuración solo cuando la ventana de la app está en primer plano.
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // Rotar requiere cambiar la resolución lógica de Android; lo hace el cliente adb
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // Se pasa un getter: si se cambian las teclas en ajustes, surte efecto en el próximo focus / refresco de ventana, sin reiniciar
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // La ventana de la imagen la encuentra el agente por ámbito de proceso (la ventana del emulator incluido es la que nosotros arrancamos)
      windowTargets: () => null,
    });
    appWin.onCloseApp((pkg) => {
      // Cerrar ventana = detener esa app; al cerrar la última ventana, el contenedor se estaciona (baja prioridad, se detiene el sondeo),
      // pero el entorno Android se conserva, así que la próxima apertura entra al instante en vez de arrancar en frío.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // El cierre externo (Alt+F4 / botón de cerrar de la barra de tareas) también debe limpiar el marcador de app actual; si no, el menú del área de notificación
      // seguiría mostrando «Cerrar aplicación actual (xxx)» pero al pulsar no pasaría nada (la app ya se detuvo).
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // «Qué ventanas cuentan como nuestras» = directorio del entorno + directorio engine incluido en el paquete.
    // El agente de ventanas solo puede tocar ventanas creadas por esos procesos — ninguna otra app Qt (WeChat 4.x usa Qt6,
    // con el mismo nombre de clase de ventana que el emulador) debe ser modificada; véase SetScope en agent.ps1.
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // El ámbito vive en la memoria del proceso agente y se pierde al recrearlo — por eso se reenvía antes de cada supresión al arrancar.
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // El segundo parámetro es el pid de este proceso: con él, el agente se niega a incrustar ventanas en «ventanas que no son nuestras»
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('El ámbito de agent está vacío: no se suprimirá ninguna ventana (para evitar afectar a otros programas)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // Tras una salida inesperada del agente se recrea; los listeners de eventos deben volver a colgarse (la versión antigua perdía aquí
    // el botón derecho para atrás y la rueda, con el síntoma de «deja de responder al rato»).
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // El agente nuevo no tiene información de ámbito; sin este paso no se atreve a tocar ninguna ventana
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // La «compuerta» de supresión de ventanas de comandos debe abrirse antes de crear el proceso del emulador.
    // La implementación antigua «esperaba 4 s tras arrancar ApkBuddyStart para ocultar», pero el emulador ya había creado
    // la ventana de consola de qemu antes de eso — el usuario veía un recuadro negro que destellaba al pasar.
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // El agente de ventanas es un proceso PowerShell residente; su arranque en frío tarda unos 300~600 ms.
    // Se lanza antes, sin esperar a tener que ocultar una ventana para empezar a esperar.
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // Las apps instaladas con versiones antiguas no tenían el campo orientation (la función aún no existía).
    // Si no se completa, «seguir la app» solo puede retroceder a «orientación actual del panel» para ellas, y apps verticales como Hongguo
    // siguen con barras negras a los lados en un panel horizontal. Aquí se completa con el análisis sin conexión del manifiesto del APK incluido,
    // solo lee el directorio central + AndroidManifest; tarda unos cientos de ms y se ejecuta una sola vez.
    try {
      const { parseApk } = require('./core/apk');
      const filled = [];
      for (const app of store.getApps()) {
        if (app.orientation || !app.apkPath) continue;
        if (!fs.existsSync(app.apkPath)) continue;
        try {
          const meta = parseApk(app.apkPath);
          if (meta.orientation) {
            store.upsertApp({ package: app.package, orientation: meta.orientation });
            filled.push(`${app.label}=${meta.orientation}`);
          }
        } catch (_) { /* las apps cuyo análisis falla se omiten, sin afectar al arranque */ }
      }
      if (filled.length) appLog(`orientation backfill: ${filled.join(', ')}`);
    } catch (_) { /* ignore */ }

    // Espacio libre en disco: con menos de 3 GB Android no arranca (falla al escribir la imagen / la instantánea).
    // Mejor decirle sin rodeos dónde cambiarlo que dejarlo mirando «no se abre» sin entender nada.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Espacio insuficiente en el disco', `Solo quedan ${(freeMB / 1024).toFixed(1)} GB. Ve a «Ajustes → Integración del sistema» y cambia la carpeta de datos de Android / la carpeta del entorno de ejecución a otra unidad, o libera espacio en el disco primero.`);
          send('toast', { type: 'error', message: `El disco solo tiene ${(freeMB / 1024).toFixed(1)} GB, es posible que Android no pueda iniciarse (puedes cambiar de unidad en Ajustes → Integración del sistema)` });
        }, 3000).unref?.();
      }
    }

    // Las versiones antiguas solo creaban el acceso directo del escritorio / tenían icono null: se completa automáticamente al arrancar, sin intervención del usuario
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Acceso directo completado', fixed.join('、'));
      }
    }).catch(() => {});

    // F11 pantalla completa / cambio de ventana; los atajos globales solo funcionan mientras ApkBuddyStart esté vivo
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);
    else {
      // No se arrancó ninguna app directamente: el splash se desvanece cuando la ventana principal está lista
      if (typeof splashDone === 'function') {
        setTimeout(() => splashDone(), 800);
      }
    }

    // Precalentamiento: mantener el entorno Android residente, como WSA / la versión de escritorio de YingYongBao.
    // Al abrir ApkBuddyStart se prepara en segundo plano (ventana oculta todo el tiempo) y después pulsar una app solo requiere un am start.
    // Solo se precalienta si «ya se instaló alguna app + hay un entorno usable», para no desperdiciar memoria en el primer uso / un escenario puramente de gestión.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1,2 s bastan para dibujar el primer fotograma. Antes se esperaban 4 s y el usuario ya había pulsado la app,
      // con lo que «abrir» y «precalentar» competían por el mismo bloqueo AVD y era más lento.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // Durante el arranque se ocultan la ventana del emulador y la consola de qemu; el usuario no debería ver ninguna ventana
          // Ojo con await: si se hace spawn sin esperar a que surta efecto, la ventana negra aparece seguro.
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // Si el precalentamiento falla, se sigue manteniendo oculta la ventana del emulador: quizá solo va lenta y arranca enseguida,
            // el usuario no debería ver un emulador en el escritorio por «falló el precalentamiento».
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* un fallo del precalentamiento no afecta a la apertura normal posterior */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // El despliegue de componentes del primer arranque se retrasa 20 s: durante el arranque en frío, disco y CPU ya están al límite,
    // descargar y descomprimir a la vez solo empeoraría los tirones; si hay una app que abrir, ensure() ya se encarga.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'El entorno de ejecución se ha preparado automáticamente' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 8 s después del arranque se comprueba silenciosamente si hay versión nueva (solo tiene sentido empaquetado). Si la hay, solo se avisa,
    // nunca se descarga automáticamente — actualizar es algo que el usuario hace al pulsar «Actualizar ahora».
    // La versión de la tienda (MSIX) se omite: el directorio de instalación es WindowsApps, de solo lectura; la autoactualización no puede escribir ni
    // es conforme a norma; las actualizaciones las gestiona Microsoft Store.
    if (app.isPackaged && !store.STORE_BUILD) {
      // issue #98: primero se comprueba «una actualización ya descargada y extraída, pero cuya sustitución / reinicio no se completó».
      // Si coincide, se repite la sustitución + reinicio con el payload local, sin volver a descargar: esto erradica el bucle infinito de actualización.
      // Se coloca antes de buscar versiones nuevas para que la reanudación y una nueva comprobación no compitan por la barra de progreso.
      let resuming = false;
      try {
        const job = updater.findResumableJob();
        if (job) {
          resuming = true;
          appLog(`resuming pending update ${job.version} from cached payload`);
          send('update:progress', { stage: 'apply', percent: 100, message: 'Completando la actualización anterior que quedó incompleta…' });
          updater.apply(job);
          setTimeout(() => { quitting = true; app.quit(); }, 900);
        }
      } catch (e) { appLog(`resume check failed: ${e.message}`); }
      // Si se reanuda, no se inicia en paralelo una nueva búsqueda; pero no se puede usar return para salir de toda la callback de arranque.
      if (!resuming) setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // Ya no se muestra una notificación aparte: los avisos del arranque se unifican en la «tarjeta de bienvenida» de la app,
            // evitando otra burbuja en la esquina inferior derecha al iniciar automáticamente (una de las «ventanitas emergentes» que reportaban los usuarios).
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // La sincronización de archivos / el sondeo de notificaciones ya no son permanentes sin condiciones: solo se ejecutan si hay ventanas de app en el contenedor
    // (véase onContainerActive).

    // Prueba de humo: captura la pantalla y sale; sirve para verificar automáticamente que la interfaz se renderiza bien
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // El panel del entorno se ha integrado en ajustes: --setup y --settings son equivalentes; se abre ajustes y se captura
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // La ventana puede estar tapada y dar un fotograma antiguo: se fuerza un redibujado y se toman dos capturas, usando la segunda
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // Captura la zona «Rendimiento y uso de recursos» (la que más controles tiene en ajustes)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // Captura la zona «Descarga y fuentes de actualización»
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // Otra captura de la zona «Acerca de» (códigos QR / GitHub / Powered by)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] Error al capturar pantalla', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // Al cerrar la ventana normalmente solo se oculta en el área de notificación (el evento close ya está interceptado),
    // llegar hasta aquí significa que realmente se quiere salir; hay que dejar pasar, o el proceso quedaría residual y mantendría el bloqueo de instancia única.
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Antes de salir hay que pedir al agente de ventanas que «separe + oculte bien» la ventana del emulador. Este paso es asíncrono
    // (hay que esperar la respuesta del agente), así que el primer before-quit se intercepta y se sale de verdad al terminar la limpieza.
    // Sin este paso, al destruir la ventana anfitriona Windows vuelve a colgar la ventana hija del emulador en el escritorio y la muestra —
    // el síntoma es «tras cerrar ApkBuddyStart queda una ventana negra de Android Emulator en el escritorio».
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // La ventana oculta de decodificación de iconos también cuenta; si no se cierra, window-all-closed nunca se dispara
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
