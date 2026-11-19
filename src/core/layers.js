'use strict';
/**
 * Capas de tipo contenedor: imagen base de solo lectura + runtime reducido + capas temporales reciclables
 *
 * Analogía (como Docker):
 *   system-images/  = capa base de solo lectura, la comparten todas las aplicaciones y sesiones, nunca se copia
 *   avd/*.avd/      = capa delgada escribible (delta qcow2 + instantánea quickboot), solo guarda los cambios
 *   _tmp/ snapshots = capa temporal (scratch) reciclable
 *
 * Este módulo solo hace «inventario» y «reciclaje según una lista explícita»; por defecto es dryRun
 * y no toca los archivos personales del usuario.
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Inventaría el uso del runtime y enumera las entradas «que se pueden reciclar con seguridad».
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('Motor del emulador', path.join(root, 'emulator'));
  groupOf('Imagen del sistema (capa base de solo lectura)', path.join(root, 'system-images'));
  groupOf('Capa de escritura AVD / instantánea', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU solo necesita un objetivo: x86_64; los binarios de las otras 7 arquitecturas del paquete son un desperdicio
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'Objetivo QEMU no x86_64; el entorno no lo usa');
      }
    }
  }

  // 2) Textos de licencia / directorios redundantes dentro del paquete de imágenes
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'Archivos de documentación de gran tamaño dentro del paquete de imagen');
    }
  }

  // 3) Conservar una sola imagen del sistema: cuando la imagen Play de API 34 está lista, la antigua API 30 queda obsoleta
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'Imagen API 30 antigua (con una capa de traducción ARM obsoleta)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'Directorio de imagen duplicado por una extracción incorrecta', 'dir');

  // 4) AVD inactivos: el producto solo usa apkstart; los restos de pruebas como apkstart-arm / -houdini se pueden limpiar
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'AVD inactivo (con imágenes de datos de usuario antiguas de 8-16 GB)', 'dir');
    }
    // 5) Archivos de bloqueo: los restos provocan «AVD is already running»
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'Archivo de bloqueo residual del cierre anormal anterior');
    }
    // 6) Instantáneas de arranque rápido: ram.img ≈ la memoria asignada a la máquina virtual; si se dañan o cambia la configuración, hay que descartarlas
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Tanto las instantáneas normales como las antiguas renombradas tras un fallo de borrado son reciclables
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'Instantánea quickboot antigua (se reconstruirá automáticamente tras cambiar la configuración)', 'dir');
      }
    }
  }

  // 7) Caché de descargas / ISO residuales de QEMU
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'Archivos temporales de descarga' : 'Archivos QEMU/ISO obsoletos', 'dir');
    }
  }

  // 8) Recorte agresivo: solo se activa al construir el paquete de distribución.
  // Nota: Qt6WebEngineCoreAndroidEmu.dll es una dependencia de carga de qemu-system-x86_64.exe;
  // en pruebas, borrarla impide arrancar, así que nunca debe incluirse en la lista; qsn/netsim
  // también pueden ser invocados bajo demanda por las instantáneas y las funciones de red, se conservan por prudencia.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'Herramienta de informes de fallos (no necesaria en modo headless)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Reciclaje. Hay que pasar explícitamente apply:true; quien llama (UI/script de construcción) debe
 * mostrar antes la lista y obtener confirmación. Restricción de seguridad: todo objetivo debe estar
 * dentro de root y no se permite borrar el propio root.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* Los archivos en uso se omiten y se limpian la próxima vez */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Breve resumen para la página de ajustes */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Aparte del directorio del runtime, lo que más interesa al usuario es «cuánto disco ocupa todo esto»:
  // se incluyen el AVD (datos de aplicaciones + instantánea), la caché de APK, los iconos y los registros.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'Datos de Android (aplicaciones + instantánea)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'Caché de paquetes APK', path: store.APK_DIR },
    { key: 'icons', label: 'Caché de iconos del escritorio', path: store.ICON_DIR },
    { key: 'logs', label: 'Registro', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'Entorno (motor + imagen del sistema)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
