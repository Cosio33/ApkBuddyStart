'use strict';
/**
 * Registro de bases
 *
 * **Solo hay una base: el runtime incluido (builtin).**
 *
 * Desde la 0.5.6, ApkBuddyStart ejecuta en cualquier máquina y situación únicamente su propio
 * runtime de Android (adb / emulator / imagen del sistema incluidos); ya no detecta, toma el control
 * ni gestiona ningún emulador de terceros (MuMu / LDPlayer / BlueStacks / WSA / FydeOS),
 * y tampoco ofrece el modo «conectar a un runtime existente».
 *
 * Por qué se eliminó por completo la cadena de bases opcionales en lugar de dejar solo un
 * interruptor para desactivarlas:
 *   - Mientras quede una rama de detección en el código, un usuario con MuMu instalado podría ser
 *     «tomado en cuenta» en cualquier momento, manifestándose como «abres ApkBuddyStart pero se
 *     ejecuta el emulador de otro»; los datos, partidas e imágenes no están donde uno cree;
 *   - Las actualizaciones, cambios de puerto o de configuración de emuladores de terceros dejan
 *     ApkBuddyStart fuera de servicio, y eso no está en nuestras manos arreglarlo;
 *   - El paquete de la tienda / versión portátil solo incluye su propio runtime y, de todos modos,
 *     no se permite agrupar ni depender de ningún emulador de terceros.
 * Por eso aquí se conserva el formato de registro (la interfaz superior no cambia), con contenido
 * fijo en builtin: leer la configuración, leer ajustes residuales o importar un settings.json antiguo
 * ya no cambiará a otra base.
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');

const REGISTRY = [
  BuiltinBackend,
];

/** La única base. Se conserva esta constante para tener un punto claro donde añadir bases en el futuro. */
const ONLY = 'builtin';

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** Lista de descripciones para la interfaz (solo información estática, serializable de forma segura) */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * Crea una instancia de base según la configuración.
 *
 * Nota: **se ignora deliberadamente settings.engine.mode**. Versiones antiguas pueden haber
 * dejado mode=mumu / fydeos / attach, y editar settings.json a mano también podría escribir
 * otros valores; todos deben tratarse como builtin, o de lo contrario «funcionar de forma
 * independiente pase lo que pase» sería solo una frase vacía. El id devuelto siempre es 'builtin'.
 *
 * @param {object} o { appRoot, settings, runtime, store, log, id }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, runtime, store, log, id: forced } = {}) {
  // Aunque se pase explícitamente otro id (ruta de retroceso de código antiguo), siempre se usa builtin
  const id = forced && byId(forced) ? forced : ONLY;
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Elección automática de base. Ahora solo hay una: siempre devuelve builtin y no hace ningún sondeo;
 * el sondeo mismo accedería a directorios / al registro de emuladores de terceros, justamente el
 * comportamiento que se quiere eliminar.
 */
async function autoPick() {
  return { id: ONLY, reason: 'builtin-only' };
}

module.exports = {
  REGISTRY, ONLY, CAPS, byId, describe, create, autoPick, Backend,
};
