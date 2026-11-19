'use strict';
/**
 * Generador unificado de iconos
 *   node_modules/electron/dist/electron.exe build/build-icons.js
 *
 * Un solo diseño, tres "lenguajes" de tamaño (práctica habitual en la industria, no tres juegos de iconos):
 *   1. Icono principal   ≥64px    el mosaico oscuro "APK start" de build/logo.html (renderizado fuera de pantalla con Chromium)
 *   2. Icono simplificado ≤48px    misma paleta sobre fondo oscuro + triángulo de reproducción verde de Android (dibujado en JS puro, aún reconocible a 16px)
 *   3. Versión mosaico   el icono principal recortado sin bordes transparentes, a tamaño completo; Windows se encarga de redondear las esquinas
 *
 * Salidas:
 *   src/ui/assets/logo.png (512) / logo-256 / logo-128 / logo-64    ventana, página Acerca de, Linux
 *   src/ui/assets/tray-16|20|24|32.png                               bandeja (icono simplificado)
 *   src/ui/assets/appicon.ico                                        múltiples tamaños 16–256
 *   build/store-assets/StoreLogo 50 / Square44 / Square71 /
 *                      Square150 / Square310 / Wide310x150 / Splash 620x300
 *   docs/images/logo.png (1024)
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { drawAppIcon } = require('../src/core/png');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'src', 'ui', 'assets');
const STORE = path.join(ROOT, 'build', 'store-assets');
const DOCS = path.join(ROOT, 'docs', 'images');

// Píxeles 1:1: evita que el escalado de alto DPI renderice 1024 como 1280
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.disableHardwareAcceleration();

const SQ = 1024;
const TILE_RATIO = 896 / 1024;            // Proporción que ocupa el mosaico dentro del icono principal
const TILE_PAD = Math.round((SQ - SQ * TILE_RATIO) / 2);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function save(file, buf) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, buf);
  const s = pngSize(buf);
  const dim = s ? `${s.w}x${s.h}` : `${buf.length}B`;
  console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}  ${dim}  ${(buf.length / 1024).toFixed(1)}KB`);
  return { file, buf, dim };
}

/** PNG-in-ICO: desde Vista, las entradas ICO pueden incrustar PNG directamente, sin recodificar ni perder alpha. */
function icoFrom(entries) {
  const items = entries.slice().sort((a, b) => a.size - b.size);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(items.length, 4);
  const dir = Buffer.alloc(items.length * 16);
  let offset = 6 + items.length * 16;
  items.forEach((it, i) => {
    const p = i * 16;
    dir.writeUInt8(it.size >= 256 ? 0 : it.size, p);
    dir.writeUInt8(it.size >= 256 ? 0 : it.size, p + 1);
    dir.writeUInt8(0, p + 2);
    dir.writeUInt8(0, p + 3);
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(it.buf.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += it.buf.length;
  });
  return Buffer.concat([head, dir, ...items.map((i) => i.buf)]);
}

// Un solo lienzo de ventana contiene los tres diseños; después se recorta por coordenadas.
// No crear una BrowserWindow nueva cada vez: en modo offscreen, al destruir/crear sucesivamente,
// el segundo loadFile falla siempre con ERR_FAILED (un problema conocido de Electron 33).
const CANVAS = 1240;
let _win = null;

async function ensureWindow() {
  if (_win) return _win;
  _win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  _win.setContentSize(CANVAS, CANVAS);
  await _win.loadFile(path.join(__dirname, 'logo.html'));
  try {
    await _win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  } catch (_) { /* Las versiones antiguas no tienen la API fonts; nos apoyamos en la espera de abajo */ }
  await new Promise((r) => setTimeout(r, 900));
  return _win;
}

async function render(layout, w, h) {
  const win = await ensureWindow();
  await win.webContents.executeJavaScript(
    `document.body.classList.remove('layout-square','layout-wide','layout-splash');`
    + `document.body.classList.add('layout-${layout}');true;`
  );
  await new Promise((r) => setTimeout(r, 700));
  const full = nativeImage.createFromBuffer((await win.webContents.capturePage()).toPNG());
  const got = full.getSize();
  if (got.width < w || got.height < h) {
    console.log(`  [Aviso] El lienzo ${got.width}x${got.height} es menor que ${w}x${h}; se usará escalado`);
    return full.resize({ width: w, height: h, quality: 'best' });
  }
  const x = Math.round((got.width - w) / 2);
  const y = Math.round((got.height - h) / 2);
  return full.crop({ x, y, width: w, height: h });
}

function resized(img, w, h) {
  return img.resize({ width: w, height: h, quality: 'best' }).toPNG();
}

app.whenReady().then(async () => {
  console.log('Renderizando icono principal (square 1024)…');
  const square = await render('square', SQ, SQ);

  console.log('Renderizando mosaico ancho (wide 620x300)…');
  const wide = await render('wide', 620, 300);

  console.log('Renderizando pantalla de inicio (splash 1240x600)…');
  const splash = await render('splash', 1240, 600);

  // Versión mosaico: recortar el margen transparente alrededor del icono principal para que el mosaico ocupe todo el lienzo y evitar que el icono se vea pequeño en el menú Inicio
  const tileBox = { x: TILE_PAD, y: TILE_PAD, width: SQ - TILE_PAD * 2, height: SQ - TILE_PAD * 2 };
  const tile = square.crop(tileBox);
  const tileSize = tile.getSize();
  console.log(`Zona de mosaico del icono principal ${tileSize.width}x${tileSize.height} (recortado del centro de 1024)`);

  console.log('\nSalidas de imágenes de marca:');
  save(path.join(DOCS, 'logo.png'), square.toPNG());
  save(path.join(UI, 'logo.png'), resized(square, 512, 512));
  save(path.join(UI, 'logo-256.png'), resized(square, 256, 256));
  save(path.join(UI, 'logo-128.png'), resized(square, 128, 128));
  save(path.join(UI, 'logo-64.png'), resized(square, 64, 64));

  console.log('\nSalidas de imágenes de bandeja (icono simplificado):');
  for (const s of [16, 20, 24, 32]) {
    save(path.join(UI, `tray-${s}.png`), drawAppIcon(s));
  }

  console.log('\nSalidas ICO (16–48 icono simplificado / 64–256 icono principal):');
  const icoEntries = [];
  for (const s of [16, 20, 24, 32, 40, 48]) icoEntries.push({ size: s, buf: drawAppIcon(s) });
  for (const s of [64, 128, 256]) icoEntries.push({ size: s, buf: resized(tile, s, s) });
  const ico = icoFrom(icoEntries);
  save(path.join(UI, 'appicon.ico'), ico);

  console.log('\nSalidas de recursos para la tienda:');
  save(path.join(STORE, 'StoreLogo.png'), drawAppIcon(50));
  save(path.join(STORE, 'Square44x44Logo.png'), drawAppIcon(44));
  save(path.join(STORE, 'Square71x71Logo.png'), drawAppIcon(71));
  save(path.join(STORE, 'Square150x150Logo.png'), resized(tile, 150, 150));
  save(path.join(STORE, 'Square310x310Logo.png'), resized(tile, 310, 310));
  save(path.join(STORE, 'Wide310x150Logo.png'), resized(wide, 310, 150));
  save(path.join(STORE, 'SplashScreen.png'), resized(splash, 620, 300));

  console.log('\nCompletado. Resumen de verificación:');
  const check = [
    ['logo-256.png', 256, 256], ['tray-16.png', 16, 16], ['tray-32.png', 32, 32],
    ['StoreLogo.png', 50, 50], ['Square44x44Logo.png', 44, 44], ['Square71x71Logo.png', 71, 71],
    ['Square150x150Logo.png', 150, 150], ['Square310x310Logo.png', 310, 310],
    ['Wide310x150Logo.png', 310, 150], ['SplashScreen.png', 620, 300],
  ];
  let bad = 0;
  for (const [name, w, h] of check) {
    const p = [UI, STORE].map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
    const s = p ? pngSize(fs.readFileSync(p)) : null;
    const ok = !!s && s.w === w && s.h === h;
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'OK  ' : 'BAD '} ${name} ${s ? `${s.w}x${s.h}` : 'missing'} (esperado ${w}x${h})`);
  }
  const icoBuf = fs.readFileSync(path.join(UI, 'appicon.ico'));
  const icoCount = icoBuf.readUInt16LE(4);
  console.log(`  ${icoCount === 9 ? 'OK  ' : 'BAD '} appicon.ico ${icoCount} tamaños`);
  app.exit(bad === 0 && icoCount === 9 ? 0 : 1);
}).catch((e) => {
  console.error('Error al generar:', e);
  app.exit(1);
});
