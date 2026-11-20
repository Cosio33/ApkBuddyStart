/**
 * Adaptador ESM delgado para el puerto a Rust del registro de bases (`src/core/backends/`).
 *
 * La app es CommonJS (`module.exports = {...}`) y el analizador de rust-anything solo detecta
 * exportaciones ESM. Este archivo NO cambia el comportamiento: delega directamente en el original
 * y expone solo funciones puras/serializables, que son las que se pueden contrastar con Rust.
 *
 * No se incluye `create()`: devuelve una instancia de clase con estado y dependencias de Electron;
 * no es comparable por valor a través del puente.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../src/core/backends/index.js');

/** Devuelve true si el id corresponde a una base registrada. */
export function hasBackend(id) {
  return registry.byId(id) !== null;
}

/** Devuelve el id de la única base, o null cuando no hay ninguna. */
export function backendId(id) {
  const cls = registry.byId(id);
  return cls ? cls.id : null;
}

/** Descripción serializable de todas las bases registradas, en orden. */
export function describeBackends() {
  return registry.describe();
}

/** Resultado de la elección automática de base. */
export async function autoPickBackend() {
  return registry.autoPick();
}

/** Devuelve el id fijo al que se fuerza siempre la creación. */
export function onlyBackend() {
  return registry.ONLY;
}

/** Devuelve, en orden, las claves de capacidad soportadas por una base registrada. */
export function backendCaps(id) {
  const cls = registry.byId(id);
  if (!cls) return null;
  const instance = new cls('', {});
  return Array.from(instance.caps);
}
