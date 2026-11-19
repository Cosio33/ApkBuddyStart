'use strict';
/**
 * Persistencia local: manifiesto de apps + ajustes
 * Directorio de datos: %APPDATA%\apkstart (para la versión MSIX/Store véase la nota de STORE_BUILD más abajo)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
 * ¿Es una versión empaquetada de Microsoft Store (MSIX / APPX)?
 *
 * Las aplicaciones full-trust de MSIX redirigen **las escrituras** bajo `%APPDATA%` / `%LOCALAPPDATA%`
 * a `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`, pero las variables de entorno y las API
 * siguen devolviendo la «ruta real» anterior a la redirección. Eso provoca dos tipos de incidentes:
 *   1. Si el emulator/adb/qemu que lanzamos desde %APPDATA%\apkstart no tiene identidad de paquete,
 *      buscar los archivos por la ruta real da «archivo no encontrado»;
 *   2. El usuario pulsa «Abrir directorio de datos» y ve un directorio vacío.
 * Por eso, en la versión de Store el directorio de datos se pone **fuera** de AppData (%USERPROFILE%\ApkBuddyStart),
 * quedando completamente fuera del ámbito de virtualización, y los procesos padre e hijo ven los mismos archivos reales.
 *
 * process.windowsStore lo inyecta Electron en entornos MSIX/APPX (con node normal es undefined).
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'ApkBuddyStart', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
   * Extensión de controladores (parches de compatibilidad): los JSON de parches escritos por el usuario van en drivers/ dentro del directorio de datos.
   * Aquí solo se registran «los id desactivados por el usuario»: por defecto todos activos; si uno se rompe, se apaga con un clic sin borrar archivos.
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // Solo hay un runtime: el incluido (builtin). El campo se conserva por compatibilidad con la fusión de settings.json antiguos;
    // al leer los ajustes se fuerza de nuevo a 'builtin' (véase la migración en getSettings).
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = doctor decide automáticamente según la memoria de la máquina
    cores: 0,                // 0 = automático
    autoMemory: true,        // Cero configuración: se deducen automáticamente memoria/núcleos/disco/parámetros de renderizado
    idleShutdownMinutes: 15,
    startVisible: true,
    // Debe haber ventana: sin ventana, SurfaceFlinger no genera VSYNC y el proceso de la app sigue vivo pero no aparece nada en pantalla.
    // El emulador con ventana va a 60 fps nativos + ratón/teclado nativos; ApkBuddyStart solo se encarga de disfrazarlo de ventana de aplicación.
    headless: false,
    gpuMode: 'auto',         // auto = elegir automáticamente el backend según la versión de emulator y degradar por niveles
    // Último backend de renderizado que «se cayó nada más arrancar» (formato `<versión de emulator>|<gpu>`); en modo auto se pone al final la próxima vez,
    // para no perder 20 y pico segundos en cada arranque antes de retroceder al renderizado por software. Se invalida al actualizar el runtime.
    badGpu: '',
    forceTcg: false,         // Se conserva para diagnóstico avanzado; la ruta normal ya retrocede automáticamente mediante doctor
    audio: true,             // Sonido de las apps de Android (avisos / vídeo). Desactivarlo ahorra algo de CPU
    // ---- Contenedor ligero (todo activo por defecto para ahorrar recursos; el usuario puede desactivar cada opción) ----
    liteMode: true,          // Limita la cuota de vCPU para evitar que qemu ocupe todos los núcleos físicos y ralentice Windows
    // Estrategia en una frase: save (ahorrar recursos) / balanced (equilibrado) / smooth (fluido, prioridad a vídeo y juegos).
    // En la interfaz solo se expone esta opción; al guardar se traduce automáticamente a liteMode / priorityMode / renderSize,
    // y abajo se conservan los interruptores finos para usuarios avanzados.
    resourceMode: 'balanced',
    // Capacidad de la partición de datos (GB): aquí se instalan las apps, las cachés de juegos y sus paquetes de actualización.
    // 0 = automático (6/8 GB según el disco libre). Al aumentarla, se amplía **in situ** en el próximo arranque de Android, sin perder las apps instaladas.
    dataPartitionGB: 0,
    // Resolución de renderizado: más baja = más fluida y menos consumo; auto = elegir 720x1280 / 540x960 según el estado de aceleración
    renderSize: 'auto',
    // Aceleración de red: se especifica un DNS público chino para el emulador. El 10.0.2.3 por defecto de Android pasa por el DNS del host,
    // y con VPN / redes de empresa / algunos operadores la resolución puede tardar cientos de ms y las apps de vídeo se traban al cargar.
    fastDns: true,
    // Idioma del sistema: se inyecta al arrancar con emulator -prop (un setprop dentro del guest sería rechazado por SELinux).
    // Por defecto, chino simplificado. Poner en-US u off vuelve al inglés nativo de la imagen.
    locale: 'zh-CN',
    // Método de entrada en chino: se incluye el teclado Pinyin de Google de AOSP y se instala/activa en silencio tras el arranque.
    // La imagen de sistema solo trae LatinIME (teclado inglés); sin instalarlo no se puede escribir en chino.
    chineseIme: true,
    chineseImeDefault: true,
    // Instantánea: la instantánea de memoria de quickboot hace que el segundo arranque tarde solo unos segundos, a cambio de un
    // ram.bin adicional de unos 2~3 GB en disco. Se puede desactivar si el disco aprieta (solo afecta a la velocidad de arranque, no a los datos).
    keepSnapshot: true,
    // Límite del log (KB): al superarse se rota una copia, para evitar que el uso prolongado llene el disco
    logLimitKB: 2048,
    // Ratón y teclas: el botón izquierdo lo mapea el emulador de forma nativa a «confirmar / clic», no necesita interruptor.
    // El botón derecho (volver) y la rueda suave requieren un hook de bajo nivel, pero solo se instalan con la ventana de la app en primer plano y se descargan al perder el foco.
    mouseRightBack: true,    // Botón derecho = Volver de Android (evita el fallo de Qt de tratar el clic derecho también como clic)
    mouseWheelMode: 'smooth', // smooth = se unen y se inyecta un único desplazamiento | native = se lo deja a Qt | off = no se procesa
    mouseSideButtons: false, // Botones laterales para atrás/adelante: desactivados por defecto; al activarlos se añade un mapeo más
    deepTrim: false,         // Recorte profundo de paquetes de segundo plano del sistema (Play Store / asistente, etc.); por defecto no se toca el sistema
    // balanced=ceder el primer plano | performance=qemu Normal | game=qemu High + entrada de baja latencia
  priorityMode: 'balanced',
    // Calentamiento previo: tras iniciar ApkBuddyStart se arranca el entorno de Android en segundo plano y la primera vez que se pulsa una app casi no hay espera.
    // El coste es unos 1 GB de memoria residente (la misma compensación que WSA / la versión de PC de Tencent MyApp); se puede desactivar cuando se quiera.
    prewarm: true,
    // Multiventana (plan B): permite abrir varias apps a la vez, cada una en su ventana. Desactivado por defecto,
    // para mantener el comportamiento de ventana única «abro una y cierro la anterior»; al activarlo, el mecanismo de lápidas recicla el segundo plano y los recursos quedan controlados.
    multiWindow: false,
    // En multiventana se conservan las últimas apps en segundo plano sin convertirlas en lápidas (para volver rápido sin perder la sesión).
    // 0 = máximo ahorro de memoria (solo primer plano); por defecto 1.
    keepBackground: 1,
    // Mapeo de teclas (teclado de juego → pantalla táctil): activado por defecto; el usuario puede desactivarlo en Ajustes
    keymapEnabled: true,
    // Tabla de mapeo por app: { "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // Vacío = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // Especificar manualmente la URL del paquete de instalación de QEMU
    isoUrl: '',              // Especificar manualmente la URL de la imagen de sistema
    isoPath: '',             // Ruta de la imagen de sistema (ISO)
    diskPath: '',            // Disco virtual donde se instala el sistema
    diskSizeGB: 24,
    headless: false,         // No mostrar la ventana de la máquina virtual (solo para depuración)
    installMode: 'guided',   // guided (instalación manual guiada) | auto (instalación automática experimental)
    emulatorUrl: '',         // Especificar manualmente la URL del paquete emulator (vacío = resolver la última versión automáticamente desde el índice del SDK)
    sysimgUrl: '',           // Especificar manualmente la URL del paquete de imagen de sistema
    compatImage: false,      // Modo de compatibilidad ARM: usar la imagen de Google Play (con native bridge integrado, permite instalar apps solo ARM)
    deployFailedAt: 0,       // Marca de tiempo del último fallo de despliegue automático (0 = sin fallos). Tras un fallo no se vuelve a descargar automáticamente durante 30 minutos
    // Paquete completo de runtime de la edición portable: por defecto se descarga del GitHub Release de este proyecto (misma fuente que «Actualización de software»),
    // y si no se puede obtener se recurre automáticamente a la descarga por componentes de dl.google.com. Aquí se puede cambiar a una URL de espejo propio.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // Prefijo de espejo de aceleración de GitHub (opcional). La conexión directa a GitHub Releases desde China suele ir a decenas de KB/s,
    // y basta con poner un prefijo como https://ghfast.top/ para redirigir las peticiones de downloads.
    // Vacío = conexión directa (también se prueba primero con descarga fragmentada de 8 hilos, que puede llenar el ancho de banda).
    mirrorPrefix: '',
    // Número de conexiones concurrentes de descarga: el número de conexiones de la descarga por bloques. Por defecto 8; en redes débiles / limitadas se puede subir a 16.
    downloadConnections: 8,
    // Selección de origen para actualizaciones/descargas. auto = preguntar a la vez a GitHub y Gitee y medir la velocidad real de
    // 128 KB de cada URL de descarga, usando el más rápido; también se puede forzar un solo origen (útil si la red corporativa solo permite un dominio).
    sourcePreference: 'auto',
    // Probar automáticamente los espejos públicos de aceleración de GitHub (ghfast / gh-proxy). Al desactivarlo solo se usan la conexión directa + el prefijo personalizado.
    // Estos dos son servicios de terceros que solo reenvían archivos públicos de releases, sin intervención de datos de cuenta.
    autoMirror: true,
    // La API de releases de Gitee exige access_token incluso para repositorios públicos (sin token da 404 directamente);
    // para usar Gitee como origen de actualización, rellenar aquí un token de solo lectura; si se deja vacío, solo se usan GitHub + espejos.
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkBuddyStartShared'),
  deviceSharedDir: '/sdcard/ApkBuddyStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Acceso directo del menú Inicio = permite que la búsqueda de Windows encuentre la app
  shortcutDir: '',           // Vacío = escritorio
  freeform: false,           // Se comparte una única ventana del runtime; ya no se usa la ventanita freeform de Android
  hideAfterLaunch: false,    // El proceso principal debe permanecer, o al salir mataría el entorno de ejecución de Android
  notifyOnInstall: true,
  autoStart: true,           // Inicio automático con Windows, activado por defecto, sin que el usuario tenga que configurarlo
  autoDeploy: true,          // La primera ejecución completa todo el despliegue automáticamente, sin dividerlo en 5 pasos
  // Tarjeta de bienvenida al arrancar: lastDate guarda la fecha de la última aparición automática (como máximo una al día si se abre manualmente);
  // disabled = el usuario marcó «No volver a mostrar automáticamente».
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window (ventana vertical, redimensionable libremente) | fullscreen (se adapta automáticamente a la pantalla)
    portrait: '900x1600',    // Resolución vertical del modo ventana; se puede ajustar el tamaño en Ajustes
    density: 0,              // 0 = se deduce automáticamente de la resolución
    rememberBounds: true,    // Recordar la posición / el tamaño de la ventana de cada app
    autoFullscreenOnLaunch: false,
    // Horizontal = cambiar el panel físico del AVD a 1280x720 y reiniciar (la única forma de conseguir imagen derecha y que llene todo).
    // Se guarda aquí, de modo que tras reiniciar ApkBuddyStart se arranca de nuevo en esa orientación.
    landscape: false,
    // Estrategia de orientación de pantalla:
    //   auto      = cambiar automáticamente el panel físico según la orientación declarada por la app (recomendado; solo así la imagen llena la ventana)
    //   landscape = forzar panel horizontal
    //   portrait  = forzar panel vertical
    // El campo landscape de arriba, en modo auto, pasa a ser un dato («orientación real actual del panel»),
    // escrito por restartForOrientation y ya no se usa como preferencia para sobrescribir la orientación propia de la app.
    orientationMode: 'auto',
    // Diseño de tableta: se sobrescribe la densidad lógica del guest a 190 dpi (720 de ancho → sw606dp ≥ 600dp,
    // superando el punto de corte de tableta de Android). Apps de drama corto como Hongguo solo tienen la página de episodios a dos columnas
    // con diseño de tableta, que es lo que el usuario llama «modo tableta». Al desactivarlo se vuelve a la densidad por defecto de la imagen (diseño de móvil).
    tabletMode: true,
    // Modo ventana: true = incrustar la imagen de Android en la ventana propia de ApkBuddyStart (aspecto unificado);
    // false = dejar que el emulador abra su ventana nativa (evita los problemas inherentes de la incrustación: bordes negros, coordenadas desplazadas, falta de relleno).
    windowEmbed: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Se elimina un posible BOM UTF-8. Con BOM, JSON.parse lanza un error y toda la configuración
    // cae silenciosamente a los valores por defecto: el usuario ve «se perdieron todos mis ajustes» sin saber por qué.
    // Este archivo lo tocan la página de ajustes, herramientas de sincronización e incluso el usuario a mano, así que debe tolerar el BOM.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Estrategia de recursos → interruptores concretos.
 *   save     : 2 vCPU + baja prioridad + 540x960, para portátiles antiguos / dejar reposando;
 *   balanced : la mitad de los núcleos físicos para vCPU (2~4) + ceder el primer plano + 720x1280;
 *   smooth   : sin límite de vCPU + misma prioridad que el primer plano + 720x1280, prioridad a vídeo y juegos.
 * De momento no se toca el 1080p: la huella de la instantánea quickboot está ligada a la resolución y cambiarla obliga a un rearranque en frío,
 * mientras que en una ventana con proporción de móvil el 720p ya no se nota la diferencia y el rendimiento sí cambia de nivel.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  // Marca de la versión empaquetada de Store (MSIX): main.js la usa para desactivar la autoactualización y omitir la instalación de controladores de kernel que requieren permisos de administrador
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
     * Desde la 0.5.6 ya no hay bases de terceros: los valores antiguos mode=mumu / fydeos / attach,
     * o cualquier otro valor escrito a mano, se tratan siempre como builtin y se borran los campos residuales de terceros.
     *
     * Solo se cambia el objeto en memoria al leer, sin escribir en disco de inmediato: el archivo de ajustes es del usuario;
     * ya se guardará la próxima vez que guarde sus ajustes. Así no ocurre eso de «abrir ApkBuddyStart una vez y haber modificado su settings.json».
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
    // Las versiones antiguas funcionaban sin ventana por defecto: el proceso de la app arrancaba pero no había ventana en pantalla, equivalente a «no se abre».
    // Se migra incondicionalmente al modo con ventana y ya no se permite desactivarlo mediante la configuración antigua.
    s.engine.headless = false;
    // Las versiones antiguas mataban todo el entorno de Android al cerrar el shell, de modo que el icono del escritorio parpadeaba y desaparecía.
    s.hideAfterLaunch = false;
    // Las versiones antiguas usaban la ventanita freeform de Android; ahora toda la ventana del emulador es la ventana de la app,
    // y la app debe llenar esa pantalla, o aparecería «una ventanita dentro de la ventana».
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // Cuando solo cambió la «estrategia de recursos», se traduce a los tres interruptores concretos para que dos configuraciones no se contradigan
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // Segunda línea de defensa: pkg viene de un APK / apps.json analizado externamente y debe quedar confinado al directorio de datos.
    // Aunque haya un registro malo escrito por una versión anterior, no se le debe permitir componer una ruta fuera de ICON_DIR (issue #2 P0-1).
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
