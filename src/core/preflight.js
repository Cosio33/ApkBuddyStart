'use strict';
/**
 * Chequeo del equipo y configuración automática.
 *
 * Por qué hace falta: que ApkBuddyStart funcione tras instalarlo depende de cuatro cosas ajenas al software —
 *   1. Si la virtualización del CPU (VT-x / AMD-V) está activada en la BIOS;
 *   2. Si está activada la «Plataforma de hipervisor / Hyper-V» de Windows (WHPX depende de ella);
 *   3. Hasta dónde llega la tarjeta gráfica (fabricante, VRAM, versión del controlador, si puede usar renderizado por hardware);
 *   4. Si hay suficiente memoria / disco para arrancar una máquina virtual Android de 2~8 GB.
 *
 * Antes todo era «falla el arranque → el usuario lee el log → lo adivina». Ahora se comprueba primero y lo que se puede
 * arreglar automáticamente se arregla (memoria, núcleos, calidad, backend de renderizado); lo que requiere elevación
 * de privilegios se ofrece con un botón (activar función / instalar controlador); y lo que solo se puede hacer en la BIOS
 * se explica con claridad: qué tecla pulsar y qué cambiar.
 *
 * Capas:
 *   - collect()   —— solo sondea (en Windows, una sola llamada a PowerShell para obtener todo), con rutas de respaldo;
 *   - evaluate()  —— función pura: traduce el sondeo en «items del chequeo + configuración recomendada», se puede probar por unidad;
 *   - Las acciones de aplicación están en main.js (guardar ajustes / llamar a las interfaces de elevación ya existentes); este módulo no toca permisos.
 *
 * Nota: **no fingimos poder activar la virtualización de la BIOS por el usuario**. Ese paso solo lo puede hacer una persona;
 * nosotros únicamente lo detectamos y le indicamos el camino.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------- Sondeo ----------------

/**
 * Ejecutar un script corto (powershell.exe de Windows) y obtener JSON; si falla o agota el tiempo, devuelve null.
 *
 * Se usa execFile asíncrono en lugar de execFileSync: arrancar el script y dos consultas CIM tardan 1~2 segundos,
 * y ejecutarlo de forma sincrónica bloquearía el proceso principal (es decir, toda la interfaz) y el usuario pensaría
 * que pulsar «Chequear» ha colgado el programa.
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
  // AdapterRAM se trunca a 4294967295 cuando supera los 4 GB; el valor real está en el registro qwMemorySize (una subclave 000N por adaptador)
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** Comprobar si existe un archivo (para sondear la biblioteca de API de WHPX / el controlador AEHD / el servicio de plataforma de máquinas virtuales) */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // DateTime de PowerShell → `/Date(1700000000000)/` o cadena ISO
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Sondear el hardware y el estado de virtualización del equipo.
 *
 * Si no se puede obtener ningún dato, se devuelve null/0: **un fallo del sondeo nunca debe derribar al llamador**;
 * «no encontrado» significa «desconocido», y el item del chequeo dirá «no se pudo leer», en lugar de inventar una conclusión.
 *
 * @param {object} o { accel } accel lo pasa provisioner.emulatorAccel() para evitar arrancar emulator dos veces
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // Elegir la «GPU principal»: se prefiere la que no sea Microsoft Basic Display / adaptador de pantalla virtual
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  // AdapterRAM es un entero sin signo de 32 bits; por encima de 4 GB da 4095MB, un valor en el que no se puede confiar
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
  /**
   * Ojo con estos dos campos WMI (comprobado en esta máquina):
   * en cuanto Hyper-V / VBS toma el control de VT, `VMMonitorModeExtensions` y
   * `SecondLevelAddressTranslationExtensions` devuelven False, aunque la máquina pueda usar aceleración por hardware.
   * Por eso «False» solo se interpreta como «no compatible» cuando «no hay hipervisor y la aceleración tampoco está disponible»;
   * en cualquier otro caso se trata como «desconocido», para no marcar como incapaz de virtualizar una máquina que sí puede.
   */
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
  // En la BIOS, igual: con un hipervisor en marcha, los campos de firmware también pueden no ser fiables
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

// ---------------- Evaluación (función pura) ----------------

/** Nivel recomendado de hardware: memoria / núcleos / calidad. Reglas conservadoras: mejor dar menos que dar demasiado. */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // La máquina virtual puede consumir como máximo la mitad del host y deja 1 núcleo para Windows; luego se acota otra vez por intervalos absolutos
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
  // Simulación por software + poca VRAM: bajar la resolución a 540p, priorizar framerate (el área de imagen es solo el 56 %)
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

/** Recomendación de backend de renderizado: según fabricante + estado de aceleración + VRAM, da un nivel «prueba este primero» */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: 'No hay aceleración hardware disponible; se usa renderizado por software para que la imagen aparezca' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: 'No se pudo leer el modelo de la tarjeta gráfica; se deja la cadena de degradación automática' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: 'Poca memoria de vídeo (o no se puede leer); swangle es más estable' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'Los controladores NVIDIA son maduros; el paso directo del host suele ser más rápido' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'Con GPU integrada AMD o controladores antiguos, el host puede iniciar y fallar; swangle es más estable' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'El soporte GLES de las GPU integradas Intel es irregular; swangle es más estable' };
  return { gpuMode: 'auto', why: 'No se pudo leer el modelo de la tarjeta gráfica; se deja la cadena de degradación automática' };
}

/**
 * Traducir los resultados del sondeo en un informe de chequeo.
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

  // ---- 1. Virtualización del CPU (BIOS) ----
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: 'Esta CPU no admite virtualización hardware',
      detail: 'Solo se puede emular por software, de 5 a 10 veces más lento. Las aplicaciones ligeras funcionan, pero no se recomienda para juegos pesados.',
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: 'La virtualización de la CPU no está activada en la BIOS',
      detail: 'Reinicia en BIOS/UEFI y pon Intel VT-x (Intel) o SVM Mode (AMD) en Enabled; guarda y vuelve a ejecutar el chequeo.'
        + 'Lenovo / Dell / ASUS suelen estar en Advanced → CPU Configuration; en equipos de marca puede llamarse Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Necesita reiniciar en BIOS; no se puede hacer automáticamente' },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: 'La virtualización de la CPU ya está activada en la BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} núcleos / ${cpu.threads || '?'} hilos` : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: 'No se pudo leer el estado de virtualización de la CPU',
      detail: 'Puede ser una limitación de la placa o de permisos. Si al arrancar indica que no hay aceleración hardware, entra en la BIOS y confirma que VT-x / SVM esté activado.',
      action: { kind: 'manual', id: 'bios', label: 'Confirmación manual' },
    });
  }

  // ---- 2. Lado de Windows: WHPX / Hyper-V ----
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: 'La plataforma de hipervisor de Windows está activada',
      detail: v.hypervisorPresent
        ? 'El hipervisor está en ejecución; WHPX está disponible.'
        : 'Función activada; si la aceleración sigue sin estar disponible, reinicia para que el hipervisor arranque.',
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: 'La «plataforma de hipervisor» no está activada',
      detail: 'Las ediciones de Store no pueden cambiar funciones del sistema. Pulsa Win+R → escribe optionalfeatures → marca «Plataforma de hipervisor de Windows»'
        + '（HypervisorPlatform）y «Plataforma virtual» → Aceptar → Reiniciar.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Abrir la ventana «Funciones de Windows»' },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: 'La «plataforma de hipervisor» no está activada',
      detail: 'Pulsa el botón de abajo para activar automáticamente HypervisorPlatform + VirtualMachinePlatform (requiere confirmación de administrador) y reinicia el equipo al terminar.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Activar en un clic (requiere administrador)' },
    });
  }

  // ---- 3. ¿Funciona realmente ahora la aceleración por hardware? ----
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: `Aceleración de hardware disponible (${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'}）`,
      detail: 'El arranque usará aceleración de hardware; la configuración de abajo se recomienda según la tarjeta gráfica y la memoria de este equipo.',
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: 'No hay aceleración por hardware disponible actualmente',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'Puedes instalar el controlador AEHD (requiere administrador), o activar primero «Plataforma de hipervisor» y reiniciar; si ninguna funciona, solo queda la emulación por software.'
        : 'Primero se usará emulación por software para garantizar el funcionamiento; la velocidad será de 5 a 10 veces menor que con aceleración de hardware.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Instalar el controlador AEHD (requiere administrador)' }
        : null,
    });
  }

  // ---- 4. Tarjeta gráfica ----
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: 'No se puede leer la información de la tarjeta gráfica',
      detail: 'Puede deberse a Escritorio remoto / máquina virtual / un problema del controlador. El backend de renderizado se deja a la cadena de degradación automática.',
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB de VRAM${integrated ? '（GPU integrada, el resto usa memoria compartida）' : ''}`
      : 'Memoria de vídeo desconocida';
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? ` · controlador ${gpu.driverVersion}` : ''}${gpu.driverDate ? `（${gpu.driverDate}）` : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: 'El controlador de la tarjeta gráfica es antiguo',
        detail: `Fecha del controlador ${gpu.driverDate} (aprox. ${Math.floor(old)} hace años). Los controladores antiguos son una causa frecuente de «pantalla negra / pantalla con artefactos al iniciar»; se recomienda actualizarlos desde el sitio web del fabricante.`,
        action: null,
      });
    }
  }

  // ---- 5. Memoria / disco / versión del sistema ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'No se puede leer la memoria física', detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: `Memoria insuficiente (${(total / 1024).toFixed(1)} GB）`,
      detail: 'La máquina virtual de Android puede usar como máximo 2 GB y 2 núcleos; la calidad gráfica baja a 540×960, y se recomienda cerrar las pestañas del navegador antes de abrir la aplicación.',
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: `Memoria física ${(total / 1024).toFixed(0)} GB`,
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: `La versión de Windows es antigua (build ${build}）`,
      detail: 'ApkBuddyStart admite como mínimo Windows 10 2004 (build 19041). En sistemas más antiguos, el emulator podría cerrarse directamente.',
      action: null,
    });
  }

  // ---- Configuración recomendada ----
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      // Sin aceleración → se fija directamente simulación por software, ahorrando dos rondas de espera inútil; si está disponible, se devuelve a auto para que opere la cadena de degradación
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // Generar un controlador para esta máquina: a partir de ahora se usará en cada arranque, sin repetir el chequeo
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'apkstart-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `Configuración automática de este equipo (${gpu.name || vendor}）`,
    version: '1.0.0',
    author: 'Chequeo de ApkBuddyStart',
    description: `Generado por «Revisión del sistema · Configuración automática»:${gpuRec.why}。${v.accelOk ? 'Aceleración de hardware disponible.' : 'Actualmente no hay aceleración de hardware.'}`,
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
    ? `Encontrados ${bad} elementos que deben gestionarse primero (${items.filter((i) => i.level === 'bad').map((i) => i.title).join('、')}）`
    : warn
      ? `Hay ${warn} elementos recomendados para optimizar (${items.filter((i) => i.level === 'warn').map((i) => i.title).join('、')}）`
      : 'Este equipo puede ejecutar aceleración hardware directamente; la configuración ya es óptima';

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
