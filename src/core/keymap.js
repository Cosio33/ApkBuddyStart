'use strict';
/**
 * Mapeo de teclas para juegos: capa de datos pura
 *
 * Asigna teclas del teclado a coordenadas táctiles de Android. Cada entrada de mapeo:
 *   { key: 'w', action: 'tap', x: 0.15, y: 0.85 }   // Coordenadas relativas (0~1)
 *   { key: 'space', action: 'tap', x: 0.5, y: 0.9 }
 *   { key: 'j', action: 'swipe', x1: 0.7, y1: 0.5, x2: 0.3, y2: 0.5, duration: 100 }
 *
 * Las coordenadas están normalizadas respecto al panel LCD (0~1); en tiempo de ejecución se
 * multiplican por el wm size real para obtener píxeles.
 *
 * Las plantillas predefinidas cubren los tipos de juego habituales:
 *   - fps: zona del joystick de movimiento con WASD + puntería con el ratón (el ratón lo gestiona
 *     Qt de forma nativa; aquí solo se trata el teclado)
 *   - rpg: movimiento con WASD + habilidades con J/K/L + confirmación con Space
 *   - generic: flechas de dirección + Enter/Space
 */

const PRESETS = {
  fps: {
    label: 'FPS / juegos de disparos',
    desc: 'WASD controla la zona izquierda del joystick virtual, J dispara, K recarga, Space salta',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.85, y: 0.75 },
      { key: 'k', action: 'tap', x: 0.92, y: 0.82 },
      { key: ' ', action: 'tap', x: 0.78, y: 0.82 },
    ],
  },
  rpg: {
    label: 'RPG / acción',
    desc: 'WASD para moverte, J atacar, K habilidad, L definitiva, Space confirmar/diálogo',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.82, y: 0.78 },
      { key: 'k', action: 'tap', x: 0.90, y: 0.78 },
      { key: 'l', action: 'tap', x: 0.86, y: 0.70 },
      { key: ' ', action: 'tap', x: 0.5, y: 0.92 },
    ],
  },
  generic: {
    label: 'General / casual',
    desc: 'Flechas para moverte, Enter confirmar, Space cancelar/volver',
    mappings: [
      { key: 'ArrowUp', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'ArrowLeft', action: 'tap', x: 0.08, y: 0.82 },
      { key: 'ArrowDown', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'ArrowRight', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'Enter', action: 'tap', x: 0.5, y: 0.92 },
      { key: ' ', action: 'keyevent', code: 4 },  // BACK
    ],
  },
};

/**
 * Normaliza el nombre de tecla de Electron al formato usado en la tabla de mapeo.
 * Los valores de Electron KeyboardEvent.key son p. ej. 'w', 'W', 'ArrowUp', ' ', 'Enter', etc.
 */
function normalizeKey(key) {
  if (!key) return '';
  // Las letras sueltas siempre en minúsculas
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  return key;
}

/**
 * Busca la acción de una tecla en la tabla de mapeo actual.
 * @param {Array} mappings Array de entradas de mapeo
 * @param {string} key Electron KeyboardEvent.key
 * @returns {object|null} Entrada de mapeo coincidente
 */
function lookup(mappings, key) {
  const nk = normalizeKey(key);
  if (!nk || !Array.isArray(mappings)) return null;
  return mappings.find((m) => normalizeKey(m.key) === nk) || null;
}

/**
 * Convierte una entrada de mapeo + el tamaño del LCD en un comando adb shell.
 * @param {object} mapping Entrada de mapeo
 * @param {number} width Ancho del LCD (píxeles)
 * @param {number} height Alto del LCD (píxeles)
 * @returns {string} Comando adb shell (p. ej. 'input tap 192 612')
 */
function toCommand(mapping, width, height) {
  if (!mapping) return '';
  if (mapping.action === 'tap') {
    const x = Math.round(mapping.x * width);
    const y = Math.round(mapping.y * height);
    return `input tap ${x} ${y}`;
  }
  if (mapping.action === 'swipe') {
    const x1 = Math.round(mapping.x1 * width);
    const y1 = Math.round(mapping.y1 * height);
    const x2 = Math.round(mapping.x2 * width);
    const y2 = Math.round(mapping.y2 * height);
    const dur = mapping.duration || 100;
    return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
  }
  if (mapping.action === 'keyevent') {
    return `input keyevent ${mapping.code}`;
  }
  return '';
}

module.exports = { PRESETS, normalizeKey, lookup, toCommand };
