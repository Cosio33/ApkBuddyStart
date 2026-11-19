'use strict';
/**
 * Validación de la legalidad de los nombres de paquete de Android.
 *
 * El nombre de paquete procede del AndroidManifest.xml del APK (entrada externa), pero se usa
 * directamente para construir rutas de archivos locales (store.iconPath / apkPath) y comandos
 * adb shell (pm path / pidof / am start…). Sin validación, equivale a entregar «../», letras de
 * unidad y metacaracteres del shell directamente a path.join y al shell: lo primero escribe fuera
 * del directorio de destino, lo segundo es inyección de comandos.
 *
 * Las restricciones reales de un nombre de paquete Android: varios segmentos separados por puntos,
 * cada uno empieza por letra/subrayado y continúa con letras/dígitos/subrayados. Aquí se valida
 * estrictamente en ASCII: se prefiere rechazar algún paquete de terceros extraño antes que dejar
 * pasar cualquier separador de ruta o carácter de shell.
 */
const RE_PKG = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function validPackageName(pkg) {
  return typeof pkg === 'string' && RE_PKG.test(pkg);
}

/** Reescribe un nombre de paquete inválido como nombre de archivo seguro (para registros / visualización de reserva, no para instalación) */
function safeFilePart(pkg) {
  if (validPackageName(pkg)) return pkg;
  return `invalid-${String(pkg || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
}

module.exports = { validPackageName, safeFilePart, RE_PKG };
