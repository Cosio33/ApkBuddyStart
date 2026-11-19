'use strict';
/**
 * Sincronizar una versión publicada con Gitee.
 *
 * Por qué existe este script: Gitee limita cada archivo adjunto a 100 MB (en pruebas, 104,857,600 bytes,
 * y se pueden subir 104,800,000). El paquete portátil comprimido con 7-Zip ocupa unos 99,6 MB, así que se puede subir
 * un zip completo y el usuario solo tiene que descomprimirlo: ya no se divide en part1/part2 (esas piezas hay que unirlas en orden,
 * y quien descarga a mano no puede usarlas). Solo se recurre a la división si se supera el límite; el updater de la aplicación
 * admite ambos formatos.
 * El instalador Setup (1,4 GB) y el paquete completo del runtime (1,4 GB) superan demasiado el límite y siguen en GitHub:
 * la aplicación trata la disponibilidad de recursos en cada fuente como una unión, así que la actualización no se ve afectada.
 *
 * Uso:
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   tag a publicar (debe estar ya enviado a Gitee)
 *     D:/dist  directorio que contiene ApkBuddyStart-v0.3.3-win64-portable.zip (opcional; también se puede indicar con --zip)
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Límite de un solo archivo adjunto en Gitee (100 MiB, comprobado)
const PART_LIMIT = 99 * 1024 * 1024;   // Tamaño de cada parte si hay que dividir; se reserva 1 MB para la cabecera multipart

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('Falta la variable de entorno GITEE_TOKEN');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* Quizá sea una respuesta vacía */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** Dividir un archivo grande; devuelve un array con las rutas resultantes.
 *  El umbral es HARD_LIMIT (100 MiB, el límite real de Gitee), no PART_LIMIT:
 *  si no, un paquete de 99~100 MiB que podría subirse completo se dividiría sin necesidad,
 *  y quien lo descarga a mano tendría que unir las partes para descomprimirlo (precisamente lo que este script evita). */
function splitFile(file, threshold, chunk = PART_LIMIT) {
  const size = fs.statSync(file).size;
  if (size <= threshold) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(chunk, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * Subir un único archivo adjunto.
 * Un paquete completo de 95 MB se envía en una sola petición POST (Gitee no tiene API de subida por partes) y, en la red nacional,
 * es fácil que falle a mitad de transferencia; antes no había reintentos y un solo fallo obligaba a repetir todo el comando,
 * además de tener que borrar antes los adjuntos antiguos. Por eso hay 3 reintentos con espera creciente.
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) {
        // El attach_files de Gitee a veces devuelve 200 + {"message": "..."} en vez de un código de error,
        // Tratar el JSON.parse directo como éxito deja el paso "correcto pero sin archivo" (en v0.5.0 se perdió un paquete así).
        // Hay que confirmar que la respuesta contenga un objeto de adjunto; si no, se considera un fallo reintentable.
        let j = null;
        try { j = JSON.parse(text); } catch (_) { /* Respuesta vacía también cuenta como fallo */ }
        if (j && (j.id || j.name)) return j;
        lastErr = new Error(`La API devolvió 200 pero sin información del adjunto: ${text.slice(0, 160)}`);
      } else {
        // Los 4xx (salvo 429) no merecen reintento: un token caducado o un conflicto de nombre no se arregla al repetir
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`Error al subir ${name}: ${res.status} ${text.slice(0, 200)}`);
        }
        lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
      }
    } catch (e) {
      lastErr = e;
      if (/^Error al subir .*/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   Falló el intento ${i} de subida (${lastErr.message}); se reintenta en ${wait} s…`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`Error al subir ${name} (se intentó ${attempts} veces): ${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('Uso:GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip ruta] [--notes archivo]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`No se encontró el paquete portátil: ${zip || '(sin especificar)'}. Indícalo con --zip o coloca el zip en ${dir}`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Paquete portátil (un solo zip, se descomprime y se usa; también se actualiza automáticamente desde la aplicación). El instalador completo y el paquete del runtime están en GitHub Releases.`;

  console.log('1) Buscar/crear la versión', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   Creada con id =', rel.id);
  } else {
    console.log('   Ya existe con id =', rel.id);
  }

  // Al volver a publicar la misma versión (código modificado y reempaquetado), hay que borrar primero los adjuntos antiguos; si no, la página muestra a la vez
  // las dos series de part1/part2 y cuál descarga el cliente depende de la suerte.
  if (process.argv.includes('--replace')) {
    console.log('2) Limpiar los adjuntos antiguos con el mismo nombre');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkBuddyStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Eliminado', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`⚠️  El paquete portátil ${(zipSize / 1048576).toFixed(1)} MB supera el límite de un solo archivo de Gitee y debe dividirse;`
      + 'quien lo descargue a mano tendrá que unir las partes en orden; se recomienda comprimir antes con `node build/zip.js` o reducir el paquete.');
  }
  console.log('3) Preparar la subida (primero el paquete completo; solo se divide si supera el límite)');
  const parts = splitFile(zip, HARD_LIMIT, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // Una misma versión puede haber cambiado de formato de empaquetado (completo ↔ dividido): hay que borrar el adjunto del otro formato,
  // si no, la versión tendrá a la vez `x.zip` y `x.zip.part1/part2` y cuál descarga el cliente depende de la suerte.
  // --replace limpia también otras versiones; aquí solo se limpia la otra forma del nombre de paquete actual.
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Eliminado el adjunto anterior de otra forma', a.name);
    }
  }

  for (const f of files) {
    console.log(`   Subiendo ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }

  // Verificar: que la API devuelva éxito no significa que el adjunto esté realmente subido (en v0.5.0 ocurría "éxito sin paquete",
  // y el usuario lo descubría al recibir un 404). El adjunto debe aparecer en attach_files; si no, se falla el paso.
  console.log('4) Verificar los adjuntos');
  {
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const have = new Set((Array.isArray(list) ? list : []).map((a) => a.name));
    const missing = files.map((f) => path.basename(f)).filter((n) => !have.has(n));
    if (missing.length) {
      throw new Error(`Faltan adjuntos tras la subida: ${missing.join(', ')} (existentes: ${[...have].join(', ') || 'ninguno'})`);
    }
    console.log('   OK:' + files.map((f) => path.basename(f)).join(', '));
  }

  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\nCompletado: https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
