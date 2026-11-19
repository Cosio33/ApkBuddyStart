'use strict';
/**
 * Parte de cálculo puro de la adaptación de pantalla (probable con pruebas unitarias, sin
 * dependencias de Electron / adb).
 *  - Pantalla completa: la resolución de Android se alinea con el área de trabajo del monitor y
 *    el contenido se expande automáticamente;
 *  - Ventana: se mantiene la predefinición vertical; al arrastrar la ventana, Qt la escala
 *    automáticamente y el tamaño se guarda en los metadatos de la aplicación.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Pantalla completa = ocupar toda la altura de la pantalla y centrar horizontalmente.
 * La relación de aspecto de la ventana del emulador queda fijada por el LCD al arrancar (9:16);
 * un SW_MAXIMIZE directo solo produce una ventana pegada a la izquierda con el mismo ancho.
 * Calcular la altura a pantalla completa según la proporción y luego centrarla da, visualmente,
 * «la aplicación ocupa toda la pantalla» sin deformar la imagen.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Resolución del lado de Android: ambos modos mantienen la predefinición vertical.
 * Motivo: la relación de aspecto de la ventana del emulador queda bloqueada por el tamaño del LCD
 * al arrancar (en pruebas, al cambiar a 1920x1080 la ventana seguía aceptando solo 9:16 y la
 * imagen quedaba con bandas negras o deformada). Por tanto, «pantalla completa» = maximizar la
 * ventana para llenar la pantalla, y «ventana» = vertical con estiramiento libre; ambos comparten
 * la misma resolución de Android, así que cambiar de modo no requiere reiniciar el runtime ni
 * hace que la aplicación rehaga su diseño.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
