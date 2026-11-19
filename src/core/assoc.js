'use strict';
/**
 * Asociación de archivos .apk (solo escribe en HKCU, no necesita permisos de administrador)
 * doble clic en apk → apkstart.exe "%1" → instalación automática → acceso directo automático en el escritorio
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkBuddyStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
// La asociación «predeterminada original» se guarda aquí; al desinstalar se devuelve tal cual, para no perder la asociación del usuario
const STORE_KEY = 'HKCU\\Software\\ApkBuddyStart';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/** Lee el valor predeterminado de una clave (REG_SZ); devuelve cadena vacía si no se puede leer */
function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/** Lee la «asociación anterior» que guardamos */
function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'ApkBuddyStart' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
  } catch (_) { /* que falle la notificación no afecta a la asociación */ }
}

/**
 * @param {string} exePath ruta al ejecutable principal de ApkBuddyStart (en modo desarrollo es electron.exe)
 * @param {string} [iconPath] ico opcional
 * @param {string} [extraArgs] en modo desarrollo hay que pasar primero el directorio de la app, p. ej. "\"C:\\path\\apkstart\""
 */
function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  // Recordar el programa predeterminado de .apk antes de asociar: si el usuario ya tenía
  // otra herramienta Android instalada, al desinstalar ApkBuddyStart hay devolvérsela,
  // en vez de dejar .apk «sin programa predeterminado».
  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* no existía */ }
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Paquete de aplicación de Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Paquete de aplicación de Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Instalar en ApkBuddyStart', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

/**
 * Cancela la asociación.
 * La implementación anterior borraba sin condiciones el valor predeterminado de .apk
 * (el comentario decía «solo si aún apunta a nosotros», pero el código no lo hacía),
 * así que al desinstalar ApkBuddyStart se borraba también la asociación original del usuario. Ahora:
 *  1) Hay un registro previo → se restaura tal cual;
 *  2) No hay registro y el valor actual sigue siendo el nuestro → se limpia;
 *  3) El valor actual es de otro → no se toca ni un byte.
 */
function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
