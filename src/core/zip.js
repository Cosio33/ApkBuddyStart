'use strict';
/**
 * Lector ZIP mínimo (solo depende del zlib integrado en Node)
 * Solo analiza el directorio central y descomprime un único elemento bajo demanda, para evitar que descomprimir por completo un APK grande sature la memoria.
 *
 * Nota: este archivo solo «lee», no «escribe». Dos invariantes relacionados con el «tamaño»:
 *  - Un Buffer individual tiene un límite (Node unos 2 GB), así que los elementos de nivel GB usan siempre ZipFile + pipeTo;
 *  - El EOCD tradicional de ZIP guarda el número de elementos y los desplazamientos en 16/32 bits; al superarse, desborda a 0xffff/0xffffffff,
 *    y el valor real está en el EOCD Zip64 (0x06064b50) y en el campo de extensión Zip64 (id=0x0001).
 *    Ambas rutas han de reconocerse, o los paquetes de imágenes grandes se «truncarán silenciosamente» o saldrán de límites.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Límite de un único elemento para read(): si se supera, se pide al llamador que use pipeTo (flujo), evitando cargar el bloque entero en memoria
const MAX_READ = 256 * 1024 * 1024;

/** Convertir con seguridad un desplazamiento BigInt a Number (un ZIP no puede superar 2^53 bytes) */
function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

/**
 * Analizar el campo de extensión Zip64 (0x0001), completando los campos del directorio central que se pusieron a 0xffffffff.
 * El orden de los campos es fijo: tamaño sin comprimir, tamaño comprimido, desplazamiento de la cabecera local, número de disco de inicio; solo aparecen los que estaban «marcados».
 * @param {Buffer} extra campo de extensión de la entrada del directorio central
 * @param {{uncompSize:number, compSize:number, localOffset:number}} fields
 */
function applyZip64Extra(extra, fields) {
  if (!extra || extra.length < 4) return fields;
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let p = dataStart;
      const take64 = () => {
        if (p + 8 > dataEnd) return null;
        const v = toNum(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      if (fields.uncompSize === MAX32) { const v = take64(); if (v !== null) fields.uncompSize = v; }
      if (fields.compSize === MAX32) { const v = take64(); if (v !== null) fields.compSize = v; }
      if (fields.localOffset === MAX32) { const v = take64(); if (v !== null) fields.localOffset = v; }
      break;
    }
    off = dataEnd;
  }
  return fields;
}

/**
 * Obtener del EOCD el número de elementos / tamaño del directorio central / desplazamiento del directorio central, siguiendo automáticamente Zip64.
 * @param {Buffer} buf búfer que contiene el EOCD
 * @param {number} eocd índice del EOCD dentro de buf
 * @param {number} base desplazamiento absoluto en el archivo que corresponde a buf[0] (lo usa la ventana final de ZipFile)
 * @returns {{total:number, cdSize:number, cdOffset:number, eocdAbs:number}}
 */
function readEndOfCentralDirectory(buf, eocd, base) {
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdAbs = base + eocd;

  const needsZip64 = total === MAX16 || cdSize === MAX32 || cdOffset === MAX32;
  if (!needsZip64) return { total, cdSize, cdOffset, eocdAbs };

  // El localizador del EOCD Zip64 está fijamente justo antes del EOCD, 20 bytes
  const loc = eocd - 20;
  if (loc < 0) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) return { total, cdSize, cdOffset, eocdAbs };
  const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
  const z64 = z64Abs - base;
  if (z64 < 0 || z64 + 56 > buf.length) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) return { total, cdSize, cdOffset, eocdAbs };

  total = toNum(buf.readBigUInt64LE(z64 + 32));
  cdSize = toNum(buf.readBigUInt64LE(z64 + 40));
  cdOffset = toNum(buf.readBigUInt64LE(z64 + 48));
  return { total, cdSize, cdOffset, eocdAbs };
}

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    let eocd = -1;
    const maxScan = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No es un archivo ZIP/APK válido (no se encontró EOCD)');

    const { total, cdOffset } = readEndOfCentralDirectory(buf, eocd, 0);
    let offset = cdOffset;

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLen;
      if (nameEnd > buf.length) break;
      const fields = applyZip64Extra(
        buf.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: buf.readUInt32LE(offset + 24),
          compSize: buf.readUInt32LE(offset + 20),
          localOffset: buf.readUInt32LE(offset + 42),
        },
      );
      const name = buf.toString('utf8', offset + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      offset = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`Cabecera de archivo local fuera de límites: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`Cabecera de archivo local dañada: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > buf.length) throw new Error(`Datos de entrada fuera de rango: ${name}`);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Método de compresión no compatible ${e.method}: ${name}`);
  }

  /** Listar los nombres de entrada que coinciden con un prefijo/regex */
  find(re) {
    return [...this.entries.keys()].filter((n) => re.test(n));
  }

  /**
   * Descomprimir un único elemento en flujo hacia una secuencia grabable.
   * Los elementos de nivel GB como system.img no caben enteros en memoria al inflarlos (se topa con el límite de 2 GB por Buffer de Node),
   * hay que descomprimir y escribir en disco a la vez.
   */
  pipeTo(name, dest) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`La entrada no existe: ${name}`));
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      return Promise.reject(new Error(`Cabecera de archivo local dañada: ${name}`));
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);

    return new Promise((resolve, reject) => {
      const done = (err) => { if (err) reject(err); else resolve(e.uncompSize); };
      dest.on('error', done);
      dest.on('finish', () => done(null));

      if (e.method === 0) {
        dest.end(raw);
        return;
      }
      if (e.method !== 8) return done(new Error(`Método de compresión no compatible ${e.method}: ${name}`));

      const inflater = zlib.createInflateRaw();
      // Alimentar por fragmentos, para no meter datos de GB de golpe en el búfer de zlib
      const SLICE = 1 << 20;
      let pos = 0;
      const pump = () => {
        while (pos < raw.length) {
          const end = Math.min(pos + SLICE, raw.length);
          const chunk = raw.subarray(pos, end);
          pos = end;
          if (!inflater.write(chunk)) {
            inflater.once('drain', pump);
            return;
          }
        }
        inflater.end();
      };
      inflater.on('error', done);
      inflater.pipe(dest);
      pump();
    });
  }
}

/**
 * Lector ZIP basado en archivo: solo carga en memoria el directorio central del final, y los elementos se leen en flujo desde el fd bajo demanda.
 * Se usa para paquetes de nivel GB como emulator / imágenes de sistema: el antiguo fs.readFileSync leía el paquete entero y
 * provocaba OOM directo en equipos con poca memoria, lo que se manifestaba como «se descargó pero no se instala».
 */
class ZipFile {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.statSync(filePath).size;
    this.entries = new Map();
    try { this._parse(); } catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync puede leer menos de lo pedido (especialmente bloques grandes); hay que repetir hasta completar
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) break;
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('No es un archivo ZIP/APK válido (el archivo es demasiado pequeño)');
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No es un archivo ZIP/APK válido (no se encontró EOCD)');

    const { total, cdSize, cdOffset, eocdAbs } = readEndOfCentralDirectory(tail, eocd, tailBase);
    if (cdOffset + cdSize > this.size) {
      throw new Error('Desplazamiento anómalo del directorio central del ZIP');
    }

    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset + cdSize > eocdAbs) {
      // El directorio central no está en el búfer final (comentario enorme / varios volúmenes); se lee con precisión un tramo según el tamaño declarado
      const len = Math.min(cdSize, 256 * 1024 * 1024);
      if (len <= 0) throw new Error('Desplazamiento anómalo del directorio central del ZIP');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const nameEnd = off + 46 + nameLen;
      if (nameEnd > cd.length) break;
      const fields = applyZip64Extra(
        cd.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: cd.readUInt32LE(off + 24),
          compSize: cd.readUInt32LE(off + 20),
          localOffset: cd.readUInt32LE(off + 42),
        },
      );
      const name = cd.toString('utf8', off + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      off = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`La entrada no existe: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Cabecera de archivo local dañada: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    // read() descomprime el elemento entero en memoria: se pone un límite explícito para evitar que algún punto de llamada futuro
    // lo use sin querer para leer imágenes de GB (que es justo el fallo «los paquetes grandes siempre revientan» del issue #21).
    if (e.compSize > MAX_READ) {
      throw new Error(`La entrada es demasiado grande (${(e.compSize / 1048576).toFixed(0)}MB), cambia a pipeTo: ${name}`);
    }
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`Datos de la entrada truncados: ${name}`);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Método de compresión no compatible ${e.method}: ${name}`);
  }

  pipeTo(name, dest) {
    let r;
    try { r = this._range(name); } catch (e) { return Promise.reject(e); }
    const { e, start, end } = r;
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(e.uncompSize));
      dest.on('error', done);
      dest.on('finish', () => done(null));
      if (e.compSize === 0) { dest.end(); return undefined; }
      if (e.method !== 0 && e.method !== 8) return done(new Error(`Método de compresión no compatible ${e.method}: ${name}`));
      const src = fs.createReadStream(null, {
        fd: this.fd, autoClose: false, start, end: Math.max(start, end),
      });
      src.on('error', done);
      if (e.method === 0) return src.pipe(dest);
      const inflater = zlib.createInflateRaw();
      inflater.on('error', done);
      return src.pipe(inflater).pipe(dest);
    });
  }
}

/**
 * Resolver con seguridad el nombre de una entrada ZIP bajo destDir, bloqueando zip-slip (issue #2 P0-4).
 * Las rutas maliciosas «../evil», absolutas, con letra de unidad, «C:\...» y UNC han de rechazarse antes de escribir en disco.
 * Devuelve null si la entrada no es de confiar; el llamador debe omitirla.
 */
function resolveZipEntry(destDir, name) {
  if (typeof name !== 'string' || !name) return null;
  // Se normalizan primero las barras diagonales: la barra invertida también es separador de ruta en Windows
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..')) return null;
  const root = path.resolve(destDir);
  const target = path.resolve(root, ...segments.filter((s) => s && s !== '.'));
  // path.resolve puede sacar el destino fuera de la raíz por letras de unidad/puntos de montaje; se comprueba otra vez el límite del prefijo al final
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

module.exports = { ZipArchive, ZipFile, resolveZipEntry };
