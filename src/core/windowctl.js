'use strict';
/**
 * Disfrazar la ventana Qt de Android Emulator como «una ventana nativa por aplicación».
 *
 * Por qué no hacer duplicación de pantalla: en modo sin cabeza, SurfaceFlinger no emite VSYNC
 * (en pruebas, screenrecord capturó solo 2 fotogramas en 3 segundos); la duplicación por software
 * es lenta y consume CPU. El emulador con ventana ya ofrece 60 fps nativos + ratón y teclado
 * nativos; aquí solo se hacen unas pocas operaciones Win32 («cambiar título / cambiar icono /
 * fijar tamaño / pantalla completa») con un coste casi nulo.
 *
 * PowerShell es un componente incluido en Windows; el script es ASCII puro y los títulos en chino
 * se pasan mediante JSON UTF-8, para evitar que Windows PowerShell 5.1 lea el .ps1 como ANSI y
 * producezca caracteres corruptos. Cualquier fallo se degrada silenciosamente: la ventana sigue
 * siendo utilizable, solo que sin el cambio de nombre / pantalla completa.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `apkstart-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

/** Lee la posición actual de la ventana, para «recordar el tamaño de ventana de cada aplicación» */
async function getBounds(pid) {
  const r = await call({ pid, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * Hace que la ventana del runtime se comporte como la aplicación actual.
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, label, icon, mode, bounds, screen } = o || {};
  // pid=0 es una entrada válida: al reutilizar un emulador iniciado por otro proceso no hay
  // identificador, así que se deja que el script busque la ventana por nombre de proceso
  if (pid === undefined || pid === null) return null;
  return call({
    pid,
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid) { return call({ pid, action: 'focus' }); }

/** Avisa al Explorador para que actualice iconos/accessos directos, evitando que haya que pulsar F5 para ver el nuevo icono de escritorio */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };
