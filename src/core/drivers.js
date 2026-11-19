'use strict';
/**
 * Módulo de extensión de controladores (parches de compatibilidad).
 *
 * Contexto: ApkBuddyStart usa el emulator oficial y una imagen fija, pero «si llega a arrancar» depende mucho de la máquina:
 * las GPU antiguas solo tienen GLES 3.1, sin WHPX solo queda TCG, ciertas iGPU con controladores viejos se caen en cuanto se activa el renderizado host…
 * Estas diferencias no se pueden cubrir con un único juego de parámetros por defecto, y el ritmo de lanzamiento no sigue el ritmo de los modelos de los usuarios.
 *
 * Por eso se ha hecho como extensión **orientada a datos**: un controlador es un JSON que declara «a qué máquinas coincido»
 * y «qué parámetros de arranque cambio cuando coincido». El usuario puede escribirlo, importarlo y compartirlo, sin tocar código.
 *
 * Tres restricciones duras de diseño:
 *   1. **Solo se acepta JSON, no se ejecuta ningún código**. No hay require / eval / hooks de script: el archivo
 *      se puede descargar de internet y pasar de unos a otros, y en ningún caso debe permitir ejecutar código arbitrario en la máquina.
 *   2. **Lista blanca**. Solo se pueden cambiar los parámetros de arranque enumerados explícitamente: `-gpu=…`, `-accel=…`,
 *      algunas claves de config.ini y algunas variables de entorno. Claves como `-wipe-data`, `-datadir`, `-sysdir` o
 *      `disk.dataPartition.size`, que destruyen datos o cambian la ubicación, se rechazan siempre.
 *   3. **Previsibilidad**. Si no coincide, no se aplica; si coinciden varios, se combinan por `priority` de menor a mayor,
 *      y los aplicados después sobrescriben a los anteriores; en cada arranque se escribe en el log y en Ajustes qué controladores se usaron.
 *
 * El formato del archivo está en docs/drivers.md; los ejemplos integrados están en src/drivers/.
 */

const fs = require('fs');
const path = require('path');

const DRIVER_FORMAT = 'apkstart-driver/1';
const MAX_DRIVER_BYTES = 256 * 1024;
const MAX_DRIVERS = 200;

/** Parámetros de arranque que el controlador puede cambiar: formato `-flag=value`, el valor debe coincidir con la regex de la lista blanca */
const ARG_RULES = {
  '-gpu': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  '-accel': /^(auto|off|on|whpx|hax|haxm|aehd|tcg)$/,
  '-feature': /^[A-Za-z0-9_,.\-]{1,160}$/,
  '-gltransport': /^(pipe|asgpu|virtio)$/,
  // Un único parámetro que se pasa directamente a qemu. Se restringe el juego de caracteres y se prohíben parámetros de montaje/escritura como -drive/-virtfs
  '-qemu': /^-?[A-Za-z0-9_+=,.:/\-]{1,120}$/,
};

/** Solo se permiten parámetros de «interruptor» (sin valor) */
const FLAG_ONLY = new Set([
  '-no-audio',
  '-no-boot-anim',
  '-no-metrics',
  '-no-snapshot',
  '-no-snapshot-load',
  '-no-snapshot-save',
]);

/**
 * Parámetros rechazados explícitamente: borran datos, cambian la ubicación o eluden nuestra gestión de puertos/AVD.
 * Se enumeran aparte para poder explicar en el error «por qué no se puede», en lugar de decir solo «no está en la lista blanca».
 */
const FORBIDDEN_ARGS = {
  '-wipe-data': 'Borrará las aplicaciones y datos del usuario',
  '-datadir': 'Cambia la ubicación del AVD y rompe el aislamiento de múltiples instancias',
  '-sysdir': 'Cambia la fuente de la imagen del sistema',
  '-partition-size': 'Cambia el tamaño de la partición de datos; usa la página de ajustes',
  '-avd': 'El nombre del AVD lo gestiona ApkBuddyStart',
  '-port': 'ApkBuddyStart asigna el puerto dinámicamente',
  '-http-proxy': 'El proxy se configura en los ajustes del sistema',
};

/** Claves de config.ini que el controlador puede cambiar */
const INI_RULES = {
  'hw.gpu.mode': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  'hw.gpu.enabled': /^(yes|no)$/,
  'hw.gltransport': /^(pipe|asgpu|virtio)$/,
  'hw.keyboard': /^(yes|no)$/,
  'hw.audioInput': /^(yes|no|none)$/,
  'hw.audioOutput': /^(yes|no)$/,
  'hw.camera.back': /^(none|emulated|webcam0)$/,
  'hw.camera.front': /^(none|emulated|webcam0)$/,
  'hw.gps': /^(yes|no)$/,
  'vm.heapSize': /^\d{2,4}$/,
  'hw.lcd.density': /^\d{3,4}$/,
};

/** Nombres de variables de entorno que el controlador puede cambiar */
const ENV_NAME_RULES = [
  /^ANDROID_[A-Z0-9_]{2,40}$/,
  /^QEMU_[A-Z0-9_]{2,40}$/,
  /^LIBGL_[A-Z0-9_]{2,40}$/,
  /^MESA_[A-Z0-9_]{2,40}$/,
  /^EMUGL_[A-Z0-9_]{2,40}$/,
];

/** Claves permitidas en match (una más ya cuenta como error, para evitar que el usuario crea que lo escribió y no surtió efecto) */
const MATCH_KEYS = new Set([
  'any', 'platform', 'arch', 'gpuVendor', 'gpuName', 'cpuVendor',
  'osBuild', 'totalMB', 'cores', 'accel', 'emulatorVersion',
]);

const EFFECT_KEYS = new Set([
  'gpuMode', 'forceTcg', 'emulatorArgs', 'configIni', 'env', 'notes',
]);

// ---------------- Utilidades ----------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

/** Compilar la regex escrita por el usuario: longitud y sintaxis deben estar acotadas; si falla, devuelve null (la validación avisará) */
function safeRegex(pattern) {
  const s = String(pattern || '');
  if (!s || s.length > 200) return null;
  try {
    return new RegExp(s, 'i');
  } catch (_) {
    return null;
  }
}

/** La versión solo se compara por los cuatro primeros segmentos numéricos; '36.4.9' frente a '36.4.10' no se puede comparar como cadena */
function versionParts(v) {
  return String(v || '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
}

function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function inRange(value, range) {
  if (range === undefined || range === null) return true;
  const { min, max } = isObj(range) ? range : { min: range };
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (min !== undefined && n < Number(min)) return false;
  if (max !== undefined && n > Number(max)) return false;
  return true;
}

// ---------------- Validación ----------------

function validateMatch(match, errors) {
  if (match === undefined) return {};
  if (!isObj(match)) {
    errors.push('match debe ser un objeto');
    return {};
  }
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.has(k)) errors.push(`match.${k} no es una condición de coincidencia compatible`);
  }
  const out = {};
  if (match.any !== undefined) out.any = !!match.any;
  if (match.platform !== undefined) out.platform = asArray(match.platform).map(String);
  if (match.arch !== undefined) out.arch = asArray(match.arch).map(String);
  if (match.gpuVendor !== undefined) out.gpuVendor = asArray(match.gpuVendor).map((v) => String(v).toLowerCase());
  if (match.cpuVendor !== undefined) out.cpuVendor = asArray(match.cpuVendor).map((v) => String(v).toLowerCase());
  if (match.accel !== undefined) out.accel = asArray(match.accel).map((v) => String(v).toLowerCase());
  if (match.gpuName !== undefined) {
    if (!safeRegex(match.gpuName)) errors.push('match.gpuName no es una expresión regular válida (y su longitud debe ser ≤200)');
    else out.gpuName = String(match.gpuName);
  }
  for (const k of ['osBuild', 'totalMB', 'cores', 'emulatorVersion']) {
    if (match[k] === undefined) continue;
    if (!isObj(match[k]) && typeof match[k] !== 'number' && typeof match[k] !== 'string') {
      errors.push(`match.${k} debe ser un número o {min,max}`);
      continue;
    }
    if (isObj(match[k])) {
      const bad = ['min', 'max'].filter((x) => match[k][x] !== undefined && !Number.isFinite(Number(match[k][x])));
      if (bad.length) {
        errors.push(`match.${k}.${bad.join('/')} debe ser un número`);
        continue;
      }
      out[k] = { min: match[k].min, max: match[k].max };
    } else {
      out[k] = { min: match[k] };
    }
  }
  return out;
}

function validateArgs(args, errors) {
  const out = [];
  if (args === undefined) return out;
  if (!Array.isArray(args)) {
    errors.push('effect.emulatorArgs debe ser un array de cadenas');
    return out;
  }
  for (const raw of args) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const flag = eq > 0 ? s.slice(0, eq) : s;
    const value = eq > 0 ? s.slice(eq + 1) : '';
    if (FORBIDDEN_ARGS[flag]) {
      errors.push(`emulatorArgs no permite ${flag}：${FORBIDDEN_ARGS[flag]}`);
      continue;
    }
    if (eq < 0) {
      if (!FLAG_ONLY.has(flag)) errors.push(`emulatorArgs no admite el parámetro individual ${flag}(Los que llevan valor, escríbalos como ${flag}=valor)`);
      else out.push({ flag, value: '' });
      continue;
    }
    const rule = ARG_RULES[flag];
    if (!rule) {
      errors.push(`emulatorArgs no admite ${flag}`);
      continue;
    }
    if (!rule.test(value)) {
      errors.push(`de emulatorArgs ${flag} valor no válido:${value}`);
      continue;
    }
    out.push({ flag, value });
  }
  return out;
}

function validateIni(ini, errors) {
  const out = {};
  if (ini === undefined) return out;
  if (!isObj(ini)) {
    errors.push('effect.configIni debe ser un objeto');
    return out;
  }
  for (const [k, v] of Object.entries(ini)) {
    const rule = INI_RULES[k];
    if (!rule) {
      errors.push(`configIni no admite ${k}(Las claves que puedan dañar la partición de datos / los puntos de montaje se rechazan siempre)`);
      continue;
    }
    const s = String(v);
    if (!rule.test(s)) {
      errors.push(`configIni: ${k} valor no válido:${s}`);
      continue;
    }
    out[k] = s;
  }
  return out;
}

function validateEnv(env, errors) {
  const out = {};
  if (env === undefined) return out;
  if (!isObj(env)) {
    errors.push('effect.env debe ser un objeto');
    return out;
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RULES.some((re) => re.test(k))) {
      errors.push(`env no permite establecer ${k}(Solo se permiten los prefijos ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_)`);
      continue;
    }
    const s = String(v);
    if (s.length > 200 || /[\r\n\0]/.test(s)) {
      errors.push(`env.${k} no es un valor válido (longitud ≤200 y no puede contener saltos de línea)`);
      continue;
    }
    out[k] = s;
  }
  return out;
}

/**
 * Validar un controlador (el objeto resultante de JSON.parse).
 * Los errors devueltos son para personas: se listan todos de una vez, nada de «arregla uno y sale el siguiente».
 * @param {object} raw
 * @param {object} [opts] { file } para incluir el nombre de archivo si hay error
 * @returns {{ ok:boolean, errors:string[], driver:object|null }}
 */
function validateDriver(raw, { file = '' } = {}) {
  const errors = [];
  const where = file ? `${file}: ` : '';
  if (!isObj(raw)) return { ok: false, errors: [`${where}El controlador debe ser un objeto JSON`], driver: null };

  if (raw.format !== DRIVER_FORMAT) {
    errors.push(`${where}format debe ser "${DRIVER_FORMAT}" (actual ${JSON.stringify(raw.format)}）`);
  }
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) {
    errors.push(`${where}El id debe estar formado por letras, números y . _ -, entre 3 y 64 caracteres (p. ej., amd-igpu-swangle)`);
  }
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) errors.push(`${where}name es obligatorio y no supera los 80 caracteres`);
  const version = String(raw.version || '').trim();
  if (!/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/.test(version)) errors.push(`${where}version debe tener el formato 1.0.0`);
  if (raw.priority !== undefined && (!Number.isFinite(Number(raw.priority)) || Math.abs(Number(raw.priority)) > 100)) {
    errors.push(`${where}priority debe ser un número entre -100 y 100`);
  }

  const match = validateMatch(raw.match, errors);
  if (raw.match !== undefined && isObj(raw.match) && Object.keys(raw.match).length === 0) {
    errors.push(`${where}match no puede ser un objeto vacío; si quieres coincidir con todas las máquinas, escribe {"any": true}`);
  }
  const effectRaw = isObj(raw.effect) ? raw.effect : null;
  if (!effectRaw) errors.push(`${where}effect debe ser un objeto`);
  let effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  if (effectRaw) {
    for (const k of Object.keys(effectRaw)) {
      if (!EFFECT_KEYS.has(k)) errors.push(`${where}effect.${k} no es un campo compatible`);
    }
    if (effectRaw.gpuMode !== undefined) {
      const v = String(effectRaw.gpuMode);
      if (!ARG_RULES['-gpu'].test(v)) errors.push(`${where}effect.gpuMode tiene un valor no válido:${v}`);
      else effect.gpuMode = v;
    }
    if (effectRaw.forceTcg !== undefined) {
      if (typeof effectRaw.forceTcg !== 'boolean') errors.push(`${where}effect.forceTcg debe ser true/false`);
      else effect.forceTcg = effectRaw.forceTcg;
    }
    effect.args = validateArgs(effectRaw.emulatorArgs, errors);
    effect.ini = validateIni(effectRaw.configIni, errors);
    effect.env = validateEnv(effectRaw.env, errors);
    if (effectRaw.notes !== undefined) {
      if (!Array.isArray(effectRaw.notes)) errors.push(`${where}effect.notes debe ser una matriz de cadenas`);
      else {
        effect.notes = effectRaw.notes
          .map((n) => String(n).trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((n) => (n.length > 200 ? `${n.slice(0, 200)}…` : n));
      }
    }
  }

  if (errors.length) return { ok: false, errors, driver: null };
  return {
    ok: true,
    errors: [],
    driver: {
      format: DRIVER_FORMAT,
      id,
      name,
      version,
      author: String(raw.author || '').slice(0, 60),
      description: String(raw.description || '').slice(0, 400),
      homepage: String(raw.homepage || '').slice(0, 200),
      priority: Number(raw.priority || 0),
      // Los ejemplos integrados van todos deshabilitados; los del usuario se habilitan por defecto
      enabled: raw.enabled !== false,
      match,
      effect,
      file,
    },
  };
}

// ---------------- Coincidencia ----------------

/**
 * Ensamblar el «perfil» de esta máquina para pasarlo a match.
 * @param {object} o { info, gpuVendor, gpuName, osBuild, accel, emulatorVersion }
 */
function hostContext({ info = {}, gpuVendor = 'unknown', gpuName = '', osBuild = 0, accel = 'unknown', emulatorVersion = '' } = {}) {
  const rel = String(process.release && process.release.name === 'node' ? '' : '');
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB: toInt(info.totalMB),
    cores: toInt(info.cores) || 1,
    gpuVendor: String(gpuVendor || 'unknown').toLowerCase(),
    gpuName: String(gpuName || ''),
    cpuVendor: String((info.cpuVendor || '')).toLowerCase(),
    osBuild: toInt(osBuild),
    accel: String(accel || 'unknown').toLowerCase(),
    emulatorVersion: String(emulatorVersion || rel || ''),
  };
}

/**
 * El resultado de la coincidencia devuelve también «a qué claves se debió», para que la interfaz explique «por qué este controlador se aplicó».
 * @returns {{ ok:boolean, hits:string[] }}
 */
function matchHost(match, host) {
  if (!isObj(match) || !Object.keys(match).length) return { ok: false, hits: [] };
  const hits = [];
  if (match.any) hits.push('any');
  if (match.platform && !match.platform.includes(host.platform)) return { ok: false, hits: [] };
  if (match.platform) hits.push(`platform=${host.platform}`);
  if (match.arch && !match.arch.includes(host.arch)) return { ok: false, hits: [] };
  if (match.arch) hits.push(`arch=${host.arch}`);
  if (match.gpuVendor && !match.gpuVendor.includes(host.gpuVendor)) return { ok: false, hits: [] };
  if (match.gpuVendor) hits.push(`gpu=${host.gpuVendor}`);
  if (match.gpuName) {
    const re = safeRegex(match.gpuName);
    if (!re || !re.test(host.gpuName || '')) return { ok: false, hits: [] };
    hits.push(`gpuName≈${match.gpuName}`);
  }
  if (match.cpuVendor && !match.cpuVendor.includes(host.cpuVendor)) return { ok: false, hits: [] };
  if (match.cpuVendor) hits.push(`cpu=${host.cpuVendor}`);
  if (match.accel && !match.accel.includes(host.accel)) return { ok: false, hits: [] };
  if (match.accel) hits.push(`accel=${host.accel}`);
  if (match.osBuild !== undefined) {
    const b = host.osBuild;
    if (!b || !inRange(b, match.osBuild)) return { ok: false, hits: [] };
    hits.push(`osBuild=${b}`);
  }
  if (match.totalMB !== undefined) {
    if (!inRange(host.totalMB, match.totalMB)) return { ok: false, hits: [] };
    hits.push(`mem=${host.totalMB}MB`);
  }
  if (match.cores !== undefined) {
    if (!inRange(host.cores, match.cores)) return { ok: false, hits: [] };
    hits.push(`cores=${host.cores}`);
  }
  if (match.emulatorVersion !== undefined) {
    const v = host.emulatorVersion;
    if (!v) return { ok: false, hits: [] };
    if (match.emulatorVersion.min !== undefined && cmpVersion(v, match.emulatorVersion.min) < 0) return { ok: false, hits: [] };
    if (match.emulatorVersion.max !== undefined && cmpVersion(v, match.emulatorVersion.max) > 0) return { ok: false, hits: [] };
    hits.push(`emu=${v}`);
  }
  return { ok: hits.length > 0, hits };
}

/** Cuantas más condiciones de coincidencia, más «específico»: con igual priority, los controladores genéricos se aplican primero y los específicos después (los sobrescriben) */
function specificity(match) {
  return Object.keys(match || {}).filter((k) => k !== 'any').length;
}

/**
 * Combina los controladores coincidentes en un único efecto, en orden «genérico → específico → priority».
 * Los posteriores sobrescriben a los anteriores: gpuMode/forceTcg toman el último, args con el mismo flag toman el último, ini/env se fusionan.
 */
function mergeEffect(drivers) {
  const effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  const argIndex = new Map();
  for (const d of drivers) {
    const e = d.effect;
    if (e.gpuMode) effect.gpuMode = e.gpuMode;
    if (e.forceTcg !== null) effect.forceTcg = e.forceTcg;
    for (const a of e.args) {
      const key = a.flag;
      if (argIndex.has(key)) effect.args[argIndex.get(key)] = a;
      else {
        argIndex.set(key, effect.args.length);
        effect.args.push(a);
      }
    }
    Object.assign(effect.ini, e.ini);
    Object.assign(effect.env, e.env);
    for (const n of e.notes) effect.notes.push(`${d.name}：${n}`);
  }
  return effect;
}

/**
 * Elegir de entre un montón de controladores (ya validados) los que usa esta máquina y componer el efecto final.
 *
 * `state` es el interruptor explícito del usuario en la interfaz (id → true/false) y tiene prioridad sobre
 * el `enabled` del archivo: los ejemplos integrados vienen con `enabled:false` por defecto; si el usuario pulsa «Activar»,
 * se escribe en state y no hace falta ir a la carpeta de instalación a editar el JSON (el directorio de la versión de tienda es de solo lectura).
 *
 * @param {object} o { drivers, host, state, disabled }
 * @returns {{ applied:Array, skipped:Array, effect:object }}
 */
function resolve({ drivers = [], host = {}, state = {}, disabled = [] } = {}) {
  const off = new Set((Array.isArray(disabled) ? disabled : []).map(String));
  const applied = [];
  const skipped = [];
  for (const d of drivers) {
    if (!d || !d.id) continue;
    const forced = state && typeof state[d.id] === 'boolean' ? state[d.id] : null;
    const on = forced !== null ? forced : (d.enabled !== false);
    if (!on || off.has(d.id)) {
      skipped.push({ id: d.id, name: d.name, reason: 'disabled' });
      continue;
    }
    const m = matchHost(d.match, host);
    if (!m.ok) {
      skipped.push({ id: d.id, name: d.name, reason: 'no-match' });
      continue;
    }
    applied.push({ ...d, hits: m.hits, matchCount: specificity(d.match) });
  }
  applied.sort((a, b) => (a.priority - b.priority)
    || (a.matchCount - b.matchCount)
    || String(a.id).localeCompare(String(b.id)));
  return { applied, skipped, effect: mergeEffect(applied) };
}

// ---------------- E/S de archivos ----------------

/** Directorio de controladores del usuario (al mismo nivel que ajustes y logs; sigue al directorio de datos) */
function userDir(store) {
  return path.join(store.DATA_DIR, 'drivers');
}

/** Ejemplos integrados en el paquete (solo lectura; con enabled:false por defecto, sirven de plantilla para copiar) */
function bundledDir(appRoot) {
  return path.join(appRoot || '.', 'src', 'drivers');
}

/**
 * Leer todos los controladores de un directorio. Un archivo malo no bloquea a los demás:
 * los errores se recogen para mostrarlos en la interfaz y los que funcionan se usan con normalidad.
 * @returns {{ drivers:Array, errors:Array<{file:string, errors:string[]}>, dir:string }}
 */
function loadDir(dir) {
  const out = { drivers: [], errors: [], dir };
  if (!dir || !fs.existsSync(dir)) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch (e) {
    out.errors.push({ file: dir, errors: [e.message] });
    return out;
  }
  names.sort();
  for (const n of names.slice(0, MAX_DRIVERS)) {
    const file = path.join(dir, n);
    let raw;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_DRIVER_BYTES) {
        out.errors.push({ file, errors: [`El archivo es demasiado grande (${st.size} bytes, límite ${MAX_DRIVER_BYTES}）`] });
        continue;
      }
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      out.errors.push({ file, errors: [`No se puede leer:${e.message}`] });
      continue;
    }
    const r = validateDriver(raw, { file });
    if (!r.ok) out.errors.push({ file, errors: r.errors });
    else out.drivers.push({ ...r.driver, dir });
  }
  return out;
}

/** Leer varios directorios y deduplicar por id: el directorio del usuario va primero (con el mismo id, sobrescribe al integrado) */
function loadAll(dirs = []) {
  const all = [];
  const errors = [];
  for (const dir of dirs) {
    const r = loadDir(dir);
    errors.push(...r.errors);
    for (const d of r.drivers) {
      const i = all.findIndex((x) => x.id === d.id);
      if (i >= 0) all[i] = d;
      else all.push(d);
    }
  }
  return { drivers: all, errors };
}

/**
 * Importar un controlador: primero se valida y luego se guarda como `<id>.json`.
 * El nombre del archivo lo decide solo el id ya validado; el nombre que dé el usuario no interviene en la concatenación (bloquea path traversal como ../).
 * @returns {{ ok:boolean, file?:string, driver?:object, errors?:string[] }}
 */
function importDriver(srcFile, destDir) {
  let raw;
  try {
    const st = fs.statSync(srcFile);
    if (st.size > MAX_DRIVER_BYTES) return { ok: false, errors: ['El archivo es demasiado grande; el controlador admite un máximo de 256 KB'] };
    raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`No se puede leer:${e.message}`] };
  }
  const r = validateDriver(raw, { file: path.basename(srcFile) });
  if (!r.ok) return { ok: false, errors: r.errors };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${r.driver.id}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return { ok: true, file: dest, driver: r.driver };
  } catch (e) {
    return { ok: false, errors: [`Error al escribir:${e.message}`] };
  }
}

/**
 * Exportar una «plantilla de esta máquina»: se rellena match con el perfil de la máquina actual,
 * y el usuario solo tiene que cambiar effect para crear un controlador «que solo se aplique a mi máquina».
 */
function templateFromHost(host = {}, { name = 'Mi máquina' } = {}) {
  const gpu = host.gpuVendor && host.gpuVendor !== 'unknown' ? host.gpuVendor : 'unknown';
  return {
    format: DRIVER_FORMAT,
    id: `my-${gpu}-${toInt(host.osBuild) || 'custom'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `${name} parche de compatibilidad`,
    version: '1.0.0',
    author: '',
    description: 'Generado por «Exportar plantilla local» de ApkBuddyStart: los criterios match ya están rellenados para este equipo; modifica solo effect.',
    priority: 0,
    match: {
      platform: host.platform || process.platform,
      arch: host.arch || process.arch,
      ...(gpu !== 'unknown' ? { gpuVendor: gpu } : {}),
      ...(host.totalMB ? { totalMB: { min: Math.max(2048, Math.round(host.totalMB * 0.9)) } } : {}),
    },
    effect: {
      gpuMode: 'swangle',
      forceTcg: false,
      emulatorArgs: [],
      configIni: {},
      env: {},
      notes: ['Ejemplo: cambia gpuMode a host / software o activa forceTcg'],
    },
  };
}

/** Traducir gpuMode al valor -gpu de emulator (auto significa no cambiarlo) */
function gpuModeToArg(mode) {
  const v = String(mode || '').trim();
  return v && v !== 'auto' ? v : '';
}

module.exports = {
  DRIVER_FORMAT,
  ARG_RULES,
  FLAG_ONLY,
  FORBIDDEN_ARGS,
  INI_RULES,
  ENV_NAME_RULES,
  MATCH_KEYS,
  EFFECT_KEYS,
  MAX_DRIVER_BYTES,
  safeRegex,
  cmpVersion,
  validateDriver,
  hostContext,
  matchHost,
  specificity,
  mergeEffect,
  resolve,
  userDir,
  bundledDir,
  loadDir,
  loadAll,
  importDriver,
  templateFromHost,
  gpuModeToArg,
};
