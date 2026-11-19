'use strict';
/**
 * Lógica pura de asignación de recursos (memoria / CPU / almacenamiento).
 *
 * ¿Por qué una capa aparte? «Cuánta memoria dar a Android» acaba en la línea de comandos de qemu (-memory / -cores),
 * y solo surte efecto en el próximo arranque; en cambio, «cuánto puede introducir el usuario» y «qué ocurre si se pasa» es una lógica de función pura,
 * extraída sin depender de electron, para que CI pueda hacer require directamente y ejecutar pruebas unitarias.
 *
 * Tres restricciones duras (todas descubiertas a base de pruebas reales):
 *   1. La memoria no debe agotar el host: Windows y las apps en primer plano necesitan al menos un 25 % libre; si no, el equipo empieza a paginar,
 *      y en Android se traduce en pantallas negras prolongadas o animaciones congeladas, que parecen «el emulador se ha roto».
 *   2. El almacenamiento se estima como «paquete de instalación × 1,8 + 2 GB»: un juego online de 50 GB suele ocupar 80~90 GB descomprimido;
 *      validar solo por el tamaño del instalador hará que la instalación falle a mitad de camino.
 *   3. Cualquier valor automático debe poder calcularse: si no se obtienen datos del host, se recurre a un valor conservador por defecto; nunca devolver NaN.
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** Proporción reservada para el host (Windows + aplicaciones en primer plano) */
const HOST_RESERVE_RATIO = 0.25;
/** Por debajo de esta proporción se avisa de que va «justo» */
const TIGHT_RATIO = 0.8;
/** Límite absoluto cuando no hay espacio suficiente (ni el sistema puede arrancar) */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Capacidad del host. Los parámetros se pueden inyectar para facilitar las pruebas; si no se pasan, se lee la máquina local.
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // require('os') dentro de la función: evitar acceder al entorno del host durante la carga del módulo
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * Rango de memoria admisible. Si no se pudo leer la memoria del host, se da un límite superior conservador para evitar que la interfaz muestre 0.
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * Ajustar la memoria introducida por el usuario a un valor válido. 0 = automático, se devuelve tal cual (cada base lo deriva por su cuenta).
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: `Memoria del host ${Math.round(lim.totalMB / 1024)} GB, como máximo se puede dividir en ${Math.round(lim.maxMB / 1024)} GB (hay que dejar un 25 % para Windows)`,
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: `Android requiere al menos ${lim.minMB} MB para poder iniciar` };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? 'Alineado a 512 MB' : '' };
}

/**
 * Ajuste del número de núcleos de CPU. 0 = automático.
 * El límite superior es «núcleos físicos - 1», dejando al menos 1 núcleo para el host; en máquinas de un solo núcleo se asigna 1.
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: `Local ${total} núcleos, máximo ${max} núcleos (deja 1 núcleo para Windows)` };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * ¿Es razonable la asignación de memoria? (para avisos en la interfaz y recordatorios antes de instalar paquetes grandes).
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: `Solo asignar ${alloc} MB, es posible que Android no arranque` };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: `ocupa en el host ${Math.round(ratio * 100)} % de memoria, Windows empezará a paginar y el emulador irá más lento`,
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: `Usado ${Math.round(ratio * 100)}% de la memoria del host; se recomienda cerrar también las pestañas del navegador` };
  }
  return { level: 'ok', ratio, note: '' };
}

/** Espacio real de la partición de datos que ocupa instalar un paquete (incluye descompresión y redundancia del paquete de actualización) */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * Límite superior de la partición de datos. Cuando queda poco disco, no hay que dejar introducir 64 GB para luego fallar a mitad de instalación.
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // La imagen de la partición también ocupa espacio en el host (las imágenes dinámicas crecen casi hasta el tamaño de la partición); se deja un 20 % de margen
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * Ajustar el tamaño de la partición de datos introducido por el usuario (GB). 0 = automático.
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: `el disco donde se encuentra solo queda ${(lim.freeMB / 1024).toFixed(1)} GB, como máximo se puede dividir en ${lim.maxGB} GB`,
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * ¿Hay espacio suficiente para instalar este paquete?
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: 'No se puede leer el espacio libre en disco; se omite la comprobación previa' };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: `Requiere aproximadamente ${(need / 1024).toFixed(1)} GB, actualmente solo quedan ${(free / 1024).toFixed(1)} GB, aún faltan ${(short / 1024).toFixed(1)} GB`,
  };
}

/**
 * ¿Hay espacio en disco suficiente para instalar este paquete? (el punto de fallo más habitual en juegos de 50 GB).
 * Diferencia con storageVerdict: aquí solo se mira «si alcanza», y el texto está pensado para bloquear la instalación antes de empezar.
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `Espacio en disco insuficiente: se necesitan unos ${Math.ceil(need / 1024)} GB, pero en el disco donde se encuentra el entorno de ejecución de ApkBuddyStart solo quedan ${(free / 1024).toFixed(1)} GB。`
      + 'En Ajustes, mueve la carpeta del entorno de ejecución a una partición con más espacio, o libera espacio y vuelve a intentarlo.',
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskVerdict,
  diskLimits,
  clampDataGB,
  storageVerdict,
};
