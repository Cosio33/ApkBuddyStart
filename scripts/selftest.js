'use strict';
/**
 * Autocomprobación del runtime (sin abrir la interfaz)
 *
 *   npm run selftest                 # Solo revisar el runtime existente
 *   npm run selftest -- --apk a.apk  # Recorrer además instalación → inicio → captura → directorio compartido
 *
 * Finalidad: con Android instalado, confirmar con un solo comando que la cadena "instalar con doble clic, ventana independiente, datos compartidos"
 * funciona de verdad en esta máquina y, si hay problemas, localizar el paso concreto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Vacío = seguir la ruta del producto, iniciar automáticamente el runtime integrado y usar un serial dinámico; solo se conecta un dispositivo externo si se especifica
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nAutocomprobación del runtime de ApkBuddyStart');
  console.log(`Dispositivo:${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Componentes]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb disponible', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('adb no está instalado; ejecuta primero el "despliegue en un clic"');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator listo', async () => {
    if (!env.emulator.ok) throw new Error('El motor del runtime no está instalado; ejecuta primero el "despliegue en un clic"');
    return `v${env.emulator.version}`;
  });
  await step('Imagen de sistema completa', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'Falta la imagen');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('Aceleración por hardware', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'Se usa emulación por software de forma automática (funciona, pero es mucho más lenta)');

  console.log('\n[Dispositivo]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime listo', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`El dispositivo externo no está en línea: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'Runtime no disponible');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nEl dispositivo no está listo; se omiten los siguientes casos.');
  } else {
    await step('Versión de Android', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('No se puede leer la versión del sistema');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Resolución de pantalla', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size no devolvió nada');
      return `${s.width}×${s.height}`;
    });
    await step('Ventana independiente freeform', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('No se puede activar freeform (el sistema quizá no admite varias ventanas)');
      return 'Activado';
    });

    console.log('\n[Directorio compartido]');
    await step('Sincronización bidireccional', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('Equipo → dispositivo: sin sincronización');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('Dispositivo → equipo: sin sincronización');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'Subida y bajada correctas';
    });

    if (APK) {
      console.log('\n[Cadena de la aplicación]');
      let meta = null;
      await step('Analizar APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('Instalar en el dispositivo', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path no encontró el paquete');
          return 'pm path verificado correctamente';
        });
        await step('Inicio en ventana independiente', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('La aplicación no está en primer plano');
          return meta.package;
        });
        await step('Captura de pantalla', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('El contenido de la captura es anómalo');
          return file;
        });
      }
    } else {
      console.log('\n[Cadena de la aplicación] No se especificó --apk; se omite');
    }
  }

  // Hay que detener el runtime iniciado por la autocomprobación: si no, las tuberías stdio del proceso hijo emulator
  // mantienen el bucle de eventos de Node activo y el comando parece "colgarse"
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Resultado:${results.filter((r) => r.ok === true).length} correctos, ${failed.length} fallidos, `
    + `${results.filter((r) => r.ok === null).length} omitidos`);
  if (failed.length) {
    console.log('Casos fallidos:');
    failed.forEach((f) => console.log(`  · ${f.name}: ${f.detail}`));
    process.exit(1);
  }
  console.log('Todas las comprobaciones pasaron ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nLa autocomprobación terminó con un error:', e.message);
  process.exit(1);
});
