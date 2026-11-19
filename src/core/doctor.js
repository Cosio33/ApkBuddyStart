'use strict';
/**
 * Adaptación del dispositivo / diagnóstico automático (base de cero configuración).
 *
 * Objetivo: que en cualquier máquina el usuario no tenga que ajustar ningún parámetro.
 *  - chooseProfile()  deduce los parámetros de arranque según memoria física, CPU, disco, estado de aceleración y versión de emulator;
 *  - planVariants()   da un plan de reintentos «degradar en orden tras un fallo de arranque» (GPU → aceleración → memoria → arranque en frío);
 *  - diagnose()       traduce el stderr en inglés de emulator en sugerencias de reparación accionables;
 *  - shortPath()      gestiona rutas de instalación con chino/espacios (el QEMU de emulator es extremadamente sensible a rutas no ASCII).
 *
 * Este módulo son funciones puras + sondeo de solo lectura; no escribe ajustes ni arranca Android, para facilitar las pruebas unitarias.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Perfil de esta máquina (a escala de ms, solo lectura) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Espacio libre en la unidad donde está el directorio (MB); devuelve 0 si no se puede obtener */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Detectar el fabricante de la GPU (NVIDIA / AMD / Intel), para ajustar la prioridad del backend de renderizado.
 * Solo se consulta WMI en Windows; en otras plataformas devuelve 'unknown'.
 * El resultado se cachea 10 minutos para no lanzar wmic en cada chooseProfile.
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic se eliminó en Win11 24H2+; se usa PowerShell Get-CimInstance
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // Se recurre a wmic (todavía funciona en sistemas antiguos)
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // Se prefiere la GPU dedicada (NVIDIA/AMD); los adaptadores de pantalla virtuales van después
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
 * Desde emulator 36.4.9, swiftshader_indirect está marcado como obsoleto y se añade -gpu software.
 * En 37.x, usar swiftshader_indirect provoca fallo de inicialización GL / salida directa (varía mucho según el dispositivo).
 * Por eso hay que elegir candidatos según la versión, y cada candidato tiene una vía de retroceso.
 *
 * Ajuste de prioridad según el fabricante de GPU:
 *   NVIDIA: host casi siempre es lo mejor (controladores maduros), swangle como respaldo
 *   AMD: host se cae con algunos controladores (especialmente antiguos); swangle sube al segundo lugar
 *   Intel: host suele estar bien, pero con iGPU débil swangle es más estable
 *   unknown: se mantiene el orden por defecto
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // Con algunos controladores de AMD, el modo host falla al inicializar GL; se adelanta swangle
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Ruta corta 8.3 de Windows: con usuario / directorio de instalación en chino, emulator no encuentra los archivos */
/**
 * Especificaciones de pantalla. Con landscape=true se da un panel horizontal real (1280x720).
 *
 * Por qué hay que cambiar el tamaño del panel y no el wm size en tiempo de ejecución: la LCD del emulador es un «panel físico»,
 * y Qt abre la ventana según el tamaño del panel y pega la imagen en la esquina superior izquierda. Cambiar wm size en tiempo de ejecución
 * solo modifica la resolución lógica de Android; el panel físico sigue vertical — el resultado es imagen tumbada 90°, una franja en la esquina
 * superior izquierda, grandes bordes negros alrededor y coordenadas de clic desplazadas. Solo cambiando de verdad hw.lcd.width/height
 * a horizontal y reiniciando se consigue una orientación horizontal «derecha y a pantalla completa».
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* Con 8.3 desactivado, se mantiene la ruta original */ }
  return p;
}

/**
 * Deducir los parámetros de arranque de cero configuración.
 * Si el usuario ha indicado explícitamente engine.memoryMB / cores / gpuMode en los ajustes, se toman como límite / sobrescritura,
 * pero no se vuelve a usar un hardcode de 4G/4 núcleos por «no estar configurado» que haga colapsar una máquina con poca memoria.
 */
/**
 * Cuota del «contenedor ligero»: solo limita el parámetro que más afecta a la fluidez del equipo anfitrión: el número de vCPU.
 *
 * La lógica antigua daba 4 núcleos a una máquina de 16; los 4 hilos vCPU de qemu ocupaban los núcleos físicos de forma sostenida,
 * y el escritorio de Windows, el ratón y el navegador tenían que pelear por los ciclos restantes: el síntoma era «se abre y va lento».
 * Para ejecutar una app de Android, 2 vCPU ya son más que suficientes; dar más solo ralentiza el equipo.
 *
 * La memoria y la resolución se dejan intactas a propósito: el límite de memoria ya es 2~3 G, y bajar la resolución cambiaría la huella
 * de la instantánea quickboot y obligaría a un rearranque en frío cada vez que se cambia de modo, lo que sale más caro.
 *
 * Función pura: con settings=null devuelve null (mantiene el comportamiento de antiguos llamadores / pruebas).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // La lógica antigua era floor(núcleos/4) y luego acotar a 2~3: en una máquina de 8 núcleos solo daba 2 vCPU y la decodificación por software
    // de vídeo (de apps tipo Hongguo / Douyin) se convertía en una presentación de diapositivas. Se cambia a «mitad de los núcleos físicos, tope 4»:
    // 8 núcleos → 4, 4 núcleos → 2, el escritorio conserva núcleos libres y el vídeo va bien.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3 GB basta para Android 14 y las apps principales; más alto solo amplía el consumo de memoria y el tamaño de la instantánea quickboot
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // Modo «ahorrar recursos»: cargas ligeras como ver vídeos / leer novelas no necesitan 3 G; el tope baja a 2 G.
  // El efecto directo es unos 1 GB menos de memoria residente de qemu y una instantánea quickboot 1 GB menor (beneficio para el disco).
  // Solo se acota si el usuario no ha especificado la memoria a mano; el valor manual siempre gana.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Se reduce si la memoria física libre no basta; el mínimo de Android 14 es 2 G, por debajo solo queda correr lento con TCG
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // El límite va con el host: antes se fijaba en 8192, así que incluso en una máquina de 32 GB se podían asignar como máximo 8 GB,
    // y los juegos grandes (especialmente con paquetes de recursos HD) recargaban texturas constantemente al entrar en escena: tirones / pantalla negra.
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // Igualmente va con el host: se deja al menos 1 núcleo para Windows; en máquinas de un solo núcleo se sigue dando 1
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // Solo el modo ligero acota los núcleos si el usuario no los especificó a mano; el valor manual siempre gana
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data: el cuerpo de las apps, los paquetes de recursos de juegos y sus «parches» ocupan aquí; 4 GB se llena con facilidad
  // (el síntoma es que la actualización dentro de la app avisa de «espacio en disco insuficiente»). Por defecto se dan 6/8 GB según el disco libre,
  // y el usuario también puede especificarlo en Ajustes (al aumentarlo se amplía in situ en el próximo arranque, sin perder datos).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // El valor automático también va con el disco libre: un juego de 50 GB ocupa casi 90 GB descomprimido, así que en máquinas con mucho margen se dan 16 GB o más,
  // para no empezar a avisar de «espacio insuficiente» nada más instalar el primer juego grande.
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // Con un valor del usuario, se limita al «80 % de la unidad donde está»: poner 128 GB cuando el disco solo tiene 20 GB solo hará que falle a mitad de instalación
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Resolución de renderizado: con auto se elige según el estado de aceleración (simulación por software baja a 540x960 para mantener fluidez)
  // Se prioriza la horizontal: la horizontal la decide el «tamaño del panel físico» y hay que escribirla en el AVD y reiniciar para que surta efecto,
  // así que primero se fija la dirección según settings.display.landscape y luego se aplica renderSize encima.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // Si la resolución explícita del usuario no concuerda con la dirección actual, se corrige según esta (en horizontal se toma el lado largo como ancho)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // La simulación pura por software sin aceleración sí arranca en Windows, pero el arranque en frío de Android 14 puede tardar 5-10 minutos
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Convertir los ajustes del usuario en «parámetros avanzados» en overrides.
 * 0 / auto / sin configurar se tratan siempre como «sin sobrescritura» y se sigue con la deducción automática;
 * solo surte efecto si el usuario desactiva explícitamente la memoria automática y rellena un valor concreto.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Punto de entrada unificado para mostrar / diagnosticar: permite calcular los mismos parámetros que un arranque real sin iniciar Android.
 * Antes, la página de ajustes llamaba directamente a chooseProfile() (sin versión ni estado de aceleración) y en máquinas 37.x
 * mostraba por error el obsoleto swiftshader_indirect / la simulación por software, sin concordar con los parámetros reales de ejecución.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // Se puede inyectar host: las pruebas / el diagnóstico quieren reproducir «una máquina pequeña de 4 núcleos» sin cambiar de equipo.
    // Si no se pasa, se calcula según la máquina real (es la ruta normal en funcionamiento).
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Matriz de reintentos por fallo: de «óptimo» a «más conservador», como máximo 4 veces.
 * Se cambia el backend GPU → se desactiva la aceleración por hardware y se pasa a TCG → se baja la memoria y se fuerza un arranque en frío que limpia la instantánea.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'Aceleración por hardware' : 'Emulación por software'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Emulación por software con la aceleración desactivada (lenta, pero la más compatible)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Arranque en frío conservador (memoria mínima + borrar instantánea)',
    // Aquí **nunca** se puede hacer wipe: antes se ponía wipe:true, y como con el disco lleno cada intento fallaba,
    // los reintentos consecutivos «limpiaban la instantánea + los datos» junto con las apps instaladas y las partidas guardadas del usuario —
    // de ahí salía eso de «se llenó el disco y al abrir ApkBuddyStart no quedaba ninguna app».
    // Cuando hay que reconstruir userdata lo decide ensureDataPartition por su cuenta (solo lo reconstruye si la imagen está dañada),
    // sin depender de -wipe-data en los parámetros de arranque.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Se deduplica (no se repiten combinaciones gpu/accel/wipe iguales), pero la «última opción» debe conservarse:
  // es la única que «no carga la instantánea» y en máquinas con poca memoria puede tener parámetros idénticos a la anterior.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Detectar un par de puertos libres (el puerto de consola de emulator y el de registro de adb deben ser par/impar consecutivos) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * Puerto del servidor adb: fijo, sin volver a detectarlo.
 * Antes se «buscaba un puerto libre a partir del 5044», pero el servidor adb es un proceso residente que ocupa ese puerto,
 * así que cada vez que se iniciaba ApkBuddyStart aparecía un servidor adb más (en una sesión se llegaron a contar 6),
 * y además el puerto cambiaba siempre, por lo que al arrancar para adoptar el emulador anterior no se encontraba.
 * El 5044 es el puerto exclusivo de ApkBuddyStart (el adb propio del usuario está en el 5037): se usa fijamente.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * Huella de configuración: solo invalidan la instantánea los cambios de «imagen / partición de datos / versión del motor».
 * Se excluyen a propósito GPU, modo de aceleración y memoria: son parámetros que los reintentos automáticos cambian con frecuencia,
 * e incluirlos haría que cada reintento disparara -wipe-data y vaciara las apps instaladas del usuario.
 */
/**
 * «Huella de configuración» de la instantánea quickboot: solo estos cambios invalidan la instantánea antigua (pantalla negra al cargar / no arranca).
 *
 * Se excluye **dataMB** a propósito: tras ampliar la partición de datos, la instantánea antigua sigue sirviendo (qemu la vuelve a montar
 * con el nuevo tamaño de partición); meterla en la huella daría como resultado «el usuario solo quería ampliar y se quedó sin instantánea +
 * arranque en frío + datos borrados» — tropezado una vez en la práctica, con el coste de perder todas las apps del equipo.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * «Identidad» de la imagen de sistema: solo se conserva la parte posterior a `system-images/...`.
 *
 * Da igual en qué unidad esté la imagen: copiar la misma imagen a otro directorio no debe contarse como «imagen cambiada» —
 * si no, cuando el usuario mueve el runtime de C: a D: (cosa que nosotros mismos recomendamos en Ajustes),
 * el sysdir del AVD no coincide con la nueva ruta → se decide que la imagen cambió → -wipe-data → se pierden todas las apps.
 * Este problema se da de verdad en la práctica, así que en dos sitios (configuración del AVD y huella de la instantánea) hay que usar
 * la identidad y no la ruta absoluta.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // En Windows, emulator/qemu sale con 0xC0000005 (3221225477 en decimal):
    // en pruebas se da sobre todo cuando «el controlador de gráficos / el backend Vulkan se cae justo cuando el guest va a arrancar»,
    // y no tiene que ver con CPU, memoria ni imagen (en la misma máquina, cambiar a -gpu software suele arreglarlo).
    // Debe ir antes que GPU_INIT: el log de crash normalmente también trae información de inicialización del renderizado, y juzgar primero el crash es más exacto.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Fallo del backend de renderizado (0xC0000005, violación de acceso)',
    hint: 'Se ha reintentado con un backend de renderizado más conservador y se recordará para no probarlo primero la próxima vez.'
      + 'Si se repite, actualiza los controladores gráficos; o baja la calidad en Ajustes → Rendimiento y recursos y desactiva Escritorio remoto / paso directo de GPU en la máquina virtual.',
  },
  {
    code: 'GPU_INIT',
    // Solo se busca en contexto de «fallo»: un log normal también contiene las palabras Vulkan/EGL/ANGLE y no hay que confundirlas con un error fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'Error al inicializar el backend de renderizado de la tarjeta gráfica',
    hint: 'Se ha reintentado con renderizado por software. Si sigue fallando, actualiza los controladores gráficos o desactiva Escritorio remoto / paso directo de GPU en la máquina virtual.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'El entorno actual no acepta este modo GPU',
    hint: 'Se ha elegido automáticamente un modo GPU compatible según la versión del entorno (versiones antiguas usan swiftshader_indirect; las nuevas, software).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Aceleración de hardware no disponible',
    hint: 'Se ha vuelto automáticamente a emulación por software (el primer arranque será notablemente más lento). Para que vaya fluido, marca «Plataforma virtual» en «Funciones de Windows» o instala el controlador AEHD y reinicia.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: 'Error al asignar memoria',
    hint: 'Se han reducido automáticamente la memoria y los núcleos asignados a Android. Cierra los programas que ocupen memoria e inténtalo de nuevo.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Puerto del emulador ocupado',
    hint: 'Se ha cambiado automáticamente a un puerto libre. Si se repite, cierra otros emuladores (Night God / MuMu / BlueStacks) o reinicia el equipo.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'Quedaron archivos de bloqueo de la ejecución anterior',
    hint: 'Se han limpiado automáticamente los archivos de bloqueo del AVD y se ha relanzado.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'Imagen del sistema ausente o dañada / incompatible con datos de usuario antiguos',
    hint: 'Se ha reiniciado con datos de usuario limpios. Si sigue fallando, elimina la imagen en «Entorno» y vuelve a descargarla.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'Los componentes del entorno de ejecución fueron eliminados por el antivirus o falta la biblioteca VC++',
    hint: 'Añade la carpeta de ApkBuddyStart a la lista blanca del antivirus, vuelve a extraer el instalador e instala el runtime de Microsoft VC++ 2015-2022.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
    title: 'Espacio insuficiente en disco; no se puede iniciar Android',
    hint: 'Cambia el directorio de datos del entorno (Ajustes → Integración del sistema → Directorio de datos del entorno) a una unidad con espacio,\n            '
      + 'o desactiva «Conservar instantánea de arranque rápido» / reduce la partición de datos en los ajustes. Los datos de Android no se borran automáticamente.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: 'La ruta de instalación contiene caracteres chinos o especiales',
    hint: 'Se cambió automáticamente a una ruta corta de Windows. Si sigue fallando, mueve ApkBuddyStart a una carpeta solo en inglés (p. ej., C:\\ApkBuddyStart).',
  },
  {
    // Tras una finalización forzada, el directorio del AVD deja hardware-qemu.ini.lock / multiinstance.lock,
    // y el emulador se niega a arrancar, pero el mensaje que da se lee fácilmente como un problema de CPU. Debe ir antes de la regla de CPU.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'La ejecución anterior no terminó correctamente y dejó archivos de bloqueo',
    hint: 'ApkBuddyStart limpiará los bloqueos residuales y lo reintentará; si se repite, comprueba que otra máquina virtual no esté usando el mismo entorno.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'La CPU no dispone del conjunto de instrucciones requerido',
    hint: 'En algunas CPU antiguas estos avisos son solo advertencias y el equipo sigue arrancando; si de verdad no inicia, actualiza el motor en «Entorno» a una versión compatible más antigua, o usa otro equipo con VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Instantánea de arranque rápido dañada',
    hint: 'Se ha descartado la instantánea antigua y se ha arrancado en frío; la próxima salida normal generará una nueva instantánea.',
  },
];

/** Traducir el log a {code,title,hint}, para que la interfaz lo muestre y decidir los reintentos automáticos */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'El entorno no terminó de arrancar',
    hint: 'Se ha reintentado automáticamente con varias combinaciones de parámetros. Pulsa «Exportar informe de diagnóstico» para enviar los registros al autor.',
  };
}

/** Resumen legible de una línea, mostrado en la página de ajustes para que el usuario avanzado sepa qué se eligió automáticamente */
function describeProfile(p) {
  return `Automático:${(p.memoryMB / 1024).toFixed(1)}GB de memoria · ${p.cores} núcleos · ${p.gpu} renderizado · `
    + `${p.accelOk ? 'Aceleración por hardware' : 'Emulación por software'} · ${p.snapshot ? 'Instantánea bajo demanda' : 'Inicio en frío'}`
    + `${p.lite ? ' · contenedor ligero' : ''} · puerto ${p.port}`;
}

/** Exportar un informe de diagnóstico (texto plano, fácil de enviar por correo / pegar en un issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'Informe de diagnóstico de ApkBuddyStart',
    `Fecha de generación:${new Date().toLocaleString()}`,
    '',
    '== Este equipo ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Configuración automática ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnóstico ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== Información adicional ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Registro del entorno (últimas 300 líneas) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Detectar si está instalado el runtime de Microsoft VC++ 2015-2022 x64.
 * Tanto el emulador de Android (Qt6) como qemu dependen de él; si falta, en «otros equipos» directamente no arranca
 * (da 0xc0000135 / falta MSVCP140). En la versión instaladora ya incluimos vc_redist.x64.exe;
 * aquí solo se detecta, para dar un aviso claro antes del arranque y un botón de instalación.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Primero se miran las DLL: msvcp140 / vcruntime140 son justo los dos archivos de los que dependen realmente Qt6 y qemu.
  // Detectar por archivo evita lanzar reg.exe (que algunos antivirus bloquean y que además ralentiza la autocomprobación cada 60 s)
  // y evita también falsos «no instalado» porque una herramienta de limpieza borró la entrada del registro.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* Se recurre al registro como respaldo */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* Si la clave no existe = no está instalado */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
