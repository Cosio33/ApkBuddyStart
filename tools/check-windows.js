'use strict';
/**
 * Verificación de ventanas: iniciar emulator como lo hace el proceso principal y confirmar que "no aparece ninguna ventana sobrante en el escritorio".
 *
 * Hay que vigilar dos tipos de ventanas:
 *   1. "Android Emulator - apkstart5554"(QWindowIcon, ventana principal del emulador)
 *      — normalmente solo debe aparecer como ventana hija de la nuestra tras el embed y nunca verse en el escritorio;
 *   2. Ventana negra de consola (ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS de conhost)
 *      — qemu y netsimd abren una cada uno, con la ruta del exe iniciado como título.
 *
 * Uso: node tools/check-windows.js [runtimeRoot]
 *   runtimeRoot por defecto es engine/ del repositorio (runtime descargado localmente); también se puede pasar el directorio
 *   resources/runtime de la instalación.
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// Directorio del runtime: argumento de línea de comandos > variable de entorno > engine/ del repositorio
const ROOT = path.resolve(process.argv[2] || process.env.APKSTART_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// El AVD puede estar en otra unidad (runtime.avdDir en la configuración), algo habitual entre usuarios; aquí también se admite indicarlo explícitamente
const AVD_HOME = process.env.APKSTART_AVD_HOME
  || path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // El agente solo actúa sobre ventanas creadas por procesos del directorio del runtime: hay que declarar primero el ámbito o no ocultará nada
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('Supresión permanente activada');

  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Ventanas anómalas visibles:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('probe (las ventanas ocultas también deben encontrarse):', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('Ventanas anómalas que siguen en el escritorio al terminar:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // Se admite que aparezcan y se oculten en menos de 400 ms, pero al final deben ser 0
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`Resultado: ${ok ? 'correcto' : 'fallido'} (ventanas anómalas visibles acumuladas: ${leaked}; al terminar: ${left.length})`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
