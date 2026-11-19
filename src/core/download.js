'use strict';
/**
 * Descargador: admite redirecciones, reanudación, callback de progreso y verificación SHA-256.
 * Solo depende de http/https; se puede usar tanto en el proceso principal como en pruebas puras de Node.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'ApkBuddyStart/0.2 (Windows; +https://github.com/apkstart)';

/**
 * Verificar que el Content-Range devuelto por el servidor coincide con esta petición.
 * En la reanudación / descarga por bloques, lo peor es que «el servidor no acepte Range y envíe el paquete desde el principio»
 * o que «devuelva un bloque de otro archivo»: escribirlo directamente en el archivo de destino da un paquete que parece completo
 * pero está dañado. Aquí se comparan uno a uno los bytes de inicio/fin, el tamaño total y el Content-Length;
 * cualquier discrepancia se rechaza y se pasa al llamador para que cambie de origen o reintente.
 */
function validRange(res, start, end, total) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
  if (!m) return false;
  const [a, b, size] = m.slice(1).map(Number);
  const length = res.headers['content-length'];
  return Number.isSafeInteger(size) && a === start && b === end && size === total &&
    (length == null || Number(length) === end - start + 1);
}

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Demasiadas redirecciones'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Tiempo de espera de conexión agotado')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Descartar todos los restos de una descarga fallida.
 *
 * Esta es la causa raíz del «siempre vuelve a descargar»: antes, todas las rutas de fallo solo lanzaban una excepción sin borrar archivos,
 * así que en tmp quedaba para siempre un zip a medias junto con su archivo lateral .chunks.json. La próxima vez,
 * downloadParallel/download veía el archivo existente y continuaba con Range; pero en cuanto el tamaño total /
 * el modo de fragmentación del servidor diferían de la vez anterior, volvía a fallar → otro archivo a medias →
 * bucle infinito. El usuario ve «cada vez que abro, vuelve a descargar el mismo paquete».
 *
 * Conservar la reanudación está bien, pero hay que limitarla a los casos en que «se puede continuar de verdad»; en cuanto
 * esta descarga se declara fallida, se invalida el paquete entero y se empieza limpio la próxima vez.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* Si está ocupado, se omite */ }
  }
}

/**
 * Descargar a un archivo local (reanuda automáticamente).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // Un 416 puede significar dos cosas: el archivo ya se descargó del todo, o el fragmento local no concuerda con el destino (el servidor considera que ese
      // Range no es válido). Antes se daba por éxito sin más y el fragmento malo quedaba como «descargado». Aquí, si se envió Range y aún quedan reintentos,
      // se borra el fragmento y se vuelve a bajar completo; si se agotan los reintentos sin éxito, se lanza el error.
      if (existing > 0 && attempt <= retries + 1) {
        discardPartial(dest);
        continue;
      }
      throw new Error('No se pudo verificar el archivo de reanudación; el servidor devolvió HTTP 416');
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // Reintentos agotados: no dejar el archivo malo para la próxima reanudación
      throw new Error(`Error de descarga, HTTP ${res.statusCode}: ${url}`);
    }

    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
      if (!m || !validRange(res, existing, Number(m[2]), Number(m[3])) || Number(m[2]) !== Number(m[3]) - 1) {
        res.resume();
        discardPartial(dest);
        throw new Error('El servidor devolvió un rango de reanudación que no coincide');
      }
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // El servidor no admite reanudación; se escribe desde el principio
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // Igual que en la descarga por bloques: hay que garantizar que la promise termine sí o sí.
        // Si la conexión se calla (bloqueo / limitación), res no emite end ni error, pipe nunca termina,
        // y toda la descarga se queda colgada aquí: el usuario ve la barra de progreso inmóvil y sin ningún error.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error('Conexión estancada (mucho tiempo sin datos)'));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error('Cancelado')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error('Conexión interrumpida')); });
      });
    } catch (e) {
      // Interrupción / tiempo de espera / fallo de escritura: dejar el archivo a medias solo hará que la próxima reanudación vuelva a fallar
      discardPartial(dest);
      throw e;
    }

    break;
  }

  // Remate: asegurar que la barra de progreso llega al 100 %
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(`Error de verificación: se esperaba ${expectSha256.slice(0, 12)}… real ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // openStream rechaza directamente (conexión rechazada / fallo DNS / tiempo de espera) y no entra en el
    // try/catch de la escritura — antes aquí no se limpiaba nada y el archivo a medias hacía fallar la reanudación siguiente.
    // Se cubre todo en el nivel más externo: cualquier excepción descarta primero los restos.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Descarga paralela por bloques (para archivos grandes).
 * Una sola conexión TCP se ve limitada a decenas de KB/s en algunos espejos; la concurrencia por bloques mejora mucho el rendimiento real.
 * Solo se hace en paralelo si «el archivo de destino no existe»; si ya hay un archivo parcial, se vuelve a la reanudación de flujo único para no perder el estado de bloques.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // Ya hay un archivo parcial → se deja a la reanudación de flujo único
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // Se comprueba si se admite Range
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* Si la detección falla, se usa flujo único */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Primero se crea el archivo vacío y se sitúa en el último byte, para que los write posteriores no se salgan de límites
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Solicitud de fragmento rechazada HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('El servidor devolvió un rango de fragmentos que no coincide');
    }
    await new Promise((resolve, reject) => {
      // Hay que cubrirse uno mismo de que «la promise nunca termina»: res.destroy(err) en algunos casos solo emite
      // close y no error; sin esta guarda, un bloque entero se queda colgado y la descarga se detiene ahí.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      };
      res.on('data', (buf) => {
        // El servidor puede devolver más datos de los que corresponden al bloque pedido; esos bytes de más se escribirían
        // sobre otro bloque y darían un paquete dañado de forma silenciosa. Mejor declarar fallo y cambiar de origen: no se permite que se escriba en disco.
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('La respuesta del fragmento supera el rango solicitado'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Conexión interrumpida')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('El fragmento no se devolvió completo');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`Error en la descarga por bloques (${c.start}-${c.end}）：${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // Paquete entero invalidado; no dejar archivos a medias para la próxima reanudación
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Descarga incompleta:${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n };
}

/** Probar varios orígenes en orden; se devuelve el primero que funciona */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // Antes de cambiar de origen, se borra el archivo a medias del anterior
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Todas las fuentes de descarga han fallado:
${errors.join('\n')}`);
}

/**
 * Descarga multi-origen simultánea: se corta el archivo en bloques y **distintos bloques se bajan a la vez de orígenes distintos**, sumando ancho de banda.
 *
 * Por qué hace falta: limitar una sola conexión de GitHub es muy habitual, y los espejos también suelen limitar cada uno;
 * si las 8 conexiones apuntan a la misma dirección, el techo es el límite de esa dirección. Si se dan 4 a GitHub y
 * 4 al espejo, se suman ambos topes y en pruebas se consigue más del doble de velocidad.
 *
 * Condición de seguridad: solo se mezclan orígenes que «declaran el mismo tamaño total», o se podría armar un archivo dañado;
 * si un origen falla a mitad, sus bloques se reintentan automáticamente en la siguiente dirección disponible (sin rehacer el paquete entero).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Número de reintentos por bloque. 3 no bastan en un enlace donde «dos de tres orígenes fallan de vez en cuando»:
    // si un bloque del paquete de runtime de 1,4 GB agota los reintentos, el paquete entero se invalida y se vuelve a bajar. Se sube a 6 (dos rondas por origen).
    // El reintento continúa desde el punto de corte (se conserva c.pos), así que no se vuelven a descargar los bytes ya recibidos.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('No hay direcciones de descarga disponibles');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) Detección en paralelo: tamaño total y si se admite Range
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Solo se mezclan orígenes que «declaran el mismo tamaño total», o se arma un archivo dañado.
  // De referencia se toma el tamaño total del origen **más rápido medido** (el orden de usable ya viene ordenado por velocidad con rank(),
  // la detección es Promise.all pero los resultados vuelven en orden de entrada):
  // GitHub y Gitee comprimen cada uno sus bytes (diferir varios MB es normal);
  // antes se tomaba Math.max fijo, lo que equivalía a descargar siempre el origen más grande — y en redes de China eso
  // significaba «se excluye el paquete rápido de Gitee y se obliga a usar el lento de GitHub».
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) Se corta en bloques y se asignan orígenes por turnos
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Reanudación por bloques: en un enlace donde «el espejo falla de vez en cuando», un bloque del paquete de 1,4 GB
  // puede agotar fácilmente los reintentos y obligar a rehacer todo el paquete, con otros diez minutos de espera.
  // Aquí se anota en un archivo lateral qué bloques ya están completos, y la próxima vez (misma ruta y misma fragmentación) solo se rellenan los que faltan.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* Si no hay archivo lateral, se descarga todo de nuevo */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // Hay que inicializarlo explícitamente: undefined < 2 es false y el cambio de origen nunca se dispararía
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* Si no se puede escribir el archivo lateral, no afecta a la descarga */ }
  };

  // En la reanudación se suman al progreso los bloques ya completos, para que el porcentaje no vuelva a empezar en 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Cambio de origen por baja velocidad: cuando un bloque solo va a decenas de KB/s desde un origen, esperar a que termine
  // convierte toda la descarga en «se quedó en el 95 %». Si supera slowAfterMs y la velocidad media está por debajo de slowBps,
  // se interrumpe y se pasa al siguiente origen (continuando desde el punto de corte, sin perder datos). Máximo 2 cambios por bloque, para no dar saltos entre orígenes lentos.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Fragmento rechazado, HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('El servidor devolvió un rango de fragmentos que no coincide');
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // Tras destroy, una misma conexión aún puede recibir paquetes ya en búfer, lo que dispararía otro cambio de origen y se saltaría demasiados;
    // por eso cada petición solo permite un cambio.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Perro guardián de inactividad + «garantizar el settle»: la conexión se establece pero no llega ni un byte (típico
      // «TCP conecta pero está bloqueado/limitado»), y esperar a que el socket agote el tiempo son 30 s; además res.destroy(err)
      // puede emitir solo close y no error, con lo que la promise nunca rechaza: un bloque se queda colgado y la descarga entera se detiene (tropezado en la práctica).
      // Por eso el perro guardián llama a finish por su cuenta.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (tiempo sin datos)')); }, idleMs);
      };
      res.on('data', (buf) => {
        // Igual que arriba: se rechazan bytes fuera del rango pedido, para no dañar un bloque sin que se note
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('La respuesta del fragmento supera el rango solicitado'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Si aún no ha terminado y va demasiado lento → cambiar de origen (c.pos ya avanzó; la próxima vez se continúa desde ahí)
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // Aquí no se avanza c.src: el cambio de origen lo hace unificado el catch de abajo, o un solo fallo saltaría dos orígenes
            res.destroy();
            finish(new Error(`Esta fuente es demasiado lenta (${(bps / 1024).toFixed(0)} KB/s), cambia de fuente e inténtalo de nuevo`));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Conexión interrumpida')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('El fragmento no se devolvió completo');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Reintentos agotados: este archivo ya tiene mezclados bloques de distintos orígenes y por mucha reanudación
            // no se van a poder unir en bytes correctos. Se invalidan el paquete entero y el archivo lateral, y se empieza limpio.
            // Antes aquí solo se hacía saveMeta() para conservar, y cada apertura seguía desde el bloque malo → redescarga infinita.
            discardPartial(dest);
            throw new Error(`Error al dividir en bloques (${c.start}-${c.end}）：${e.message}`);
          }
          // Se prueba otro origen: un espejo que se porta mal no debe tirar abajo toda la descarga
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Descarga incompleta:${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Probar varios orígenes en orden (versión por bloques paralelos); se devuelve el primero que funciona */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    // Antes de cambiar de origen hay que borrar el archivo a medias del anterior: los paquetes de orígenes distintos pueden tener bytes diferentes,
    // y continuar con el fragmento del origen A en el origen B daría siempre un archivo dañado (falla la verificación → otra descarga).
    discardPartial(dest);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Todas las fuentes de descarga han fallado:
${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial, validRange,
};
