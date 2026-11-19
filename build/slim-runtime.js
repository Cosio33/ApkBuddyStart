'use strict';
/**
 * Reducción del runtime: borrar del emulador los archivos que "nuestra forma de inicio nunca carga".
 *
 * El criterio son los parámetros de inicio fijos de emulator.js:
 *   - Solo imágenes x86_64 (API30 AOSP)      → qemu-system-aarch64.exe no se usa
 *   - -gpu software (renderizado por software con swiftshader) → los backends vulkan / gles_angle no se usan
 *   - La interfaz solo conserva la barra de título de 38 px → no se usan los idiomas ni los paneles WebEngine de la interfaz del emulador
 *
 * Los relacionados con la red netsimd / netsim / nimble_bridge se conservan siempre:
 * Gestionan el flujo de datos de wifi / Bluetooth; si se borran, la aplicación no puede acceder a internet y son el mínimo indispensable para "que funcione".
 *
 * Uso:
 *   node build/slim-runtime.js build/runtime          # Nivel seguro (por defecto)
 *   node build/slim-runtime.js build/runtime --aggressive   # Borrar además QtWebEngine (-169 MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Nivel seguro: borrar lo que seguro no se carga (~-190 MB).
 * Límites confirmados con pruebas de reversión puntual (importante, no añadir más):
 *   - Qt6WebEngineCoreAndroidEmu.dll es dependencia fuerte de emulator.exe (importación estática); borrarla impide arrancar → conservar
 *   - lib64/gles_angle aporta vk_swiftshader, del que depende el renderizado por software → conservar
 *   - borrar lib64/vulkan solo vuelve al renderizado por software (probado: arranca y renderiza bien), pero tampoco ocupa mucho → borrarlo ahorra 103 MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'Binario QEMU de arm64 (solo se distribuyen imágenes x86_64)'],
  // Atención: no borrar todo el directorio emulator/lib64/vulkan: vulkan-1.dll es el cargador de -gpu host,
  // borrarlo hace fallar el modo host y deja solo renderizado por software (en pruebas con AMD 780M hay que conservarlo). Borrar solo los archivos grandes:
  ['emulator/lib64/vulkan/layers', 'Capas de validación Vulkan (no se usan en renderizado host, -20 MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'Herramienta de validación de shaders (no se usa en tiempo de ejecución, -7 MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'Respaldo Vulkan por software lavapipe (no se usa cuando hay controlador gráfico del sistema, -53 MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'Descripción ICD de lavapipe (-1 KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (hay una copia idéntica en gles_angle, -23 MB)'],
  ['emulator/lib64/qt/translations', 'Paquetes de idioma de la interfaz del emulador (solo queda la barra de título de 38 px)'],
  // Atención: no borrar emulator-check.exe: emulator -accel-check lo usa para detectar AEHD/WHPX,
  // sin él se decide que "no hay aceleración por hardware" y se cae a emulación TCG por software (en pruebas, el arranque pasó de 42 s a más de 10 min).
  ['emulator/qsn.exe', 'Asistente de notificación de instantáneas de QEMU (emulator.exe no lo referencia, confirmado con strings, -34 MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'Mapa de entorno panorámico VR (Hongguo no lo usa, -3,7 MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'Mapa decorativo panorámico VR (-3,5 MB)'],
  ['emulator/resources/Toren1BD.obj', 'Modelo 3D panorámico VR (-3,5 MB)'],
  ['emulator/resources/macroPreviews', 'Imágenes de vista previa de macros (-2,7 MB)'],
  ['emulator/resources/default360.mp4', 'Vídeo panorámico 360° por defecto (-2,4 MB)'],
];

/** El nivel agresivo está vacío por ahora: WebEngine es dependencia fuerte y gles_angle depende del renderizado por software; no se atreven a borrarlos */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* Ignorar */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} no es un directorio de runtime (falta emulator/emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Omitiendo ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Borrando ${rel} (${(n / 1048576).toFixed(0)} MB) — ${why}`);
  }
  log(`${dryRun ? 'Se podrían liberar' : 'Liberados'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Objetivo de reducción: ${root} (nivel ${aggressive ? 'agresivo' : 'seguro'})`);
  slim(root, { aggressive, dryRun });
}
