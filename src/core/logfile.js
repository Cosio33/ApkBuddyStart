'use strict';
/**
 * Escritura de registros ligera + rotación.
 *
 * Antes app.log / emulator.log solo se añadían y crecían sin parar con el uso:
 * el registro del kernel de cada arranque del emulator ocupa decenas de KB; si se enciende y apaga
 * una docena de veces al día y se suma la salida verbose de qemu, en pocos meses son cientos de MB:
 * así es como el disco se va consumiendo sin que nadie se dé cuenta.
 * Aquí se rota por tamaño, conservando solo una copia .1.log; el límite lo controla la opción
 * «Límite de registro» de la configuración.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // Si el nombre de archivo no termina en .log, bak será igual al original: borrar y luego renombrar
    // eliminaría el registro. Se omite explícitamente este caso límite: mejor un registro algo más
    // grande que perderlo.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file Archivo de registro de destino
 * @param {string} line Contenido de una línea (se añade salto de línea automáticamente)
 * @param {number} [limitKB] Si se supera este tamaño, se rota
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Comprobar una vez al arrancar el proceso y luego cada 200 líneas (statSync es barato,
    // pero no hace falta hacerlo en cada línea)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Limpieza al arrancar: rotar primero los registros demasiado grandes (sin mirar el contador) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
