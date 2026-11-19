'use strict';
/**
 * Conversiones geométricas puras (sin dependencias; se pueden probar con require directo en
 * entornos CI/Node sin Electron).
 *
 * Las coordenadas de screen / BrowserWindow de Electron son siempre DIP (píxeles independientes
 * del dispositivo), mientras que el agente de ventana agent.ps1 declara en su cabecera la
 * conciencia de DPI por monitor v2, de modo que el Win32 SetWindowPos que invoca recibe píxeles
 * físicos. Mezclar ambos, con escalados del 125 % / 150 %, produce «ventanas que solo muestran
 * la mitad / se desplazan a una esquina / clics desalineados» (issue #99). El _rect() del modo
 * incrustado ya multiplicaba por scaleFactor; aquí se extrae la misma conversión para reutilizarla
 * en el modo de ventana independiente y probarla por separado.
 */

/**
 * Convierte un rectángulo DIP a píxeles físicos.
 * @param {{x:number,y:number,w:number,h:number}} rect Rectángulo en píxeles lógicos DIP
 * @param {number} [scaleFactor] Factor de escala; con 1 o si se omite, se devuelve tal cual (mismo objeto, coste cero)
 * @returns {{x:number,y:number,w:number,h:number}} Rectángulo en píxeles físicos
 */
function physicalRect(rect, scaleFactor) {
  const k = Number(scaleFactor) || 1;
  if (!rect || k === 1) return rect;
  return {
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    w: Math.round(rect.w * k),
    h: Math.round(rect.h * k),
  };
}

module.exports = { physicalRect };
