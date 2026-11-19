'use strict';
/**
 * Compresión del paquete portátil (zip de Windows).
 *
 * ¿Por qué no usar `Compress-Archive` de PowerShell?
 * Usa el deflate incluido en .NET (equivalente a zlib nivel 6); el mismo directorio de 225 MB da
 * 105,213,775 bytes, mientras que el deflate de 7-Zip (`-mx=9`) solo necesita 99,616,541 bytes: una diferencia de 5,6 MB.
 * Y el límite de un solo archivo adjunto en las versiones de Gitee es 100 MB (en pruebas, 104,800,000 bytes se suben correctamente,
 * pero 105,213,775 se divide en part1/part2 y el usuario no puede descomprimir directamente). Esos 5 MB de diferencia
 * hacen que "el usuario nacional reciba un paquete que no se puede descomprimir o que tenga que descargar dos veces".
 *
 * Por eso aquí se comprime siempre con 7-Zip; solo si no se encuentra 7-Zip se usa Compress-Archive como respaldo (con un aviso bien visible).
 *
 * Uso:
 *   node build/zip.js <directorio de origen> <salida.zip> [--limit-mb 100]
 * Códigos de salida: 0 correcto / 1 error / 2 supera el límite de tamaño (en CI se trata como fallo; no volver a enviar paquetes divididos en silencio)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Buscar el ejecutable independiente de 7-Zip (7z.exe o 7za.exe) en las ubicaciones habituales */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // Buscar en PATH (windows-latest de GitHub Actions incluye 7-Zip y lo tiene en PATH)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // Caché de 7zip descargada por electron-builder (habitual en máquinas de desarrollo locales)
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* No hay directorio de caché */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Comprimir el zip con 7-Zip: cwd se fija al directorio de origen para que las rutas internas sean relativas y no incluyan el nombre del directorio superior */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Error al comprimir con 7-Zip (${r.status}):${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Respaldo: PowerShell Compress-Archive (un 5 % más grande, solo se usa si 7-Zip no está instalado) */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Error de Compress-Archive:${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Autocomprobación del resultado: leer el zip con el propio analizador de la aplicación para confirmar que el número de entradas y los bytes descomprimidos coinciden */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`El número de entradas no coincide: en el paquete ${names.length}, en el directorio de origen ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`Los bytes descomprimidos totales no coinciden: en el paquete ${bytes}, en el directorio de origen ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('Uso: node build/zip.js <directorio de origen> <salida.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`Comprimiendo ${srcDir} (${stats.files} archivos, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('Compresor:', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('⚠️  No se encontró 7-Zip; se usa Compress-Archive como respaldo: el resultado será unos 5 % más grande y quizá no quepa en el límite de un solo archivo de Gitee');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`Completado: ${outZip}`);
  console.log(`  ${entries} entradas, ${size} bytes (${(size / MIB).toFixed(2)} MiB), tasa de compresión ${(size / stats.bytes * 100).toFixed(1)} %`);

  if (size > limitMiB * MIB) {
    console.error(`✗ Supera el límite de ${limitMiB} MiB (tope de 100 MB por archivo adjunto en Gitee). Reduce primero el tamaño del paquete; no intentes eludirlo dividiéndolo.`);
    process.exit(2);
  }
  console.log(`  ✓ Dentro de ${limitMiB} MiB (margen ${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
