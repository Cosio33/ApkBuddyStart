'use strict';
/**
 * Contenedor a nivel de aplicación (capa de cálculo puro).
 *
 * Por debajo, ApkBuddyStart es una máquina virtual QEMU de sistema completo; no puede, como WSA u otros, «cargar solo
 * los servicios del sistema que necesita una app»: el núcleo Linux, zygote y system_server tienen que arrancar enteros.
 * Pero lo «pesado» que nota el usuario no viene de esos servicios residentes, sino de:
 *   1. Cada vez que abre una app se reinicia Android por completo (arranque en frío de 40~142 s, CPU/disco al máximo);
 *   2. Las apps abiertas antes siguen en segundo plano consumiendo memoria, red y wake locks;
 *   3. Sin ninguna app en primer plano, qemu sigue compitiendo con el escritorio con prioridad Normal;
 *   4. La sincronización de archivos y el sondeo de notificaciones siguen corriendo aunque no haya ninguna app abierta.
 *
 * Aquí se convierten en comandos orquestables y fácilmente testeables las partes que realmente se pueden recortar:
 *   - El entorno se arranca una sola vez; «abrir una app» = am start + acoplar la ventana (lo hace Runtime.beginApp);
 *   - Al abrir una app nueva, se detienen los procesos de otras apps de usuario y solo se deja el entorno que necesita la actual;
 *   - Al cerrar la última app, Android pasa a idle, se limpian los procesos en segundo plano y baja la prioridad de qemu;
 *   - Los paquetes del sistema no se tocan por defecto (detener GMS hace que las apps que dependen de notificaciones/login
 *     muestren errores una y otra vez); solo se desactiva un pequeño grupo de paquetes de segundo plano claramente inútiles
 *     cuando el usuario activa explícitamente el «recorte profundo».
 *
 * Este archivo no depende de adb / Electron; todo son funciones puras, fácil de probar en regresión.
 */

/** En ningún caso se recorta: tocarlos provoca directamente pantalla negra o cierre de apps */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Solo se desactivan con «recorte profundo»: estos paquetes solo hacen actualizaciones/fondos de pantalla/impresión en segundo plano; detenerlos no afecta a abrir apps */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Tienda de Play (escaneo de actualizaciones en segundo plano)
  'com.google.android.setupwizard',         // Asistente de configuración inicial
  'com.android.printspooler',               // Servicio de impresión
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // Protector de pantalla
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Paquetes claramente del sistema/framework: se omiten al recortar la sesión, para evitar matar algo por error */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Solo se permite concatenar en comandos shell nombres de paquete Android válidos, para evitar inyección si el manifiesto está contaminado */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Comandos de recorte que hay que ejecutar al abrir una app.
 * @param {object} o
 * @param {string} o.pkg             paquete que se va a abrir ahora
 * @param {string[]} o.installed     paquetes de apps de usuario instalados en la máquina (la lista de la tienda)
 * @param {boolean} o.deep           recorte profundo (desactivar paquetes de segundo plano del sistema), por defecto false
 * @param {boolean} o.killBackground  si además se limpian los procesos en caché de segundo plano, por defecto false
 *   (limpiar en el arranque puede afectar a una app que acaba de pasar a primer plano; la limpieza la hace el comando de estacionamiento de endApp)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Se limpian los procesos en segundo plano de la caché del sistema (ni primer plano ni servicios persistentes),
  // para que «quedar solo la app actual» no se limite a un force-stop del paquete, sino que devuelva de verdad la memoria.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // Con red medida, se prohíben los datos en segundo plano para evitar que la tienda/sincronización siga despertando el dispositivo
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * Tras cerrar la última app, dejar el contenedor «en vacío pero sin consumir recursos».
 * No se apaga ni se destruye el AVD: la próxima apertura sigue siendo instantánea, solo se cede CPU/memoria a Windows.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Volver del recorte profundo (se llama cuando el usuario desactiva el interruptor; garantiza que se puede revertir) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Máquina de estados de la sesión: decide en qué estado debe quedar el contenedor tras un launch/close.
 * Función pura, para verificar fácilmente casos límite como «cambiar entre varias ventanas» o «cerrar la última ventana».
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** Resumen de una línea para logs/diagnóstico */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Contenedor inactivo (Android residente pero con prioridad reducida, 0 procesos de aplicación)';
  return `Contenedor activo:${n} ventanas de aplicaciones${plan && plan.stopped && plan.stopped.length
    ? `, se detuvo ${plan.stopped.length} aplicaciones en segundo plano` : ''}`;
}

/**
 * Máquina de estados de la sesión con varias ventanas (plan B).
 *
 * A diferencia de nextSessionState de una sola ventana, aquí active puede contener varias apps y hay que distinguir
 * «la que se está viendo en primer plano» de «las que cuelgan en segundo plano». Las apps en segundo plano son las que más memoria
 * consumen, así que se introduce la estrategia de «lápida» (tombstone):
 *   - foreground: la que tiene una ventana con imagen con la que el usuario interactúa ahora;
 *   - background: sigue «abierta» pero sin ventana; tras superar el periodo de gracia debe recibir force-stop (tombstone),
 *     y al volver a abrirla se recupera con arranque en caliente: el coste es recargar la página una vez, sin perder sesión ni datos.
 *
 * @param {string[]} active         todos los paquetes de apps activos ahora
 * @param {string} foreground       paquete en primer plano (puede ser null)
 * @returns {{foreground:string|null, background:string[], count:number}}
 */
function sessionRoles(active = [], foreground = null) {
  const set = (active || []).filter(Boolean);
  const fg = foreground && set.includes(foreground) ? foreground : (set.length ? set[set.length - 1] : null);
  return {
    foreground: fg,
    background: set.filter((p) => p !== fg),
    count: set.length,
  };
}

/**
 * Decidir qué apps de segundo plano deben recibir tombstone (force-stop para recuperar memoria).
 *
 * Reglas (conservadoras: mejor matar pocas que afectar a una que se está usando):
 *   - Solo se tratan las de background; a foreground nunca se toca;
 *   - Los paquetes del sistema / NEVER_TRIM se omiten siempre;
 *   - Se conservan los N background más recientes (por defecto 1) para volver rápido sin perder la sesión; el resto recibe tombstone;
 *   - tombstoneLimit<=0 significa «no conservar ninguno en segundo plano», todos reciben tombstone (máximo ahorro de memoria).
 *
 * @param {object} o { background, installedSystem?, keepRecent?, tombstone? }
 * @returns {{tombstone:string[], keep:string[]}}
 */
function planTombstones({ background = [], keepRecent = 1 } = {}) {
  const bg = (background || []).filter((p) => p && !isSystemPackage(p) && !NEVER_TRIM.includes(p));
  // El final de background es el más reciente; se conservan los últimos keepRecent y el resto va a tombstone
  const keepCount = Math.max(0, Number(keepRecent) || 0);
  const keep = bg.slice(Math.max(0, bg.length - keepCount));
  const tombstone = bg.filter((p) => !keep.includes(p));
  return { tombstone, keep };
}

/** Generar el comando de tombstone: force-stop del paquete en segundo plano indicado, recupera su memoria pero conserva datos/sesión */
function buildTombstoneCommands(pkgs = []) {
  return pkgs.filter((p) => SAFE_PKG.test(String(p))).map((p) => `am force-stop ${p}`);
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
  sessionRoles, planTombstones, buildTombstoneCommands,
};
