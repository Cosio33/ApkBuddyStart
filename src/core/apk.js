'use strict';
/**
 * Extracción de metadatos de APK: nombre de paquete / versión / nombre de la app / Activity de arranque / icono / ABI
 * Todo se hace sin conexión: no necesita aapt, ni adb, ni internet.
 */
const fs = require('fs');
const { ZipFile } = require('./zip');
const { parseAxml, attr, attrValue, children } = require('./axml');
const { ResTable } = require('./arsc');
const { validPackageName } = require('./pkgname');

const LAUNCHER_ACTIONS = ['android.intent.action.MAIN'];
const LAUNCHER_CATS = ['android.intent.category.LAUNCHER'];

function isLauncherActivity(node) {
  const filters = children(node, 'intent-filter');
  for (const f of filters) {
    const actions = children(f, 'action').map((a) => attrValue(a, 'name'));
    const cats = children(f, 'category').map((c) => attrValue(c, 'name'));
    const hasMain = actions.some((a) => LAUNCHER_ACTIONS.includes(a));
    const hasLauncher = cats.some((c) => LAUNCHER_CATS.includes(c));
    if (hasMain && hasLauncher) return true;
  }
  return false;
}

function pickIconFromZip(zip) {
  // Respaldo: buscar en res/ el mapa de bits más grande con nombre de aspecto icono (se aceptan png / webp / jpg)
  const candidates = zip.names().filter((n) => /^res\/.*\.(png|webp|jpe?g)$/i.test(n));
  const scored = candidates.map((n) => {
    const e = zip.entries.get(n);
    let s = e.uncompSize;
    if (/ic_launcher|app_icon|ic_app/i.test(n)) s *= 6;
    if (/_round|_foreground|_background/i.test(n)) s *= 0.4;
    if (/xxxhdpi/i.test(n)) s *= 1.6;
    else if (/xxhdpi/i.test(n)) s *= 1.4;
    else if (/xhdpi/i.test(n)) s *= 1.2;
    if (/\//.test(n.split('/')[1] || '')) { /* noop */ }
    return { n, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(0, 30)) {
    try {
      const data = zip.read(c.n);
      if (data && data.length > 100) return { data, file: c.n };
    } catch (_) { /* ignore */ }
  }
  return null;
}

const IMG_RE = /\.(png|webp|jpe?g)$/i;

// ---- Orientación de pantalla ----
// En AndroidManifest, android:screenOrientation es un entero enumerado:
//   0 unspecified / 1 portrait / 2 landscape / 3 sensor / 4 sensorLandscape
//   5 sensorPortrait / 6 reverseLandscape / 7 reversePortrait / 8 behind
//   9 nosensor / 10 user / 11 fullSensor / 12 userLandscape / 13 userPortrait
//   14 fullUser / 15 locked
// Solo se cuenta lo que «fija explícitamente una orientación»; sensor / fullSensor / user / unspecified
// siguen la gravedad y debe decidirlo el panel físico del runtime, así que se omiten en el recuento; si no,
// todas las apps acabarían clasificadas como «orientación indeterminada».
const ORI_PORTRAIT = new Set([1, 5, 7, 13]);
const ORI_LANDSCAPE = new Set([2, 4, 6, 12]);

/**
 * Determinar si una app es «por naturaleza» vertical u horizontal.
 *
 * ¿Por qué hace falta?: en cuanto la orientación del panel físico del emulador (hw.lcd) no coincide con el
 * screenOrientation de la propia app, Android solo concede a la app una franja estrecha en modo letterbox
 * — con barras negras a ambos lados, y da igual cuánto se ajusten wm size / density / letterbox-style:
 * no se llega a llenar (probamos cada combinación, véase docs). La única forma de que la imagen ocupe
 * toda la ventana es que la orientación del panel coincida con la declarada por la app. Por eso, al instalar,
 * se calcula la orientación sin conexión y se guarda en apps.json; al arrancar se elige el panel según ese
 * valor y el usuario no ve barras negras.
 *
 * Criterio de recuento: se cuenta el número de Activities que declaran una orientación explícita
 * (la Activity de arranque pesa más, porque es la que el usuario ve más a menudo). Una app con
 * «decenas de portrait + un montón de sensor» dará portrait; una app de una sola Activity landscape dará landscape.
 *
 * @returns {'portrait'|'landscape'|null} null = declarada como «seguir la gravedad»; lo decide Ajustes
 */
function detectOrientation(acts, launcher) {
  let portrait = 0;
  let landscape = 0;
  for (const a of acts) {
    const raw = attrValue(a, 'screenOrientation');
    const v = typeof raw === 'number' ? raw : Number(raw);
    const weight = a === launcher ? 4 : 1;
    if (ORI_PORTRAIT.has(v)) portrait += weight;
    else if (ORI_LANDSCAPE.has(v)) landscape += weight;
  }
  if (portrait === 0 && landscape === 0) return null;
  if (portrait === landscape) return null;
  return portrait > landscape ? 'portrait' : 'landscape';
}

/** Tomar la referencia drawable / src de un nodo y convertirla en una ruta de archivo dentro del APK */
function drawableFileOf(node, res) {
  for (const name of ['drawable', 'src']) {
    const a = attr(node, name);
    if (!a) continue;
    if (a.refId && res) {
      const f = res.resolve(a.refId, 'file');
      if (f) return f;
    } else if (typeof a.typed === 'string') {
      return a.typed;
    }
  }
  return null;
}

/**
 * Buscar un mapa de bits utilizable en el árbol de nodos del XML de iconos. Búsqueda en profundidad, XML expandido como máximo 3 niveles más:
 * los iconos adaptativos modernos suelen ser `<adaptive-icon><foreground><inset><drawable/></inset></foreground>`,
 * o `<layer-list><item><bitmap android:src="@drawable/x"/></item></layer-list>`;
 * mirar solo un nivel de atributos acaba directamente en «la imagen de marcador de posición de la marca».
 */
function iconFromNode(zip, node, res, depth = 0) {
  const file = drawableFileOf(node, res);
  if (file) {
    if (IMG_RE.test(file) && zip.has(file)) {
      const data = zip.read(file);
      if (data && data.length > 100) return { data, file };
    }
    if (/\.xml$/i.test(file) && depth < 3 && zip.has(file)) {
      const inner = iconFromXml(zip, zip.read(file), res, depth + 1);
      if (inner) return inner;
    }
  }
  for (const c of node.children || []) {
    const hit = iconFromNode(zip, c, res, depth);
    if (hit) return hit;
  }
  return null;
}

/** Encontrar los mapas de bits de primer plano/fondo utilizables en el XML del icono adaptativo / layer-list */
function iconFromXml(zip, xmlBuffer, res, depth = 0) {
  let root;
  try {
    root = parseAxml(xmlBuffer);
  } catch (_) {
    return null;
  }
  // Primero en el orden previsto por la especificación: foreground → background → monochrome
  for (const key of ['foreground', 'background', 'monochrome']) {
    const node = root.children.find((c) => c.name === key) || (root.name === key ? root : null);
    if (!node) continue;
    const hit = iconFromNode(zip, node, res, depth);
    if (hit) return hit;
  }
  // Después se barre todo el árbol (layer-list / bitmap / inset y otros sin nombre fijo de nodo hijo)
  return iconFromNode(zip, root, res, depth);
}

/**
 * Analizar los metadatos de un APK.
 * Se usa el lector ZIP basado en archivo (solo directorio central + lectura de entradas bajo demanda), por lo que **no se carga el APK entero en memoria**:
 * el antiguo fs.readFileSync de paquetes de más de 2 GB fallaba directamente (límite de Buffer único de Node),
 * y en equipos con poca memoria los paquetes grandes también podían sufrir OOM.
 */
function parseApk(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error('El archivo es demasiado pequeño; no es un APK válido');
  const zip = new ZipFile(filePath);
  try {
    return parseApkZip(zip, filePath, stat);
  } finally {
    zip.close();
  }
}

/** Cuerpo de parseApk: el llamador se encarga de cerrar el zip */
function parseApkZip(zip, filePath, stat) {
  if (!zip.has('AndroidManifest.xml')) {
    throw new Error('Falta AndroidManifest.xml: no es un APK individual (puede ser un paquete dividido .apks/.xapk)');
  }

  const manifestBuf = zip.read('AndroidManifest.xml');
  const manifest = parseAxml(manifestBuf);

  // package es un atributo **sin espacio de nombres** del manifest (ns=''), hay que buscarlo en «cualquier espacio de nombres»:
  // attrValue reconoce por defecto solo el espacio de nombres android; pasar null significa no limitarlo.
  const packageName = attrValue(manifest, 'package', null);
  if (!packageName) throw new Error('No se encontró el nombre de paquete en el manifiesto');
  // package acaba en concatenación de rutas y en comandos adb shell; debe ser un nombre de paquete Android estrictamente válido.
  // Un manifest malicioso o dañado con "../", letras de unidad o metacaracteres de shell se bloquea aquí (issue #2 P0-1).
  if (!validPackageName(packageName)) {
    throw new Error(`El nombre del package en el manifiesto no es válido:${JSON.stringify(String(packageName).slice(0, 80))}`);
  }

  const versionName = attrValue(manifest, 'versionName') || '1.0';
  const versionCodeRaw = attrValue(manifest, 'versionCode');
  const versionCode = typeof versionCodeRaw === 'number' ? versionCodeRaw : 0;

  const usesSdk = children(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? (attrValue(usesSdk, 'minSdkVersion') | 0) : 0;
  const targetSdk = usesSdk ? (attrValue(usesSdk, 'targetSdkVersion') | 0) : 0;

  const app = children(manifest, 'application')[0] || { children: [], attrs: [] };

  // ---- Tabla de recursos (para resolver referencias @0x7f) ----
  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  // ---- Nombre de la aplicación ----
  let label = null;
  const labelAttr = attr(app, 'label');
  if (labelAttr) {
    if (labelAttr.refId && res) label = res.resolve(labelAttr.refId, 'string');
    else if (typeof labelAttr.typed === 'string') label = labelAttr.typed;
  }
  if (!label || typeof label !== 'string') {
    label = packageName.split('.').pop();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---- Activity de arranque ----
  let launchActivity = null;
  const acts = children(app, 'activity').concat(children(app, 'activity-alias'));
  const launcher = acts.find(isLauncherActivity);
  if (launcher) {
    const n = attrValue(launcher, 'name');
    const target = attrValue(launcher, 'targetActivity');
    if (n) {
      if (n.startsWith('.')) launchActivity = packageName + n;
      else if (!n.includes('.')) launchActivity = `${packageName}.${n}`;
      else launchActivity = n;
      if (launcher.name === 'activity-alias' && target) {
        launchActivity = target.startsWith('.') ? packageName + target : target;
      }
    }
  }

  // ---- Orientación de pantalla (decide si el panel físico del emulador debe ser horizontal o vertical, véase detectOrientation) ----
  const orientation = detectOrientation(acts, launcher);

  // ---- Icono ----
  let icon = null;
  const iconAttr = attr(app, 'icon') || attr(app, 'roundIcon');
  if (iconAttr) {
    let file = null;
    if (iconAttr.refId && res) file = res.resolve(iconAttr.refId, 'file');
    else if (typeof iconAttr.typed === 'string') file = iconAttr.typed;

    if (file && zip.has(file)) {
      if (/\.xml$/i.test(file)) {
        icon = iconFromXml(zip, zip.read(file), res);
      } else {
        icon = { data: zip.read(file), file };
      }
    }
  }
  if (!icon) icon = pickIconFromZip(zip);

  // ---- ABI (para decidir si el runtime x86 puede ejecutar directamente bibliotecas nativas ARM) ----
  const abis = [...new Set(zip.names()
    .filter((n) => n.startsWith('lib/'))
    .map((n) => n.split('/')[1])
    .filter(Boolean))];

  return {
    ok: true,
    filePath,
    sizeBytes: stat.size,
    package: packageName,
    label: String(label).replace(/\s+/g, ' ').trim().slice(0, 60),
    versionName: String(versionName),
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    abis,
    orientation,
    iconPng: icon ? icon.data : null,
    iconFile: icon ? icon.file : null,
  };
}

/** Validación ligera: solo comprueba si la cabecera es PK\x03\x04 */
function quickCheck(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { parseApk, quickCheck, detectOrientation };
