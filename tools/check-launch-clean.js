'use strict';
/**
 * Verificación de extremo a extremo de que "al abrir una aplicación de Android solo se ve su ventana":
 *   1) Iniciar el ApkBuddyStart real con APPDATA aislado e instalar un APK de prueba con `--apk` (esto inicia el emulador);
 *   2) Abrir la aplicación con `--launch <nombre del paquete>`;
 *   3) Enumerar durante todo el proceso las ventanas visibles de nivel superior: la principal del emulador (Android Emulator - …) y las consolas de qemu / netsimd
 *      no deben aparecer; la ventana de la aplicación sí debe aparecer (indica que el embed funcionó y la imagen está dentro de la ventana).
 *
 * Uso: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Igual que las otras dos pruebas de ventana, admite indicar por fuera el runtime y el directorio de datos (el runtime del usuario suele estar en la unidad D)
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`No se encontró el APK de prueba: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) Instalación ----
  console.log('— Instalando el APK (el primer inicio del emulador es en frío, unos 40~90 s)…');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* Aún no se ha escrito */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `Instalación completada: ${pkg || '(tiempo agotado)'}`);
  // Hay que esperar a que la primera instancia **termine de verdad** antes de iniciar la segunda: si sigue el bloqueo de instancia única, la segunda sale enseguida,
  // y el síntoma es que "la ventana nunca aparece", en lugar de un fallo de inicio (ya ocurrió y costó mucho depurarlo).
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nResultado: fallido (no se instaló ninguna aplicación; se omiten los pasos siguientes)');
    process.exit(1);
  }

  // ---- 2) Abrir la aplicación ----
  console.log('— Abriendo la aplicación…');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Arranque en frío 23 s + inicio de la app ~17 s: se dejan 120 s; antes, 60 s daban falsos fallos en máquinas lentas
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Ventanas anómalas visibles:`, JSON.stringify(hit));
    }
    // Ventana de la aplicación = una ventana normal con título que no sea del emulador ni una consola
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/ApkBuddyStart|WorkBuddy|Microsoft|Program Manager|Configuración|Edge|Experiencia de entrada/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Apareció la ventana de la aplicación`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `Las ventanas del emulador/la consola permanecieron ocultas (${leaked} apariciones acumuladas)`);
  check(sawAppWin, `Apareció la ventana de la aplicación (la imagen está incrustada en ella, no en una ventana de emulador aparte)`);
  console.log('  Títulos de ventanas visibles:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- Final de app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(no hay app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  El sandbox se conserva en: ${sandbox}`);
  }
  console.log('');
  console.log(`Resultado: ${pass ? 'correcto' : 'fallido'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
