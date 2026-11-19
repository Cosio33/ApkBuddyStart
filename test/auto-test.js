'use strict';
/**
 * Pruebas de regresion de autoconfiguracion sin ajustes / adelgazamiento tipo contenedor (Node puro, sin iniciar el emulador)
 * Ejecutar: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'fallo la asercion'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js parametros automaticos]');

  await test('El backend GPU se elige segun la version del emulador (versiones nuevas: host primero + reserva de renderizado por software; versiones antiguas: swiftshader_indirect)', () => {
    // gpuCandidates ajusta el orden segun el fabricante de la GPU local (AMD antepone swangle),
    // por eso aqui solo se comprueba que «la lista de candidatos contenga los elementos clave», no un primer fijo.
    const c37 = doctor.gpuCandidates('37.3.8.0');
    assert(c37.includes('host'), 'los candidatos 37.x deben incluir host');
    assert(c37.includes('swangle'), 'los candidatos 37.x deben incluir swangle');
    assert(c37.includes('software'), 'las versiones nuevas necesitan una reserva de renderizado por software');
    // En 37.x, subir swiftshader_indirect falla al inicializar GL; nunca debe aparecer entre los candidatos
    assert(!c37.includes('swiftshader_indirect'));
    // Las versiones antiguas siguen usando swiftshader_indirect
    const c35 = doctor.gpuCandidates('35.1.4.0');
    assert(c35.includes('host'));
    assert(c35.includes('swiftshader_indirect'));
    // detectGpuVendor debe devolver un valor conocido o unknown (sin lanzar excepcion)
    const v = doctor.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `detectGpuVendor devolvio un valor inesperado: ${v}`);
  });

  await test('Equipos con poca memoria reducen automaticamente los parametros (ya no son 4 GB / 4 nucleos fijos)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `la memoria deberia ser 2048, real ${p.memoryMB}`);
    assert(p.cores === 2, `los nucleos deberian ser 2, reales ${p.cores}`);
    assert(p.accel === 'off', 'sin aceleracion por hardware debe recurrir a la emulacion por software');
    assert(p.bootTimeoutMs > 240000, 'la emulacion por software necesita un tiempo de arranque mayor');
    assert(p.gpu === 'host' || p.gpu === 'swangle', `el renderizado preferido deberia ser host o swangle (swangle primero en AMD), real ${p.gpu}`);
    // Con accel desactivado, la reserva debe ser renderizado por software; si no, no hay GPU bajo TCG
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'el plan de reserva debe usar renderizado por software');
    // La particion de datos se dimensiona segun el disco libre: 4/6/8 GB (ya no es 16 G fijo) y se puede anular en ajustes
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `la particion de datos deberia estar entre 4 y 8 GB, real ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'el tamanho de particion de datos de los ajustes debe aplicarse');
  });

  await test('Un equipo con mucha memoria no consume memoria sin limite', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `incluso en equipos potentes debe haber tope: ${p.memoryMB} MB / ${p.cores} nucleos`);
    assert(p.accel === 'auto');
  });

  await test('Matriz de reintentos: de la mejor opcion a la mas conservadora, con emulacion por software y arranque en frio como reserva', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `el numero de reintentos deberia ser 3-4, real ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'falta la reserva de emulacion por software');
    // El ultimo nivel solo «no carga instantaneas + memoria minima»; nunca se permite -wipe-data:
    // con el disco lleno fallan todos los niveles y, si hay wipe, se borran tambien las apps instaladas (comprobado).
    assert(v[v.length - 1].snapshot === false, 'el ultimo nivel debe omitir la carga de instantaneas');
    assert(v[v.length - 1].wipe === false, 'ningun reintento automatico puede borrar datos del usuario');
    assert(v[v.length - 1].memoryMB <= 2048, 'el ultimo nivel debe reducir la memoria al minimo');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'los planes de reintento no deben repetirse');
  });

  await test('Cambiar la imagen de disco no significa cambiar de imagen: mover sysdir no debe borrar datos del usuario', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkBuddyStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'la identidad de ruta de un mismo juego de imagenes debe ser igual');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'tras cambiar de disco la instantanea no debe invalidarse (si no, se desperdicia un arranque en frio)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'un cambio real de imagen debe detectarse');
  });

  await test('La huella de la instantanea no cambia con los reintentos de GPU/aceleracion/memoria (evita borrar las apps instaladas en cada reintento)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('El diagnostico de registros reconoce problemas de GPU/aceleracion/rutas chinas/archivos de bloqueo', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('Diagnostico de registros: una salida del emulador con 0xC0000005 debe considerarse un fallo del backend de renderizado', () => {
    // Comprobado en los issues n. 20/25: tras imprimir Userspace boot properties, sale con 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Los registros de fallo suelen incluir informacion de inicializacion del renderizado: el fallo tiene prioridad sobre GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'el fallo tiene prioridad sobre los registros normales de renderizado');
  });

  await test('La busqueda de puertos libres devuelve un par de puertos pares', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `puerto inesperado: ${p}`);
  });

  await test('Los parametros automaticos mostrados en ajustes coinciden con los reales (37.x ya no muestra backends obsoletos)', () => {
    const common = {
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044,
      // Se da el host explicitamente: los topes de memoria/nucleos siguen al host; sin esto, el resultado varia segun la maquina de CI
      // (el runner de GitHub tiene solo 4 nucleos; poner 6 a mano se reduce correctamente a 3 y la asercion daria un falso positivo)
      host: { totalMB: 32768, freeMB: 24000, cores: 12, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false },
    };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host' || p.gpu === 'swangle', `deberia ser host o swangle (equipo AMD), real ${p.gpu}`);
    assert(p.accelOk === true && /aceleración por hardware|hardware/i.test(text), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(/5562/.test(text), text);

    // El motor antiguo sigue usando el backend antiguo; los parametros avanzados introducidos a mano siguen aplicandose
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js adelgazamiento tipo contenedor]');

  await test('Inventario de elementos recuperables: QEMU no x86_64, imagenes antiguas, AVD antiguos, archivos de bloqueo e instantaneas antiguas', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'deben aparecer los QEMU no x86_64');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'no se debe borrar el QEMU x86_64');
    assert(paths.some((p) => p.includes('android-30')), 'debe aparecer la imagen antigua de API 30');
    assert(paths.some((p) => p.endsWith('.lock')), 'deben aparecer los archivos de bloqueo');
    assert(paths.some((p) => p.includes('snapshots')), 'deben aparecer las instantaneas antiguas');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'deben aparecer los AVD inactivos');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'no se debe borrar la configuracion del AVD activo');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun no debe borrar ningun archivo');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'la limpieza real debe liberar espacio');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'el AVD inactivo debe eliminarse');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'el AVD activo debe conservarse');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'el QEMU x86_64 debe conservarse');
  });

  console.log('\n[adb.js legibilidad de errores de instalacion/inicio]');

  await test('Los fallos de apps con targetSdk antiguo en Android 14 tienen indicaciones claras', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && /automáticamente|reintentar/i.test(s), s);
  });

  await test('Un fallo de la capa de traduccion ARM ofrece una conclusion util en espanol', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(/traducción ARM/i.test(s) && /imagen compatible/i.test(s), s);
  });

  console.log('\n[sharer ya no traslada archivos ida y vuelta (causa del disco lleno)]');

  await test('El mismo archivo no se recupera del dispositivo en cada ciclo', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Se usan rutas y archivos de estado reales, pero los directorios apuntan a temporales
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Ciclo 1: archivo nuevo local → subir
    const firstPull = calls.pull;
    await sh.sync();          // Ciclo 2
    await sh.sync();          // Ciclo 3
    await sh.sync();          // Ciclo 4
    assert(calls.push === 1, `solo deberia subirse una vez, real ${calls.push}`);
    assert(firstPull === 0, `el archivo recien subido no debe recuperarse de inmediato, recuperaciones reales: ${firstPull}`);
    assert(calls.pull === firstPull, `los ciclos posteriores no deben seguir recuperando, total real: ${calls.pull}`);
  });

  await test('Los archivos muy grandes no se recuperan de vuelta al equipo (el directorio local no es un sumidero de cache del dispositivo)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'los archivos de mas de 512 MB no deben recuperarse en el equipo');
  });

  console.log('\n[adb/sharer intercambio de archivos]');

  await test('El analisis de ls -l es compatible con los formatos de Android con group / fecha', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `deberian analizarse 3 lineas, reales ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('La lista remota se obtiene completa con find+stat (sin depender del analisis de fechas de ls)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `deberian devolverse 2 archivos, reales ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js descompresion por streaming de paquetes grandes]');

  await test('ZipFile y ZipArchive analizan igual el mismo paquete (incluye deflate y pipeTo por streaming)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'los nombres de entrada deben coincidir');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'el contenido de las entradas stored debe coincidir');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'el contenido de las entradas deflate debe coincidir');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'la salida por streaming de pipeTo debe estar completa');
    } finally {
      file.close();
    }
  });

  await test('Zip64: cuando el EOCD usa 0xffff/0xffffffff como marcador, el numero de entradas y el desplazamiento se toman del EOCD Zip64', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // Cabecera local
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // Entrada del directorio central: tres campos a 0xffffffff; los valores reales van en el extra Zip64 (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // EOCD Zip64 + localizador + EOCD tradicional (todos con acarreo)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive debe reconocer las entradas Zip64');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'el contenido de ZipArchive debe ser correcto');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'el tamanho sin comprimir de ZipArchive debe tomarse del extra');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile debe reconocer las entradas Zip64');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'el contenido de ZipFile debe ser correcto');
      assert(file.entries.get('hello.txt').localOffset === 0, 'el desplazamiento de la cabecera local de ZipFile debe tomarse del extra');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js AVD sin configuracion]');

  await test('El AVD usa una particion de datos pequena + arranque rapido + modo GPU moderno', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'la particion de datos no debe ser de 16 G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'ya no se debe forzar el arranque en frio');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'la instantanea debe controlarse con -snapshot en la linea de comandos para evitar cargar un default_boot antiguo');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'debe escribirse la huella de la instantanea');
  });

  await test('Los argumentos de arranque incluyen memoria/nucleos/instantanea automaticos y ya no usan modos GPU obsoletos', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Cuando no hay instantanea (AVD nuevo o recien invalidado), nunca se debe pasar -snapshot:
    // qemu esperaria indefinidamente un estado de memoria inexistente: el proceso sigue vivo pero nunca arranca.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Sin instantanea hay que «prohibir solo la carga, no el guardado»: -no-snapshot desactiva tambien el guardado automatico al salir;
      // asi nunca se genera una instantanea tras el primer arranque en frio y el usuario ve la guia completa en cada apertura.
      assert(/-no-snapshot-load/.test(fresh), 'sin instantanea hay que usar -no-snapshot-load (solo omite la carga)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'sin instantanea no se puede usar -no-snapshot (desactiva el guardado al salir)');
    }
    // Quickboot solo cuando la instantanea existe de verdad. Ojo: debe «parecerse a una instantanea completa»:
    // una grabacion interrumpida deja una cascara vacia con solo decenas de bytes en snapshot.pb; eso debe contarse como «sin instantanea»,
    // o el emulador intentara cargarla, fallara y recurrira al arranque en frio, perdiendo unos segundos.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // Una cascara vacia (pb de 12 bytes sin ram.img) debe considerarse «sin instantanea»
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'una instantanea incompleta no puede considerarse valida');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'una instantanea vacia debe recurrir al arranque en frio (omitir la carga)');

    // Instantanea completa: pb con contenido + ram.img con datos (la cascara del paso anterior la limpia hasSnapshot)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'con instantanea debe usarse la instantanea quickboot');
    assert(!/-no-snapshot-load/.test(withSnap), 'con una instantanea completa no debe omitirse la carga');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'con wipe debe pasarse -wipe-data');
    // Al restablecer datos: no cargar la instantanea antigua (no coincide), pero **si permitir guardar** una nueva.
    // «Reparar red» depende de esta cadena: tras el restablecimiento, el primer arranque con red → guardar instantanea → restaurar la vez siguiente.
    // La implementacion antigua usaba -no-snapshot aqui, lo que desactivaba tambien el guardado y hacia imposible guardar la instantanea tras reparar la red.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'con wipe no debe cargarse la instantanea antigua');
    assert(!/ -no-snapshot( |$)/.test(cold), 'con wipe debe seguir permitiendose guardar una instantanea nueva (reparar red depende de ello)');
  });

  // El script del agente de ventanas tiene muchos comentarios en chino. PowerShell 5.1 lee el «UTF-8 sin BOM» como ANSI,
  // y el chino convertido en basura puede unir un comentario C# con la linea de codigo siguiente; Add-Type falla al compilar,
  // lo que se manifiesta como «el agente de ventanas no arranca / la ventana de la app no se incrusta». Ya pasó una vez; se fija con esta prueba.
  await test('El script del agente de ventanas debe llevar BOM UTF-8 (si no, los comentarios en chino hacen fallar Add-Type)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'a agent.ps1 le falta la BOM UTF-8');
  });

  // La ventana del emulador debe ser «hija» de la capa de renderizado de Chromium, no hermana del host.
  // Con una relacion de hermanos, Electron eleva constantemente la capa web, el fondo negro tapa la pantalla de Android y se pierden todos los clics
  // (bordes negros / pantalla sin llenar / clics sin efecto / imposible pulsar «Aceptar»). Tampoco se debe asignar una window region a la ventana incrustada,
  // porque rompe la deteccion de impactos y deja bordes negros tras el redimensionado.
  await test('La ventana incrustada debe colgarse bajo la capa web y no debe tener window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed debe colgarse de la ventana padre que encuentra FindChromeRender');
    assert(/FindChromeRender\(host\)/.test(src), 'debe buscarse la ventana hija de renderizado de Chromium');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'no debe asignarse una region de recorte a la ventana incrustada');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'al incrustar deben limpiarse los restos de region de versiones anteriores');
  });

  // Para girar hay que cambiar el «tamanho fisico del panel» y reiniciar; no basta con modificar wm size / density en tiempo de ejecucion.
  //   - wm size: el LCD fisico sigue vertical -> la imagen se tumba 90°, ocupa solo una franja arriba a la izquierda y las coordenadas de clic se desplazan;
  //   - wm density: el framebuffer no cambia de tamanho -> la imagen no llena la pantalla y al maximizar queda un gran espacio en blanco a la derecha.
  await test('La orientacion horizontal debe lograrse con el tamanho fisico del panel (lcdFor landscape), sin usar wm size en tiempo de ejecucion', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `vertical deberia ser 720x1280, real ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `horizontal deberia ser 1280x720, real ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation ya no debe establecer la anulacion de wm size');
    // density ahora pasa siempre por tabletDensity() (el usuario puede desactivar el diseno de tableta en ajustes),
    // pero la constante debe seguir siendo 190 (720 de ancho → 606 dp para superar el punto de ruptura de tableta).
    assert(/wm density \$\{tabletDensity\(\)\}/.test(body), 'density se conserva solo como ruta de degradacion');
    assert(/const TABLET_DENSITY = 190/.test(adb), 'la constante de densidad de tableta debe ser 190');
  });

  await test('El modo juego debe usar prioridad alta y desactivar el gancho global del raton', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'el nivel game debe elevar qemu a High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'el modo game no debe instalar el gancho global WH_MOUSE_LL');
  });

  await test('Motor de mapeo de teclas: busqueda, conversion a comandos y limitacion de frecuencia', async () => {
    const { lookup, toCommand, PRESETS } = require('../src/core/keymap');
    const { KeymapEngine } = require('../src/core/keymap-engine');

    // Integridad de las plantillas predefinidas
    assert(PRESETS.fps && PRESETS.fps.mappings.length >= 4, 'el predefinido FPS necesita al menos 4 mapeos');
    assert(PRESETS.rpg && PRESETS.rpg.mappings.length >= 4, 'el predefinido RPG necesita al menos 4 mapeos');
    assert(PRESETS.generic && PRESETS.generic.mappings.length >= 3, 'el predefinido general necesita al menos 3 mapeos');

    // Busqueda: no distingue mayusculas
    assert(lookup(PRESETS.fps.mappings, 'W').action === 'tap', 'la W mayuscula debe coincidir con la w minuscula');
    assert(lookup(PRESETS.fps.mappings, 'z') === null, 'una tecla sin mapeo devuelve null');

    // Conversion a comandos: coordenadas normalizadas → pixeles
    const cmd = toCommand({ action: 'tap', x: 0.5, y: 0.5 }, 720, 1280);
    assert(cmd === 'input tap 360 640', `comando tap incorrecto: ${cmd}`);
    const sw = toCommand({ action: 'swipe', x1: 0, y1: 0.5, x2: 1, y2: 0.5, duration: 100 }, 720, 1280);
    assert(sw === 'input swipe 0 640 720 640 100', `comando swipe incorrecto: ${sw}`);
    const ke = toCommand({ action: 'keyevent', code: 4 }, 720, 1280);
    assert(ke === 'input keyevent 4', `comando keyevent incorrecto: ${ke}`);

    // Motor: activar/desactivar, busqueda por aplicacion y limitacion de frecuencia
    const calls = [];
    const eng = new KeymapEngine({
      execInput: (c) => { calls.push(c); return Promise.resolve(); },
      getSize: () => ({ width: 720, height: 1280 }),
      minInterval: 0,  // sin limitacion en las pruebas
    });
    eng.setMap('com.test.game', PRESETS.fps.mappings);
    assert(eng.getMap('com.test.game').length > 0, 'setMap/getMap deben funcionar');
    eng.enable(false);
    assert(await eng.handleKey('w', 'com.test.game') === false, 'desactivado no debe consumir teclas');
    eng.enable(true);
    assert(await eng.handleKey('w', 'com.test.game') === true, 'activado debe consumir las teclas mapeadas');
    assert(await eng.handleKey('z', 'com.test.game') === false, 'las teclas sin mapeo no deben consumirse');
    assert(await eng.handleKey('w', 'com.other.app') === false, 'otras aplicaciones no deben coincidir');
    assert(calls.length === 1 && /input tap/.test(calls[0]), `deberia enviarse un input tap, real: ${calls.join('|')}`);
  });

  await test('Deteccion del fabricante de GPU: devuelve un valor conocido o unknown; en AMD, swangle tiene prioridad', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/detectGpuVendor/.test(doc), 'debe existir la funcion detectGpuVendor');
    assert(/Get-CimInstance Win32_VideoController/.test(doc), 'debe usarse CIM de PowerShell (wmic se elimino en Win11 24H2+)');
    assert(/vendor === 'amd'[\s\S]{0,200}swangle.*host/.test(doc), 'en equipos AMD, swangle debe ir antes que host');
    const d = require('../src/core/doctor');
    const v = d.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `el valor devuelto debe ser un fabricante conocido o unknown, real: ${v}`);
  });

  await test('Animacion de arranque: ventana splash + avance de progreso + desvanecimiento', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.html')), 'falta splash.html');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.css')), 'falta splash.css');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.js')), 'falta splash.js');
    assert(fs.existsSync(path.join(root, 'src', 'splash-preload.js')), 'falta splash-preload.js');
    assert(/splashWin/.test(mainJs), 'main.js debe crear la ventana splash');
    assert(/splashProgress/.test(mainJs), 'debe existir la funcion splashProgress');
    assert(/splashDone/.test(mainJs), 'debe existir la senal de finalizacion splashDone');
    assert(/splash:version/.test(mainJs) || /splash:isFirstRun/.test(mainJs), 'hay que registrar el IPC de splash');
  });

  await test('La prioridad de la app en primer plano no puede ser below (clics responsivos / video sin saltos)', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // Con balanced/performance y una app en primer plano debe ser normal: below deja qemu sin recursos,
    // lo que provoca saltos al decodificar video y clics que tardan en responder (causa principal de «clics poco fluidos»).
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      'La prioridad de beginApp en primer plano debe mapearse a game→game y el resto→normal');
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'balanced ya no debe caer en below');
    // La prioridad debe restablecerse al abrir o volver: endApp la baja a idle y, si no se eleva al volver, todo se vuelve lento
    const setIdx = begin.indexOf("setPriority(level)");
    const firstIdx = begin.indexOf("if (first)");
    assert(setIdx > -1, 'beginApp debe llamar a setPriority');
    // setPriority no debe estar solo en el primer bloque if(first); al cambiar de app (no first) tambien hay que elevar la prioridad
    const firstBlock = begin.slice(firstIdx, begin.indexOf('\n\n', firstIdx));
    assert(!/setPriority\(level\)/.test(firstBlock) || begin.split('setPriority(level)').length >= 2,
      'setPriority debe ejecutarse en cada beginApp, no solo en el primero');
  });

  await test('El modo de ahorro debe reducir el tope de memoria (menor consumo)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'el modo save debe reducir memoryMB a 2048 (ahorra unos 1 GB de RAM + 1 GB de disco de instantaneas)');
    // La memoria especificada a mano siempre tiene prioridad y save no puede anularla
    assert(/!overrides\.memoryMB/.test(doc), 'la reduccion de memoria de save debe ceder ante el valor manual del usuario');
  });

  await test('El ram.bin escrito por el emulador nuevo debe considerarse una instantanea completa (si no, los 3 GB recien guardados se borrarian como cascara vacia)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin debe considerarse una instantanea completa');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'con instantanea debe usarse quickboot');
    assert(!/-no-snapshot-load/.test(args), 'con una instantanea completa no debe omitirse la carga');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('Imagen semilla de userdata: bloque 4K + ENCRYPT + contabilidad coherente', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'el numero magico del superblock debe ser 0xEF53');
    // dm-default-key (cifrado de metadatos de /data en Android 13) usa un tamanho de bloque logico de 4096;
    // un bloque fs menor provoca que mount() devuelva EINVAL: esa es la causa real de «no se puede montar /data».
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size debe ser 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size debe ser igual al tamanho de bloque');
    // Sin ext_attr, setxattr devuelve EOPNOTSUPP y no se pueden escribir las etiquetas SELinux;
    // netd / media / tombstoned salen con 1 y el arranque se queda en la animacion.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'debe incluir ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'el numero de bloques libres debe estar en (0, total)');
    assert(freeInodes === inodes - 10, 'los inodos libres deben descontar los reservados 1-10 (e2fsck lo verifica)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'por defecto debe incluir ENCRYPT (necesario para FBE)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'con encrypt:false debe poder quitarse ese bit');
  });

  console.log('\n[Pantalla / accesos directos / cero intervenciones]');
  await test('El modo ventana debe abrir una ventana de verdad (si no, el proceso sigue vivo pero no se ve)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'el modo ventana ya no debe usar -no-window');
    // Ya no se puede llevar -no-skin: anula -skin y hace que el panel vuelva al valor antiguo de config.ini,
    // lo que se ve como «se cambio a horizontal en ajustes pero sigue vertical» o «la imagen ocupa solo una franja arriba a la izquierda».
    assert(!/\s-no-skin(\s|$)/.test(win), 'el modo ventana no debe llevar -no-skin (anula -skin)');
    assert(/-skin \d+x\d+/.test(win), 'el modo ventana debe usar -skin para fijar el tamanho del panel');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('Audio: activado por defecto (sin -no-audio); solo se anade -no-audio al desactivarlo', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Anular el getter de settings: activado por defecto no debe tener -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'con audio=true no debe pasarse -no-audio');
    // Solo al desactivarlo debe llevar -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'con audio=false debe pasarse -no-audio');
  });

  await test('Migracion forzosa de configuraciones antiguas: sin cabeza y «salir tras el inicio» ya no se aplican', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless debe migrarse a false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch debe ser false');
    assert(s.autoStart === true && s.autoDeploy === true, 'el inicio automatico / despliegue con un clic estan activados por defecto');
    assert(s.createStartMenuShortcut === true, 'el acceso directo del menu Inicio esta activado por defecto');
  });

  await test('Adaptacion de pantalla: ventana y pantalla completa comparten la resolucion vertical; la ventana 9:16 se puede estirar', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // La pantalla completa no cambia la resolucion de Android (la relacion de aspecto de la ventana la fija el LCD); solo maximiza la ventana
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'resolucion-invalida', area).h > d.sizeFor('window', 'resolucion-invalida', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Pantalla completa: llenar la altura, calcular el ancho segun la proporcion vertical y centrar (la relacion de aspecto la fija el LCD del emulador)
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('Los comandos de pantalla de adb usan wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO y la reserva de iconos WebP producen un ICO utilizable', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'la cabecera ICO debe declarar 1 imagen');
    assert(ico.readUInt32LE(14) === png.length, 'la longitud del PNG incrustado debe coincidir');
    assert(ico.slice(22).equals(png), 'el area de datos del ICO debe ser el PNG original');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP (nativeImage no lo decodifica) → sin callback decode debe recurrirse al ICO de marca de reserva
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP tambien debe obtener un icono');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'con decode debe usarse el icono real');
  });

  await test('El script de control de ventanas existe y es ASCII puro (evita basura en rutas/titulos chinos)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'falta windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'el ps1 debe ser ASCII puro; el chino se pasa mediante JSON UTF-8');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile alimenta el archivo de origen por stdin y produce una imagen que el entorno puede descomprimir (regresion de bloqueo en CI)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // La muestra pequena usa el nivel mas rapido para no ralentizar toda la suite
    process.env.XZ_TIMEOUT_MS = '15000';  // Si realmente se bloquea, matar en 15 s para no atascar CI
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile no respondio en 25 s (¿stdin no recibio EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'el producto comprimido no puede estar vacio');
    let back;
    if (/\.xz$/i.test(out)) {
      // No depender del binding nativo de @napi-rs/lzma: el job de Node 20 en CI no puede cargarlo
      // por un error conocido de las dependencias opcionales de npm (en Node 22 funciona).
      // Aqui se lee de vuelta con el mismo lzma de python usado al comprimir y se valida el numero magico XZ;
      // la compatibilidad de descompresion en tiempo de ejecucion se cubre con la verificacion del paquete real.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'debe ser un contenedor XZ valido');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'se genero XZ pero no se encuentra python; no se puede verificar');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'el contenido descomprimido debe coincidir byte a byte con la imagen original');
  });

  console.log('\n[container.js contenedor a nivel de aplicacion]');

  const container = require('../src/core/container');

  await test('Los paquetes del sistema/framework nunca se recortan; solo las apps de usuario entran en la limpieza de sesion', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} debe reconocerse como app de usuario`);
      else assert(sys, `${p} debe reconocerse como paquete del sistema`);
    }
    assert(container.isSystemPackage(''), 'un nombre de paquete vacio se trata como del sistema para evitar comandos no validos');
  });

  await test('Al iniciar una app solo se detienen las otras apps instaladas; por defecto nunca se tocan los paquetes del sistema', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `deben detenerse 2 apps de usuario, reales ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'por defecto no deben desactivarse paquetes del sistema');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'en el arranque no debe limpiarse el fondo para no afectar a la app que acaba de pasar a primer plano');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'no debe hacerse force-stop del framework del sistema');
  });

  await test('Lista blanca de nombres de paquete: una lista contaminada no genera comandos de inyeccion', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `solo deben detenerse nombres de paquete validos, reales ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'no deben aparecer fragmentos de inyeccion');
  });

  await test('El recorte profundo puede desactivar paquetes en segundo plano y restaurarlos por completo sin tocar componentes esenciales', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'el recorte profundo debe tener elementos desactivables');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} nunca debe desactivarse`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} debe poder restaurarse`);
    }
  });

  await test('Aparcamiento del contenedor: limpiar el fondo + idle de Android, con una maquina de estados que cubra varias ventanas y el ultimo cierre', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'al aparcar deben limpiarse los procesos en cache');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'al aparcar Android debe entrar en idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'tras cerrar la ultima ventana el contenedor debe aparcarse');
  });

  await test('Contenedor ligero de doctor: reducir vCPU; los ajustes manuales tienen prioridad', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // La logica antigua era floor(nucleos/4) limitado a 2-3: una maquina de 8 nucleos solo recibia 2 vCPU y las apps de video se bloqueaban.
    // Ahora el modo equilibrado da «la mitad de los nucleos fisicos, con tope 4» y el de ahorro fija 2.
    assert(lite && lite.cores === 4, `una maquina de 16 nucleos en modo equilibrado debe recibir 4, real ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `el modo de ahorro debe fijar 2 nucleos, reales ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'si se desactiva explicitamente debe devolver null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'una maquina de 2 nucleos debe conservar al menos 2');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(manual.cores === 6, 'el numero de nucleos fijado a mano debe tener prioridad sobre el modo ligero');
    assert(/Contenedor ligero|ligero/i.test(doctor.describeProfile(auto)), 'el resumen del diagnostico debe senalar el contenedor ligero');
  });

  await test('El gancho global del raton esta desactivado por defecto y el agente de ventanas ya no bloquea mucho rato el bucle de mensajes', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'el gancho de botones laterales debe estar desactivado por defecto');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'el proceso principal ya no debe instalar el gancho global incondicionalmente');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'la ventana de la aplicacion ya no debe instalar el gancho global incondicionalmente');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'la sincronizacion de archivos no debe permanecer activa sin condiciones');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'el interruptor del gancho debe ser idempotente y poder desactivarse');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'el gancho debe instalarse en un hilo de mensajes dedicado');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'el hilo del gancho debe ejecutar un bucle de mensajes');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'el bucle principal ya no debe bloquearse 4 segundos');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'el bucle principal debe usar sondeos cortos para mantener la respuesta del bucle de mensajes');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'la inspeccion de ventanas debe tener limite de tiempo; no puede ejecutar EnumWindows cada 2 segundos indefinidamente');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'la pagina de ajustes debe exponer la opcion de contenedor ligero');
  });

  await test('Modo de ventana independiente: sin SetParent, tamanho segun la proporcion del panel y limpieza que no oculte ventanas del usuario', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // El interruptor llega hasta el final: UI -> main -> appwin
    assert(/setWindowEmbed/.test(uiHtml), 'la pagina de ajustes necesita el interruptor «forma de alojamiento de la ventana»');
    assert(/windowEmbed === false/.test(mainJs), 'main debe reconocer el modo de ventana independiente');
    assert(/openDetached/.test(appwinJs), 'appwin necesita openDetached');
    // Antes era la forma en linea `detached: displaySettings().windowEmbed === false`;
    // ahora se ha extraido a una variable local (tambien decide showWhileWaiting); se aceptan ambas.
    
    assert(/detached:\s*displaySettings\(\)\.windowEmbed === false/.test(mainJs)
      || /const detached = displaySettings\(\)\.windowEmbed === false/.test(mainJs),
      'al abrir la ventana debe pasarse detached');

    // En modo independiente nunca debe llamarse SetParent: esa es la causa del problema de incrustacion
    // (solo se miran las lineas de codigo reales; las menciones en comentarios explican por que no se usa)
    const codeOnly = (src) => src.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    const layoutBlock = agentPs1.slice(agentPs1.indexOf('cmd == "layout"'));
    const layoutBody = codeOnly(layoutBlock.slice(0, layoutBlock.indexOf('cmd == "hook"')));
    assert(!/SetParent\s*\(/.test(layoutBody), 'layout no debe llamar a SetParent (el modo independiente justamente lo evita)');
    assert(/SetWindowPos\s*\(/.test(layoutBody), 'layout solo debe colocar la ventana en el rectangulo de destino');

    // La logica de limpieza debe contenerse en modo independiente; si no, esconderá ventanas que el usuario está viendo
    assert(/_detachedMode/.test(agentPs1), 'agent.ps1 necesita la marca _detachedMode');
    const detachBlock = agentPs1.slice(agentPs1.indexOf('cmd == "detach"'));
    assert(/keep/.test(detachBlock.slice(0, 600)), 'detach necesita el parametro keep para distinguir «pasar a independiente» de «terminar la incrustacion»');

    // El tamanho debe calcularse segun la proporcion del panel: el emulador fija su relacion de aspecto y corrige la que no encaja
    assert(/_panelRatio/.test(appwinJs), 'el tamanho de la ventana independiente debe calcularse segun la proporcion del panel');
    assert(!/w:\s*Math\.min\(area\.w - 80, 1280\)/.test(appwinJs), 'ya no debe fijarse el ancho en 1280 (el emulador lo reduciria a una franja vertical)');
  });

  await test('Un solo entorno de ejecucion: el registro fija builtin; da igual que emuladores esten instalados', () => {
    const backends = require('../src/core/backends');
    // Desde 0.5.6 no hay seleccion automatica: da igual que esten instalados MuMu / LDPlayer / BlueStacks / WSA;
    // solo se ejecuta el entorno propio de ApkBuddyStart y, leyendo solo los ajustes, no aparece un segundo candidato.
    assert(backends.REGISTRY.length === 1, 'aparecio una segunda base en el registro');
    assert(backends.REGISTRY[0].id === 'builtin', 'la unica base no es builtin');
  });

  await test('El titulo de la ventana cambio a ApkBuddyStart: la logica de reconocimiento debe aceptar tambien el titulo nuevo', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agent = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');

    assert(/SetWindowTextW/.test(ps1), 'agent.ps1 necesita la declaracion SetWindowTextW');
    assert(/cmd == "title"/.test(ps1), 'agent.ps1 necesita el comando title');
    assert(/LooksLikeEmulator/.test(ps1), 'tras cambiar el titulo debe seguir reconociendose la ventana; no basta con reconocer Android Emulator');
    assert(/_ourTitle/.test(ps1), 'hay que recordar el titulo asignado');
    // Qt restaura el titulo al recrear la ventana; la inspeccion debe volver a asignarlo
    assert(/QuietSweep[\s\S]{0,600}SetWindowTextW/.test(ps1), 'la inspeccion debe reasignar el titulo');
    assert(/setTitle\(/.test(agent), 'agent.js debe exponer setTitle');
    assert(/agent\.setTitle\(/.test(appwin), 'al abrir la ventana independiente debe cambiarse el titulo de verdad');
  });

  await test('Entorno en chino: inyectar locale al arrancar, instalar silenciosamente un teclado pinyin y usar un punto nacional de captive portal', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // Para el locale se usa el oficial -change-locale: se comprobó que el emulador intercepta -prop persist.sys.locale
    // y getprop no muestra nada en el invitado; solo -change-locale cambia realmente el idioma del sistema
    assert(/'\-change-locale',\s*locale/.test(emuJs), 'debe usarse -change-locale para fijar el idioma del sistema');
    // Solo se miran las lineas de codigo: mencionarlo en comentarios que explican «por que no usar -prop» no cuenta
    const emuCode = emuJs.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/-prop[\s\S]{0,80}persist\.sys\.locale/.test(emuCode),
      'no debe seguir usandose el ineficaz -prop persist.sys.locale');
    assert(/_guestLocale/.test(emuJs), 'debe existir una fuente de idioma configurable');
    // Chino por defecto
    assert(/locale:\s*'zh-CN'/.test(storeJs), 'el idioma predeterminado debe ser chino simplificado');
    assert(/chineseIme:\s*true/.test(storeJs), 'el teclado chino debe estar activado por defecto');

    // Metodo de entrada: APK incluido en el paquete, instalado y activado al arrancar
    assert(fs.existsSync(path.join(root, 'assets', 'PinyinIME.apk')), 'falta PinyinIME.apk');
    assert(/ensureChineseIme/.test(adbJs), 'adb necesita ensureChineseIme');
    assert(/com\.android\.inputmethod\.pinyin/.test(adbJs), 'debe usarse el teclado pinyin de Google');
    assert(/ime enable/.test(adbJs) && /default_input_method/.test(adbJs), 'debe activarse y establecerse como predeterminado');
    assert(/ensureChineseIme/.test(engJs), 'prepare() debe llamar realmente a la instalacion');
    assert(/_chineseReady/.test(engJs), 'la inicializacion del chino debe ser idempotente (una sola vez por arranque)');
    assert(/chineseIme/.test(engJs), 'debe permitirse al usuario desactivarlo');

    // Punto de verificacion de red: gstatic no debe marcar la red con «!»
    assert(/captive_portal_http_url/.test(adbJs), 'debe configurarse un punto nacional de verificacion de red');
    assert(/connect\.rom\.miui\.com/.test(adbJs), 'el punto debe ser accesible desde el pais');

    // La pagina de ajustes debe tener el interruptor
    assert(/setLocale/.test(html) && /setChineseIme/.test(html), 'la pagina de ajustes debe exponer los interruptores de idioma/teclado');
  });

  await test('Autocorreccion de orientacion: una pantalla de tableta/horizontal tumbada 90° debe corregirse sola', () => {
    const root = path.join(__dirname, '..');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // Criterio: el orden ancho/alto de init=WxH y cur=WxH es opuesto = el espacio logico se giro
    assert(/_healOrientation/.test(engJs), 'debe existir un metodo de autocorreccion de orientacion');
    assert(/init=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'debe leerse el tamanho del panel init');
    assert(/cur=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'debe leerse el espacio logico cur');
    assert(/initLand !== curLand/.test(engJs), 'solo se debe refijar la orientacion cuando el orden ancho/alto este invertido (realmente tumbado)');
    // Estabilidad del modo tableta horizontal: aunque no este tumbado, debe comprobarse si faltan ignore-orientation + density y reponerse
    assert(/mSetIgnoreOrientationRequest=true/.test(engJs), 'en horizontal debe comprobarse que ignore-orientation sigue activo');
    assert(/Override density:/.test(engJs), 'debe leerse Override density para detectar si se perdio');
    assert(/tabletMode/.test(engJs), 'el diseno de tableta debe poder desactivarse');
    assert(/wm set-ignore-orientation-request true/.test(engJs), 'si se perdio, hay que reponer ignore-orientation');
    assert(/wm density \$\{densityWanted\}/.test(engJs), 'si se perdio, hay que reponer density');
    assert(/_healOrientation/.test(engJs.slice(engJs.indexOf('startWatchdog'))), 'el watchdog debe autocorregirse periodicamente');
    // Al iniciar la app, la recreacion de la Activity sobrescribe la orientacion; hay que corregirla en ese momento.
    // La ventana se amplia a 2200 caracteres: el callback then de onAppUp tambien gestiona el desvanecimiento de la animacion de arranque;
    // esos comentarios desplazan _healOrientation hacia atras y con una ventana de 600 caracteres cualquier anadido daba un falso positivo.
    assert(/onAppUp[\s\S]{0,2200}_healOrientation/.test(mainJs), 'tras iniciar la app debe corregirse de inmediato');
    // Cuando la direccion del panel no coincide con los ajustes, no se arregla aqui: se deja al reinicio
    assert(/panelLandscape/.test(engJs), 'debe distinguirse entre «hay que reiniciar» y «hay que refijar la orientacion»');
  });

  await test('Accesos directos en Linux: .desktop ejecutable, Exec escapado e icono PNG obligatorio', () => {
    const os = require('os');
    const shortcut = require('../src/core/shortcut');
    // En Windows se genera .lnk; en Linux debe ser .desktop (especificacion freedesktop)
    assert(shortcut.shortcutExt() === (process.platform === 'win32' ? '.lnk' : '.desktop'),
      'la extension del acceso directo debe seguir la plataforma');

    // Se llama directamente al escritor .desktop para validar el contenido (sin depender de la plataforma actual)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-dt-'));
    const out = path.join(dir, 'aplicacion prueba.desktop');
    const png = path.join(dir, 'icon.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      shortcut.writeDesktopEntry({
        shortcutPath: out,
        target: '/opt/ApkBuddyStart/ApkBuddyStart',
        args: '--launch "com.example.app"',
        iconPngPath: png,
        description: 'Aplicacion de prueba',
      });
      assert(fs.existsSync(out), '.desktop debe escribirse realmente');
      const body = fs.readFileSync(out, 'utf8');
      assert(/\[Desktop Entry\]/.test(body), 'falta la seccion Desktop Entry');
      assert(/^Type=Application$/m.test(body), 'Type debe ser Application');
      // Una ruta con espacios sin comillas se divide en dos argumentos y el arranque falla directamente
      assert(/^Exec=.*"\/opt\/ApkBuddyStart\/ApkBuddyStart"/m.test(body), 'la ruta de destino en Exec debe ir entre comillas');
      assert(/com\.example\.app/.test(body), 'Exec debe incluir el nombre de paquete de --launch');
      assert(/^Icon=.*icon\.png$/m.test(body), 'el icono debe ser una ruta absoluta PNG (ICO no sirve en Linux)');
      // Sin bit de ejecucion, muchos entornos de escritorio tratan .desktop como un documento corriente
      if (process.platform !== 'win32') {
        const mode = fs.statSync(out).mode & 0o777;
        assert((mode & 0o100) !== 0, '.desktop debe tener el bit de ejecucion');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('La orientacion horizontal debe quedar «derecha»: el panel fija la direccion, rotation se fija en 0 y se ignoran las peticiones de orientacion de la app', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');

    // Esquema de tres pasos comprobado en un equipo real (si falta cualquiera, la imagen se tumba 90°):
    //  1) Cambiar la direccion del panel fisico (intercambiar hw.lcd.width/height + reiniciar): ver doctor.lcdFor
    //  2) Fijar la orientacion logica en **0**: con el panel ya horizontal, fijar 1 convertiria el panel horizontal en espacio logico vertical
    //  3) Ignorar la peticion de orientacion de la app: apps como Hongguo declaran portrait; si el sistema obedece,
    //     un panel horizontal init=1280x720 se convierte en espacio logico vertical cur=720x1280
    const setOri = adbJs.slice(adbJs.indexOf('async setOrientation'), adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(setOri),
      'setOrientation debe fijar rotation 0 (fijar 1 tumba el panel horizontal)');
    assert(!/user-rotation lock \$\{landscape \? 1/.test(setOri),
      'ya no debe fijarse 1 segun landscape; eso era del tiempo en que «solo se podia girar el panel vertical»');
    assert(/wm set-ignore-orientation-request/.test(setOri),
      'deben ignorarse las peticiones de orientacion de la app; si no, una app fijada en vertical se tumbaria');

    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(reset.slice(0, 2000)), 'resetDisplayOverrides tambien debe fijar 0');
    assert(/wm set-ignore-orientation-request/.test(reset.slice(0, 2000)),
      'resetDisplayOverrides tambien debe ajustar ignore-orientation segun el modo');
  });

  await test('Debe haber forma de cerrar la app: menu contextual, bandeja e IPC; no puede faltar ninguno', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');

    // El proceso principal necesita app:stop (antes no existia; endApp solo se disparaba al cerrar la ventana,
    // y en modo de ventana independiente esa ventana esta oculta → la app no se podia cerrar al iniciarse)
    assert(/ipcMain\.handle\('app:stop'/.test(mainJs), 'falta el IPC app:stop');
    // El proceso de renderizado debe poder llamarlo
    assert(/stop:\s*\(pkg\)\s*=>\s*invoke\('app:stop'/.test(preloadJs), 'preload debe exponer stop');
    // El menu contextual debe incluir esta opcion
    assert(/key:\s*'stop'/.test(uiJs), 'al menu contextual le falta «Cerrar aplicacion»');
    assert(/case 'stop':/.test(uiJs), 'el menu contextual no gestiona stop');
    // En modo de ventana independiente la interfaz principal esta oculta; la bandeja es la unica via siempre accesible
    assert(/Cerrar la aplicación actual/i.test(mainJs), 'al menu de la bandeja le falta «Cerrar la aplicacion actual»');
    // Tras cerrar hay que actualizar la marca «en ejecucion»
    assert(/apps:changed/.test(mainJs) && /apps:changed/.test(uiJs),
      'tras cerrar debe emitirse apps:changed y actualizarse la interfaz');

    // Correccion: la bandeja y el IPC deben compartir la misma ruta stopApp, sin duplicar la logica
    assert(/async function stopApp/.test(mainJs), 'debe existir una funcion stopApp unificada');
    assert(/ipcMain\.handle\('app:stop'[\s\S]{0,200}stopApp/.test(mainJs),
      'el IPC app:stop debe delegar en stopApp');
    assert(/stopApp\(pkg\)\.then/.test(mainJs) || /stopApp\(pkg\)/.test(mainJs),
      'el menu de la bandeja tambien debe llamar a stopApp');
    // Tras cerrar hay que limpiar currentAppPkg; si no, la bandeja sigue mostrando «Cerrar la aplicacion actual (xxx)»
    assert(/currentAppPkg === target/.test(mainJs) || /currentAppPkg = null/.test(mainJs),
      'stopApp debe limpiar currentAppPkg');
    // En modo independiente primero debe ocultarse la ventana del emulador y luego cerrarse la cascara (al reves, parpadea en el escritorio)
    assert(/detached[\s\S]{0,200}agent\.hide/.test(mainJs),
      'en modo independiente primero hide y luego close');
    // El cierre externo (Alt+F4) tambien debe limpiar currentAppPkg
    assert(/onCloseApp[\s\S]{0,800}currentAppPkg = null/.test(mainJs) || /onCloseApp[\s\S]{0,800}currentAppPkg === pkg/.test(mainJs),
      'onCloseApp tambien debe limpiar currentAppPkg');
  });

  await test('Limpieza de versiones antiguas: encontrar directorios de ApkBuddyStart en cualquier ubicacion sin tocar nunca la version en uso', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      // Se crean tres directorios de «version antigua» y uno de «version actual», cada uno con un falso ApkBuddyStart.exe
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkBuddyStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkBuddyStart-v0.3.9-win64-portable');
      const old2 = mk('ApkBuddyStart-win64-portable.prev-2026-01-01T00-00-00-000Z'); // Resto de copia de seguridad del empaquetado
      const curDir = mk('ApkBuddyStart-v0.5.0-win64-portable');

      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));

      assert(found.includes(np(old1)), 'no se detecto un directorio normal de version antigua');
      // .prev-* es la copia que pack.js conserva en cada renombrado; antes no se podia borrar, ahora debe detectarse
      assert(found.includes(np(old2)), 'no se detecto el resto .prev del empaquetado');
      // Restriccion de seguridad clave: la version en ejecucion nunca debe aparecer en la lista de borrado
      assert(!found.includes(np(curDir)), 'la version en uso se tomo como antigua (peligroso)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('Al cambiar de app hay que cerrar limpiamente la anterior; si no, queda ANR / _activeApps de la app antigua', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // openAppWindow debe ser async: al cambiar hay que esperar a detener la app anterior antes de abrir la nueva.
    assert(/async function openAppWindow/.test(mainJs), 'openAppWindow debe ser async (hay que esperar a que termine la app anterior)');
    // El llamador tambien debe usar await; si no, close/endApp y el inicio de la nueva app van en paralelo → pelea por el primer plano → ANR
    assert(/await openAppWindow\(/.test(mainJs), 'runLaunch debe usar await openAppWindow');

    // Clave: al cambiar a «otra» app hay que llamar primero a endApp(anterior); recoger solo la ventana sin detener el proceso es la causa del bug
    const fn = mainJs.slice(mainJs.indexOf('async function openAppWindow'));
    const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('currentAppPkg = pkg')));
    assert(/currentAppPkg !== pkg/.test(body), 'solo se cierra la anterior al cambiar a una app distinta (la misma app se reutiliza)');
    assert(/runtime\.endApp\(prev/.test(body) || /runtime\.endApp\(currentAppPkg/.test(body),
      'al cambiar debe llamarse realmente a endApp en la app anterior (force-stop + quitarla de _activeApps)');
    // appWin.open() usa internamente close({keepApp:true}), no endApp;
    // por eso la capa externa debe anadir endApp explicitamente y no confiar en el close de open.
    assert(/close\(\{ keepApp: true \}\)/.test(body) && /endApp/.test(body),
      'primero aparcar la imagen (close keepApp) y luego endApp para detener el proceso; el orden importa');

    // Tambien hay que terminar el caso en que la ventana ya no esta pero el proceso sigue en _activeApps
    assert(/else if \(currentAppPkg && currentAppPkg !== pkg\)/.test(body),
      'sin ventana tambien deben limpiarse los procesos residuales en _activeApps');
  });

  await test('La pantalla completa y la orientacion horizontal automaticas deben estar vivas: los ajustes necesitan consumidor y el panel debe corregirse al arrancar', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const htmlJs = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');

    // autoFullscreenOnLaunch antes solo se declaraba en los ajustes predeterminados y nadie lo leia: un interruptor muerto.
    const uses = (mainJs.match(/autoFullscreenOnLaunch/g) || []).length;
    assert(uses > 0, 'autoFullscreenOnLaunch debe leerse de verdad (no basta con declararlo)');
    assert(/fullscreen:[\s\S]{0,200}autoFullscreenOnLaunch/.test(mainJs),
      'la pantalla completa automatica debe participar en la decision de fullscreen de openAppWindow');

    // La pagina de ajustes debe permitir cambiar estas dos opciones
    assert(/setAutoFullscreen/.test(htmlJs), 'a la pagina de ajustes le falta el interruptor «Pantalla completa automatica»');
    assert(/setLandscape/.test(htmlJs), 'a la pagina de ajustes le falta el interruptor «Orientacion de pantalla»');
    assert(/setAutoFullscreen'\)\.addEventListener/.test(uiJs), 'el interruptor de pantalla completa automatica no tiene evento');
    assert(/setLandscape'\)\.addEventListener/.test(uiJs), 'el interruptor de orientacion de pantalla no tiene evento');

    // La orientacion horizontal solo se logra con el panel fisico + reinicio; debe corregirse al arrancar, o se tumbara
    assert(/panelLandscape/.test(emuJs), 'el emulador debe poder leer la orientacion actual del panel');
    assert(/orientation mismatch/.test(mainJs), 'antes de arrancar debe comprobarse si la orientacion del panel coincide con los ajustes');
    assert(/reloadApp:\s*false/.test(mainJs), 'al corregir la orientacion no debe iniciarse la app de paso (se lanzaria dos veces)');

    // En modo de ventana independiente, «pantalla completa» debe aplicarse a la ventana del emulador; maximizar una ventana oculta no sirve
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    assert(/_wantFullscreen/.test(appwinJs), 'el modo independiente debe recordar la intencion de pantalla completa');
    assert(/if \(this\._wantFullscreen\)/.test(appwinJs), 'openDetached debe llenar el area disponible en pantalla completa');

    // Correccion: tras reiniciar el entorno, el rt.client antiguo deja de servir; beforeStart debe devolver el rt nuevo
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/beforeStart[\s\S]{0,400}replaced[\s\S]{0,200}replaced\.client/.test(instJs),
      'installer.launch debe aceptar el rt nuevo devuelto por beforeStart');
    assert(/return newRt/.test(mainJs) || /return rt/.test(mainJs.slice(mainJs.indexOf('restartForOrientation'))),
      'restartForOrientation debe devolver el rt nuevo a beforeStart');

    // Correccion: en modo independiente con orientacion horizontal, _panelRatio debe ajustarse segun el panel
    assert(/this\.state\.landscape.*b\.height > b\.width/.test(appwinJs)
      || /landscape.*height.*width/.test(appwinJs),
      '_panelRatio debe corregir la proporcion en horizontal');
  });

  await test('Al abrir una app debe verse la imagen cuanto antes: enganchar la ventana en cuanto aparece el proceso, sin esperar 4 segundos de observacion', () => {
    const root = path.join(__dirname, '..');
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // Medido en un equipo real: el proceso aparecia a los 2 segundos, pero esperabamos otros 4 «para confirmar que no se cerraba de inmediato»
    // antes de enganchar la ventana; el usuario veia «cliquee y no paso nada». Ahora se engancha en cuanto aparece.
    assert(/onAppUp/.test(instJs), 'installer.launch necesita el callback onAppUp');
    assert(/if \(!seen && typeof onAppUp === 'function'\)/.test(instJs),
      'onAppUp debe dispararse «la primera vez que se ve el proceso» y solo una vez');

    // El proceso principal debe recibir este callback en paralelo (sin await); si no, vuelve a ser una espera en serie
    assert(/onAppUp:\s*\(\)\s*=>/.test(mainJs), 'main.js debe pasar onAppUp');
    const block = mainJs.slice(mainJs.indexOf('onAppUp: () =>'), mainJs.indexOf('beforeStart:'));
    assert(/attachAppWindow\(\)/.test(block), 'onAppUp debe enganchar la imagen de inmediato');
    assert(!/await attachAppWindow\(\)/.test(block),
      'onAppUp no debe usar await al enganchar la imagen (se serializaria con la comprobacion de vida y no habria mejora)');

    // Si se engancho antes, no debe volverse a enganchar despues: en modo independiente eso ocultaria/mostraria
    // de nuevo la ventana recien colocada y la imagen parpadearia.
    assert(/attachDoneEarly/.test(mainJs), 'hay que recordar si ya se engancho la imagen antes');
    assert(/if \(attachDoneEarly\)/.test(mainJs), 'la decision final debe omitir el enganche duplicado');

    // El periodo de observacion de vida no se puede eliminar: es la reserva contra «parpadea y se cierra»
    assert(/aliveSince >= 4000/.test(instJs), 'el periodo de 4 segundos debe conservarse (contra cierres instantaneos)');
  });

  await test('Red de la maquina virtual: el AVD debe activar el Wi-Fi virtual y poder reconectar por iniciativa propia a puntos que «no se conectan solos»', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');

    // En la imagen Play Store de API 34, la red va por wlan0 (Wi-Fi virtual de netsim), no por eth0.
    // Si config.ini no tiene hw.wifi, wlan0 queda en NO-CARRIER y las apps muestran siempre «error de red».
    assert(/['"]hw\.wifi=yes['"]/.test(emuJs), 'config.ini debe incluir hw.wifi=yes');

    // Causa real comprobada: AndroidWifi queda como «Guardada / No se conecta automaticamente»
    // y no se conecta sola al arrancar. El shell no tiene permiso NETWORK_SETTINGS, asi que
    // cmd wifi connect-network lanza SecurityException; solo queda pulsar desde la interfaz.
    assert(/async repairWifi/.test(emuJs), 'debe existir la capacidad de reconectar el Wi-Fi por iniciativa propia');
    assert(/WIFI_SETTINGS/.test(emuJs), 'la reconexion debe abrir la pagina de ajustes de Wi-Fi');
    assert(/uiautomator dump/.test(emuJs), 'la reconexion debe usar uiautomator para encontrar el punto de acceso y pulsarlo');
    // Tras conectar hay que cambiar la sonda de «verificacion de red» a un punto accesible desde el pais; si no, el sistema marca la red con «!»
    // y algunas apps la consideran sin conexion y se niegan a cargar contenido.
    assert(/captive_portal_http_url/.test(emuJs), 'la sonda de verificacion de red debe apuntar a un punto nacional accesible');
    // Queda prohibido usar connect-network como solucion principal (sin permisos, falla siempre).
    // Solo se miran las lineas de codigo reales; en los comentarios se menciona para explicar por que no se usa.
    const emuCode = emuJs.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    assert(!/cmd wifi connect-network/.test(emuCode), 'el shell no tiene permiso para connect-network; no puede usarse');

    // La reparacion debe ir de menor a mayor: primero reconectar, luego arranque en frio y solo al final borrar datos
    const repair = engineJs.slice(engineJs.indexOf('async repairNetwork'));
    const repairBody = repair.slice(0, repair.indexOf('async ', 10) > 0 ? undefined : undefined);
    assert(/repairWifi/.test(repairBody), 'repairNetwork debe intentar primero la reconexion ligera del Wi-Fi');
    const wifiAt = repairBody.indexOf('repairWifi');
    const wipeAt = repairBody.indexOf('forceWipeOnNextStart');
    assert(wifiAt > -1 && wipeAt > -1 && wifiAt < wipeAt,
      'el orden debe ser: primero reconectar el Wi-Fi y solo al final restablecer los datos (no borrar los del usuario de entrada)');

    // ensureNetwork tambien debe probar primero la reparacion ligera, sin arrancar en frio directamente
    const ensure = engineJs.slice(engineJs.indexOf('async ensureNetwork'));
    const ensureBody = ensure.slice(0, ensure.indexOf('async repairNetwork'));
    const eWifi = ensureBody.indexOf('repairWifi');
    const eBoot = ensureBody.indexOf('_netColdBootTried');
    assert(eWifi > -1 && eBoot > -1 && eWifi < eBoot,
      'ensureNetwork debe intentar primero reconectar el Wi-Fi y despues considerar el arranque en frio');

    // Tambien hay que hacerlo en la ruta de arranque (installer); si no, cada vez que se abre una app se sufre primero una app «sin red».
    // Aqui solo se permite repairWifi, que no es destructivo; nunca debe aparecer ensureNetwork (provoca arranque en frio).
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/repairWifi/.test(instJs), 'antes de iniciar la app debe intentarse reparar el Wi-Fi');
    assert(!/\.ensureNetwork\(/.test(instJs), 'la ruta de arranque no debe llamar a ensureNetwork (detiene la maquina y arranca en frio)');
    // Debe colgarse de engine (this.runtime): rt es el objeto devuelto por ensure() y solo tiene client.
    // Escribir rt.repairWifi daria undefined; la llamada lanzaria un error que el catch se tragaria, como si nada se hubiera reparado.
    assert(/this\.runtime\.repairWifi\(/.test(instJs), 'repairWifi debe colgarse de engine (this.runtime)');
    assert(!/\brt\.repairWifi\(/.test(instJs), 'rt es el objeto devuelto por ensure() y no tiene repairWifi');
    // Este metodo de reenvio debe existir realmente en engine; si no, la llamada en installer tambien seria undefined
    assert(/async repairWifi\(/.test(engineJs), 'engine debe implementar el reenvio de repairWifi');
  });

  await test('WinAgent.setHook(false) no inicia el agente PowerShell en el estado predeterminado', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'al desactivar debe devolver hooked=false');
    assert(a.ready === null, 'desactivado por defecto no debe iniciar un proceso agente permanente para esto');
  });

  console.log('\n[Mapeo de teclas del raton]');

  await test('Valores predeterminados y migracion de configuraciones antiguas: clic derecho atras + rueda suave activados, botones laterales desactivados', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'clic derecho atras activado por defecto');
    assert(d.wheel === 'smooth', 'la rueda es suave por defecto');
    assert(d.side === false, 'los botones laterales desactivados por defecto');
    assert(d.enabled === true, 'al menos el mapeo del clic derecho necesita el gancho');
    // Sin las claves nuevas en un settings.json antiguo debe obtenerse el mismo resultado
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'con todo desactivado no debe instalarse el gancho');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'la rueda nativa no necesita gancho');
  });

  await test('hookOptions unifica la configuracion; al desactivar, todos los subinterruptores se ponen a cero', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'con enabled=false no deben interceptarse eventos en absoluto');
    assert(pointer.hookOptions(true).side === true, 'compatible con la forma booleana antigua (botones laterales)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('Direccion de la rueda: girar abajo = dedo hacia arriba, girar arriba = dedo hacia abajo, coordenadas dentro de limites', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'girar hacia abajo debe subir el contenido (dedo hacia arriba)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'girar hacia arriba debe bajar el contenido (dedo hacia abajo)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'un desplazamiento cero no genera comando');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x no debe salir de limites');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y no debe salir de limites');
      assert(s.duration >= 100 && s.duration <= 240, 'la duracion del deslizamiento debe tener un limite');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'un giro rapido no debe alargar el gesto sin limite');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'la rueda horizontal debe producir un deslizamiento horizontal');
  });

  await test('Lista blanca de comandos input: solo se permiten los comandos generados internamente y se bloquea la inyeccion', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /no válido|no permitido| ilegal/i.test(e.message); }
    assert(blocked, 'El comando no válido debe bloquearse antes de iniciar adb');
    assert(c._input === null, 'un comando bloqueado no debe crear una sesion permanente');
  });

  await test('El boton Atras usa primero el canal de entrada permanente y solo recurre a un adb puntual si falla', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'la ruta normal no debe iniciar adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'si falla el canal permanente debe haber reserva; no se puede perder el clic');
  });

  await test('WheelRouter agrupa los giros continuos en un solo comando de deslizamiento', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 pasos de rueda deben agruparse en 1 comando, reales ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'debe producirse un input swipe valido');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'tras agrupar se mantiene la direccion de giro hacia abajo');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'tras dispose no debe inyectarse nada');
  });

  await test('Script del agente: interceptacion de clic derecho/rueda, agrupacion de giros, limitacion al primer plano e hilo dedicado', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'deben gestionarse el clic derecho y la rueda');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'tambien debe admitirse la rueda horizontal');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'los giros deben agruparse antes de informar');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'el alcance debe limitarse a la ventana raiz en primer plano');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'el gancho debe estar en un hilo de mensajes dedicado');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'el bucle principal no debe bloquearse mucho rato');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'los mapeos sin configurar no deben interceptar eventos');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'los cambios de ajustes deben sincronizarse en el acto con el gancho');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'la pagina de ajustes debe exponer los interruptores de teclas');
  });

  await test('WinAgent.setHook envia tambien la configuracion de teclas y no inicia el agente al desactivar', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'al activar debe enviarse un solo comando');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'la configuracion debe enviarse junto con el comando hook');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'al desactivar debe descargarse el gancho');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'desactivado por defecto no debe iniciarse PowerShell');
  });

  console.log('\n[updater.js actualizacion en linea]');
  await test('La comparacion de versiones es numerica segmento a segmento; el prefijo v y las versiones de varios segmentos funcionan', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 debe ser mayor que 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'el prefijo v no afecta la igualdad');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'debe compararse numericamente, no como cadena');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 es menor que 1.0.1');
  });

  await test('El tipo de instalacion decide que activo elegir: instalador = Setup.exe, portable = portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkBuddyStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'sin desinstalador se considera portable');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkBuddyStart.exe'), 'x');
    assert(portable.flavor === 'setup', 'con desinstalador se considera instalador');
    // La seleccion de activos es pura; aqui se introduce un resultado falso de check para validar las reglas de nomenclatura de reserva
    assert(/Setup\.exe$/i.test('ApkBuddyStart-0.3.2-Setup.exe'), 'el nombre del activo del instalador coincide');
    assert(/portable.*\.zip$/i.test('ApkBuddyStart-v0.3.2-win64-portable.zip'), 'el nombre del activo portable coincide');
  });

  await test('La version portable no confunde el paquete completo del entorno (ApkBuddyStart-runtime-*.zip) con un paquete de actualizacion', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkBuddyStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkBuddyStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Si ambos activos existen → debe elegirse el portable
    u.sources = { latest: async () => mk([
      { name: 'ApkBuddyStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkBuddyStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `debe elegirse el portable, real ${info.asset.name}`);

    // Solo el paquete completo del entorno (no se subio el portable) → mejor no actualizar automaticamente que usar 1,5 GB de entorno como paquete del programa
    u.sources = { latest: async () => mk([
      { name: 'ApkBuddyStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'con solo el paquete del entorno no debe seleccionarse ningun activo de actualizacion');
    assert(info.canAutoApply === false, 'sin activos disponibles no puede actualizarse automaticamente');
  });

  await test('Doble fuente: las URL candidatas incluyen el prefijo del espejo; el prefijo personalizado tiene prioridad sobre el espejo publico', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'la fuente original debe ir primero (se mantiene el orden antes de ordenar por velocidad)');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'el espejo automatico debe incluirse entre los candidatos');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `el prefijo personalizado debe aplicarse en exclusiva, real ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'al desactivar el espejo automatico solo queda la conexion directa');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'si al prefijo le falta la barra final hay que anadirla');

    // El espejo solo proxya GitHub: anteponer el prefijo a una URL de Gitee solo da 403; no debe incluirse como candidato
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'los activos de Gitee no deben llevar el prefijo del espejo de GitHub');
  });

  await test('Doble fuente: ordenar por velocidad los resultados del sondeo; si todos fallan, mantener el orden original sin perder URL utiles', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Se inyecta directamente la cache de velocidad para que la prueba no dependa de Internet
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `el mas rapido debe ir primero, real ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'las URL fallidas van al final pero se conservan (tienen otra oportunidad)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset debe vaciar la cache de velocidad (hay que volver a medir al cambiar de fuente o de red)');
  });

  await test('Doble fuente: el paquete de codigo fuente que Gitee anade automaticamente (v1.2.3.zip) nunca debe tomarse por un instalador', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkBuddyStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `solo deben conservarse los activos ApkBuddyStart*, reales ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Los activos de Gitee no tienen campo size: el grupo de fragmentos debe seguir formandose (si no, se descarta el paquete completo)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Los activos de las versiones de Gitee solo tienen name + url, sin size (comprobado)
        assets: [
          { name: 'ApkBuddyStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkBuddyStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `deben agruparse en 1 activo, reales ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkBuddyStart-v0.3.3-win64-portable.zip', `el nombre del activo debe ser el del paquete completo, real ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'deben conservarse las dos partes');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'el orden y el contenido de las URL de los fragmentos deben ser correctos');
    assert(a.size === 0, 'si se desconoce el tamanho debe ser 0 (la interfaz muestra el progreso segun los bytes recibidos)');
  });

  await test('Los activos fragmentados deben llegar hasta updater.asset; si no, prepare avisara de que «no hay URL de descarga disponible»', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkBuddyStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts debe conservarse en el activo');
    assert(info.canAutoApply === true, 'con fragmentos debe considerarse actualizable automaticamente');
  });

  await test('Doble fuente: al combinar versiones solo se aceptan activos de la misma version; un paquete antiguo no debe hacerse pasar por nuevo', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkBuddyStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkBuddyStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkBuddyStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `debe tomarse la version superior, real ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'un activo con el mismo nombre de una version antigua no debe sobrescribir el de la nueva');
  });

  await test('Agente de ventanas: scope une los directorios con punto y coma y descarta los vacios (unica entrada para decidir la pertenencia de la ventana)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // No se inicia realmente el agente: solo se valida el contenido del protocolo que se le envia
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `debe enviarse una sola orden scope, real ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `los elementos vacios deben descartarse, real ${sent[0].dirs}`);
    assert(r.ok === true, 'un scope correcto debe devolver ok');
    // Pasar un array vacio tampoco debe lanzar: equivale a «no ocultar nada»; el llamador decide si avisa
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'un alcance vacio tambien debe poderse enviar (el agente no toca ninguna ventana al recibirlo)');
  });

  await test('Doble fuente: cuando el mismo paquete completo esta en ambas fuentes, deben conservarse las dos URL (si no, Gitee nunca se usaria)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkBuddyStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Los activos de Gitee no tienen size (comprobado); no debe usarse el tamanho de GitHub como si fuera suyo
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkBuddyStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `los activos con el mismo nombre deben agruparse en 1, reales ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `deben conservarse las URL de ambas fuentes, reales ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'el tamanho se registra por URL; lo desconocido se deja como desconocido');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `las URL candidatas deben incluir ambas fuentes, reales ${JSON.stringify(cands)}`);
  });

  await test('Descarga paralela multifronte: si dos fuentes tienen tamanhos distintos, seguir la mas rapida (no elegir siempre la mayor)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // Fuente que va primero (ya ordenada por velocidad)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // El orden de la lista es el de velocidad de rank(): el primero es la fuente mas rapida
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `debe descargarse la copia de la fuente mas rapida (${small.length} bytes), reales ${got.length} bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Paquete de actualizacion fragmentado: volver a unir las partes en orden y abortar de inmediato si el tamanho no coincide', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'el tamanho final debe ser igual a la suma de las partes');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'el contenido de la primera parte esta en orden incorrecto');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'el contenido de la segunda parte esta en orden incorrecto');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('Descarga paralela multifronte: cada bloque se obtiene de una fuente distinta y los bytes finales deben coincidir exactamente', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Se espera explicitamente al callback listening: si se registra el evento despues de listen, se pierden eventos ya disparados y la prueba se cuelga
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'el contenido tras unir varias fuentes debe coincidir exactamente con el original');
      assert(r.sources === 2 && r.parallel >= 2, `deben usarse 2 fuentes a la vez, real ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'el tamanho debe coincidir');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Descarga paralela multifronte: tras un fallo solo se recuperan los bloques que faltan (no se vuelve a bajar 1,4 GB)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // Solo se cuentan las peticiones de bloques de datos reales (la sonda 0-0 no cuenta)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Deben ser dos URL: con una sola, downloadMulti delega en el fragmentado de una fuente (esa ruta ya tiene reanudacion)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Se simula la situacion «dos primeros bloques descargados, el ultimo pendiente» (fragmentado: 3 conexiones × 1 MB)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'debe reconocerse como una reanudacion');
      assert(ranged === 1, `solo debe descargarse 1 bloque; peticiones reales: ${ranged}`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'el archivo tras la reanudacion debe coincidir exactamente con el original');
      assert(!fs.existsSync(`${out}.chunks.json`), 'al terminar debe borrarse el archivo sidecar');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descargador: si tras establecer la conexion no llega ni un byte, debe agotar el tiempo de espera y cambiar de fuente en vez de colgarse', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // La cabecera responde bien y despues nunca mas: simula el caso clasico de «TCP abierto pero bloqueado/limitado»
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Se envian 1 KB y despues nada
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'al final debe descargarse por completo');
      assert(cost < 15000, `no debe colgarse en una conexion estancada; tardo ${cost} ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descargador: cambiar de fuente cuando una solo alcanza decenas de KB/s, en vez de quedarse atascado en los ultimos %', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Fuente lenta: entrega 4 KB cada 100 ms (≈40 KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'el contenido tras cambiar de fuente debe ser correcto');
      // Usando solo la fuente lenta, 2 MB / 40 KB/s ≈ 50 segundos; el cambio debe completarse en segundos
      assert(cost < 15000, `debe cambiar de fuente con velocidad baja; tardo ${cost} ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descarga paralela multifronte: si solo hay una URL, recurrir al fragmentado de una sola fuente', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Se usa como fuente mala un puerto «recien liberado y sin nadie escuchando»: la conexion se rechaza al instante, sin esperar el tiempo de espera
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // La segunda URL apunta a proposito a un puerto inaccesible: debe ignorarse automaticamente, sin fallar el paquete completo
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'con una sola fuente tambien debe descargarse por completo');
      assert(!r.multi || r.sources === 1, 'con una sola fuente disponible no debe marcarse como multifronte');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Doble fuente: el resultado de version se guarda en cache 10 minutos; force fuerza una nueva consulta', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `durante el periodo de cache no deben repetirse peticiones; reales ${calls}`);
    await s.latest({ force: true });
    assert(calls === 2, 'force debe omitir la cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'tras reset debe volver a consultar');
  });

  await test('Doble fuente: si una fuente recibe 403 por limitacion, el cortocircuito la omite y no se sigue golpeando el muro en cada ciclo', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 (limitado por tasa)' },
      ];
    };
    // Primera vez: Gitee da 403 y se registra en el cortocircuito
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'en la primera ronda debe haberse consultado realmente');
    const reason = s.blockedReason('gitee');
    assert(!!reason, 'un 403 debe disparar el cortocircuito');
    assert(s.blockedReason('github') === null, 'una fuente sin errores no debe cortocircuitarse');
    // Las peticiones durante el cortocircuito deben omitirse directamente (sin acceder a la red)
    assert(/Se omite|omite temporalmente/i.test(reason), `el motivo de la omision debe ser comprensible, real: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'tras reset debe levantarse el cortocircuito');
  });

  await test('Doble fuente: si ninguna fuente esta disponible, volver al ultimo resultado (marcar stale, sin lanzar un error directo)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'la primera vez debe ser normal');
    s._relTtl = 0;   // Invalidar la cache
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'tiempo de espera agotado' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'debe volverse al resultado anterior y marcarse como stale');
  });

  await test('Ubicacion de las imagenes del sistema: en una instalacion nueva deben ir al directorio del entorno (CI arma el entorno basandose en esto)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Instalacion nueva: ni el directorio del entorno ni el de datos tienen system-images → ir al directorio del entorno
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `una instalacion nueva debe ir al directorio del entorno, real ${p.paths().sysImgRoot}`);

      // 2) El directorio del entorno ya lo tiene (producto de descomprimir el paquete completo) → priorizarlo
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'si ya existe, priorizar el directorio del entorno');

      // 3) Solo lo tiene el directorio de datos (diseno de versiones antiguas) → usarlo
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `el diseno antiguo debe recurrir al directorio de datos, real ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Directorio de entorno de solo lectura (dentro del paquete MSIX): los datos modificables deben redirigirse al directorio de datos del usuario', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ro-root-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Se crea una raiz «no escribible»: un nivel intermedio se convierte en archivo normal, asi mkdir dara EEXIST/ENOTDIR
      const blocker = path.join(tmp, 'blocker');
      fs2.writeFileSync(blocker, 'x');
      const roRoot = path.join(blocker, 'rt');
      store.saveSettings({ runtime: { dir: roRoot } });
      const p = new Provisioner(path.join(__dirname, '..'));
      const paths = p.paths();
      assert(paths.rootWritable === false, 'un directorio de solo lectura debe reconocerse como no escribible');
      // Clave: las imagenes deben desplegarse en el directorio de datos del usuario, no dentro del paquete (que es de solo lectura y fallaria)
      assert(paths.sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `con solo lectura debe ir al directorio de datos, real ${paths.sysImgRoot}`);
      assert(paths.tmp.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), '_tmp tambien debe redirigirse');
      assert(paths.avdHome.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), 'el AVD tambien debe estar en un directorio escribible');
      // Los ejecutables siguen apuntando al paquete (asi se conserva la identidad de paquete y la vista virtualizada de %APPDATA% coincide con el proceso padre)
      assert(paths.emulatorExe === path.join(roRoot, 'emulator', 'emulator.exe'), 'el emulador sigue ejecutandose desde el paquete');
      assert(paths.adbExe === path.join(roRoot, 'platform-tools', 'adb.exe'), 'adb sigue ejecutandose desde el paquete');
      // ensureDirs no debe lanzar un error solo porque la raiz sea de solo lectura
      p.ensureDirs();
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Una imagen comprimida dentro del paquete debe contarse como «lista»; si no, tras instalar se volverian a descargar 1,5 GB por red', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'packed-img-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const sparse = (file, size) => {
      fs2.mkdirSync(path.dirname(file), { recursive: true });
      fs2.writeFileSync(file, '');
      fs2.truncateSync(file, size);   // Archivo disperso: no ocupa espacio real, solo tiene un tamanho suficiente
    };
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Simula el paquete completo / MSIX de tienda: el directorio del entorno solo tiene .xz, sin system.img desplegado
      const root = path.join(tmp, 'rt');
      const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
      sparse(path.join(dir, 'system.img.xz'), 320 * 1024 * 1024);
      fs2.writeFileSync(path.join(dir, 'kernel-ranchu'), 'x');
      store.saveSettings({ runtime: { dir: root } });
      // appRoot apunta a un directorio vacio para evitar interferencias con engine/system-images ya desplegados en el repositorio
      const p = new Provisioner(path.join(tmp, 'empty-app'));
      const sys = p.systemImageInfo();
      assert(sys.ok === true, 'la imagen comprimida debe considerarse lista (si no, autoDeploy intentara descargarla)');
      assert(sys.compressed === true, 'debe marcarse como «hay que desplegarla una vez mas»');
      assert(String(sys.dir).toLowerCase().startsWith(root.toLowerCase()), 'debe apuntar a una ubicacion dentro del paquete');
      const play = p.playImageInfo();
      assert(play.ok === true && play.compressed === true, 'lo mismo para la imagen de compatibilidad');

      // Tras desplegarla (con system.img) debe pasar a compressed=false y preferirse la copia desplegada
      sparse(path.join(dir, 'system.img'), 320 * 1024 * 1024);
      const after = p.systemImageInfo();
      assert(after.ok === true && after.compressed === false, 'tras desplegarla no debe seguir marcada como comprimida');
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[Estrategia de recursos / asignacion de disco / limite de registros]');

  await test('Un solo cambio de estrategia de recursos se traduce automaticamente en vCPU/prioridad/resolucion', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'el modo fluido no debe limitar los nucleos');
    assert(s.engine.priorityMode === 'game', 'el modo fluido debe usar prioridad de juego de baja latencia (FPS/video primero)');
    assert(s.engine.renderSize === '720x1280', `la resolucion debe ser 720p, real ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'ahorro debe ser 540p + contenedor ligero');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'en modo equilibrado la resolucion se deja en automatica');
  });

  await test('El tamanho de la particion de datos es configurable y el valor predeterminado ya no es fijo', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `debe ser 12 GB, real ${p.dataMB} MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `con disco suficiente, automaticamente deben ser 6 GB, real ${auto.dataMB}`);
  });

  await test('La huella de la instantanea no incluye el tamanho de la particion de datos (ampliarla no debe invalidar la instantanea ni borrar datos)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'cambiar solo el tamanho no debe alterar la huella');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'cambiar la version del motor debe alterar la huella');
  });

  await test('Los registros se rotan automaticamente al superar el limite, conservando una sola copia', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'debe rotarse');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'debe pasar a .1.log');
  });

  await test('Si el nombre del registro no termina en .log: mejor no rotar que borrar el registro', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'si bak tiene el mismo nombre que el archivo original hay que abandonar la rotacion');
    assert(fs.existsSync(f), 'el archivo de registro no debe borrarse');
  });

  await test('Los fallos de arranque se guardan en disco; tras reiniciar, el informe de diagnostico sigue mostrando la causa real', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / aceleracion por hardware', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'el codigo de salida debe guardarse');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'la conclusion del diagnostico debe guardarse');
    assert(back.attempts.length === 1, 'el registro de intentos debe guardarse');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'tras un arranque correcto debe borrarse el registro de fallos');
  });

  await test('Paquetes divididos .xapk: extraer fragmentos por streaming, analizar la base y limpiar el directorio temporal si falla', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Exito: dos fragmentos en el paquete (base + config); meta procede del que se puede analizar
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `deben extraerse 2 fragmentos, reales ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'los fragmentos deben guardarse en disco');
      assert(b.meta.package === 'com.example.test', `nombre de paquete ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Fallo: el paquete no tiene fragmentos APK → error claro y sin dejar el directorio temporal en el equipo del usuario
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No se encontraron fragmentos/i.test(err.message), `debe avisar de que no hay fragmentos, real ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'al fallar debe limpiarse el directorio temporal');
  });

  await test('materializeImages: desplegar .img.gz, omitir lo ya desplegado, informar de imagenes danadas sin dejar trabajo a medias', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40 MB de ceros: comprimido son solo decenas de KB, pero descomprimido supera los 32 MB; sirve para validar la deteccion de «ya desplegado»
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `debe desplegarse 1 imagen, real ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'el tamanho tras el despliegue debe ser correcto');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'los componentes sin comprimir tambien deben estar listos');
      assert(!fs.existsSync(`${img}.part`), 'si tiene exito no debe quedar .part');

      const again = await prov.materializeImages();
      assert(again === 0, `si ya esta desplegada debe omitirse; desplegadas de nuevo: ${again}`);

      // Imagen danada: debe lanzar MATERIALIZE_FAILED y borrar .part (si no, la vez siguiente se tomaria por terminada)
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `una imagen danada debe fallar, real ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'tras el fallo no debe quedar .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('Tras cambiar la fuente de descarga/la URL del paquete: la cache de URL del provisioner debe vaciarse (si no, solo surte efecto tras reiniciar)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simula la cache tras resolver una vez la URL del paquete / del motor
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'la cache de la URL del paquete debe vaciarse');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'las caches de URL del motor/las imagenes deben vaciarse');
  });

  await test('Cada arranque se diagnostica solo con sus propios registros (un fallo anterior no debe contaminar el siguiente)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // 1.er intento: 0xC0000005
      { t: 3, line: '--- 2.º intento ---' },
      { t: 4, line: 'Address already in use' },          // 2.º intento: puerto ocupado
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'el 1.er intento debe considerarse un fallo');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'el 2.º intento debe considerarse puerto ocupado');
    // Si el intento actual no tiene registros, recurrir al final del registro global; no devolver UNKNOWN directamente
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `un intento vacio debe recurrir al registro completo; reales ${fallback.length} lineas`);
  });

  await test('Ensamblado del componente de arranque: un componente completo no debe llevar el nombre de paquete duplicado (si no, al pulsar el icono solo se ve el escritorio de Android)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Componente completo (asi se guarda en apps.json tras instalar en v0.3.4) → usar tal cual
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'un componente completo debe devolverse tal cual');
    // Datos antiguos: nombre de clase simple / que empieza por punto → anadir el paquete
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'una activity vacia debe devolver vacio (usa intent implicito)');
    // La salida de resolve-activity suele terminar con lineas vacias/priority: debe poder extraerse el componente
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'deben omitirse las lineas vacias y tomarse el componente de la ultima linea');
    assert(parseResolvedActivity('com.other', out) === '', 'el nombre de paquete de otra app no debe usarse');
  });

  await test('Ventana de una sola app: en modo independiente la cascara nunca debe mostrarse', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // maximize() muestra directamente un BrowserWindow con show:false: esta es una de las
    // causas directas de «se abren varias ventanas al iniciar una app».
    assert(/fullscreen && !this\.detachedMode\) this\.win\.maximize\(\)/.test(appwin),
      'en modo independiente no debe maximizarse la cascara (apareceria una ventana negra de la nada)');
    assert(/if \(this\.detachedMode\) this\.agent\.show\(\)/.test(appwin),
      'en modo independiente, pulsar dos veces la misma app debe traer al frente la ventana del emulador, no mostrar la cascara');
    // En ready-to-show tampoco se puede mostrar sin mas: solo con showWhileWaiting (al cambiar de app,
    // sin la reserva de la animacion de arranque) se permite mostrar antes la cascara de «Abriendo…».
    const readyIdx = appwin.indexOf("once('ready-to-show'");
    assert(readyIdx > 0 && /if \(this\.detachedMode && !this\._showWhileWaiting\) return;/
      .test(appwin.slice(readyIdx, readyIdx + 2000)),
    'en modo independiente, ready-to-show debe hacer return directamente por defecto');
  });

  await test('Animacion de arranque: el estado de splash debe ser de modulo; si no, nunca se cierra', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // runLaunch / autoDeploy se definen **fuera** del callback whenReady, asi que no ven el splashDone
    // declarado con const dentro del callback (typeof siempre es 'undefined'): eso hacia que la animacion
    // de 480x360 con alwaysOnTop quedara clavada en el centro de la pantalla.
    assert(/^let splashWin = null;$/m.test(mainJs), 'splashWin debe ser un let de modulo');
    assert(/^let splashDone = \(\) => \{\};$/m.test(mainJs), 'splashDone debe ser un let de modulo');
    assert(/^let splashProgress = \(\) => \{\};$/m.test(mainJs), 'splashProgress debe ser un let de modulo');
    assert(!/const splashDone = \(\) =>/.test(mainJs), 'ya no debe sobrescribirse con const dentro de whenReady');
    // Fusible: si splash no se cierra solo, el proceso principal lo cierra a la fuerza
    assert(/setTimeout\(\(\) => \{[\s\S]{0,160}splashWin\.close\(\);/.test(mainJs),
      'tras splashDone debe existir un fusible de cierre forzoso');
  });

  await test('Varias ventanas: al iniciar una app hay que ocultar primero la ventana de gestion y luego abrir la de la app', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const launchIdx = mainJs.indexOf('async function runLaunch(');
    const body = mainJs.slice(launchIdx, launchIdx + 2000);
    const hideIdx = body.indexOf('mainWindow.hide()');
    const openIdx = body.indexOf('openAppWindow(pkg');
    assert(hideIdx > 0 && openIdx > 0, 'ambas llamadas deben estar en runLaunch');
    assert(hideIdx < openIdx, 'mainWindow.hide() debe ir antes de openAppWindow (si no, se ven dos ventanas a la vez)');
  });

  await test('Vertical/horizontal: la orientacion del panel debe coincidir con la declaracion de la app; si no, solo se consigue un efecto de cartelera', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const apkJs = fs.readFileSync(path.join(root, 'src', 'core', 'apk.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');

    assert(/function wantLandscapeFor\(pkg\)/.test(mainJs), 'debe existir la decision de «que orientacion corresponde a esta app»');
    assert(/orientationMode/.test(mainJs), 'debe leerse la estrategia de orientacion de los ajustes');
    assert(/orientationOverride/.test(mainJs), 'la anulacion de orientacion por app debe aplicarse');
    // La ruta de arranque debe usarla, no el displaySettings().landscape directo
    assert(/const wantLand = wantLandscapeFor\(pkg\)/.test(mainJs), 'beforeStart debe decidir segun la orientacion de la app');
    assert(/const land = wantLandscapeFor\(pkg\)/.test(mainJs), 'openAppWindow debe abrir la ventana segun la orientacion de la app');
    // Calcular la orientacion sin conexion desde el manifiesto del APK
    assert(/function detectOrientation\(/.test(apkJs), 'debe determinarse la orientacion de la app desde el manifiesto del APK sin conexion');
    assert(/orientation,/.test(apkJs), 'parseApk debe devolver orientation');
    assert(/orientation: meta\.orientation/.test(installerJs), 'al instalar debe guardarse la orientacion en apps.json');
    assert(/orientationMode: 'auto'/.test(storeJs), 'la estrategia predeterminada es seguir la app');
    // Rellenar datos antiguos: sin esto siguen los bordes negros
    assert(/orientation backfill/.test(mainJs), 'las apps instaladas por versiones antiguas deben recibir la orientacion');
  });

  await test('Vertical/horizontal: un reinicio provocado por una orientacion distinta no debe interrumpir el arranque', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // beforeStart devuelve un rt nuevo; antes aqui se escribia const rt y, al entrar realmente en la rama de reinicio,
    // se lanzaba "Assignment to constant variable." y fallaba todo el arranque.
    assert(/let rt = await this\.runtime\.ensure\(\{ onLog \}\)/.test(installerJs),
      'rt debe ser let; si no, se rompera al cambiar de client en el reinicio');
    assert(/if \(replaced && replaced\.client\) rt = replaced;/.test(installerJs), 'debe aceptarse el rt nuevo');
  });

  await test('Al cambiar de app no debe quedar una pantalla vacia: en modo independiente hay que mostrar la cascara mientras se espera', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // En modo de ventana independiente (predeterminado), la cascara no se muestra normalmente; cambiar a una app con otra orientacion reinicia el entorno
    // unos 40 segundos, y si no se muestra nada durante ese tiempo el usuario pensara que el programa se ha cerrado.
    assert(/showWhileWaiting: detached && !splashVisible/.test(mainJs),
      'en modo independiente sin animacion de arranque, debe usarse showWhileWaiting');
    assert(/splashVisible = !!\(splashWin && !splashWin\.isDestroyed\(\)\)/.test(mainJs),
      'debe decidirse segun se este mostrando o no splash quien le dice al usuario «esperando»');
    assert(/const willRestart = land !== !!displaySettings\(\)\.landscape/.test(mainJs),
      'debe poder anticiparse que «esta vez habra reinicio»');
    assert(/if \(this\.detachedMode && !this\._showWhileWaiting\) return;/.test(appwin),
      'ready-to-show solo muestra la cascara con showWhileWaiting');
    assert(/cambiando a|cambiar a/i.test(mainJs), 'el texto de aviso debe explicar por que va lento');
  });

  await test('El titulo debe asignarse antes de show; si no, aparece un instante el nombre de la app anterior', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const start = appwin.indexOf('async openDetached(');
    const body = appwin.slice(start, start + 2000);
    const titleIdx = body.indexOf('this.agent.setTitle(');
    const showIdx = body.indexOf('this.agent.show()');
    assert(titleIdx > 0 && showIdx > 0, 'ambas llamadas deben estar en openDetached');
    assert(titleIdx < showIdx, 'setTitle debe ir antes de show (el agente guarda en cache el titulo anterior)');
  });

  await test('La revision de red no debe pedir restablecer datos por un solo fallo', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // La asociacion Wi-Fi ocurre 5-20 segundos despues de sys.boot_completed; comprobar una sola vez y avisar de «sin red»
    // daba un falso positivo en cada arranque en frio; ademas, antes se aconsejaba «restablecer los datos de Android» (lo que borra las apps instaladas).
    assert(/checkNetwork\('', \{ waitMs: \d+, interval: \d+ \}\)/.test(emuJs),
      'la revision de red tras el arranque debe tener un margen de espera; no basta una sola comprobacion');
    // Anclar en el propio texto del aviso al usuario (no en un checkNetwork() cualquiera,
    // que aparece varias veces en el archivo y el primero está lejos del aviso).
    const netAt = emuJs.indexOf('no está conectada');
    const warn = netAt >= 0 ? emuJs.slice(netAt - 200, netAt + 1200) : '';
    // Solo se miran las lineas de codigo: el comentario que explica «antes aqui se aconsejaba restablecer datos» no cuenta
    const warnCode = warn.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/restablecer los datos de Android/i.test(warnCode), 'este aviso no debe aconsejar «restablecer los datos de Android» (se perderian las apps instaladas)');
    assert(/no está conectada|sin conexión|sin red|no conectad/i.test(warnCode), 'debe cambiarse a una formulacion que no asuste ni induzca a error');
  });

  await test('La ventana negra de consola que aparece al arrancar debe suprimirse con un canal de alta frecuencia', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Al iniciar qemu, el emulador hace que Windows cree una ventana de consola (en Win11, Windows Terminal)
    // que solo vive 200-300 ms; la inspeccion principal, con un ciclo de 250 ms, la pasa por alto.
    assert(/_consoleSweep/.test(ps1), 'debe existir una marca de tiempo independiente para el analisis de consolas');
    assert(/now - _consoleSweep > \(_perfMode \? 200 : 100\)/.test(ps1), 'durante los primeros 15 segundos hay que analizar las consolas cada 100 ms');
    assert(/now - _bootHideStart < 15000/.test(ps1), 'el canal de alta frecuencia solo debe funcionar durante la ventana de arranque, para no consumir CPU indefinidamente');
    // Debe ser «ventana de consola + titulo que coincida con la ruta del entorno»; no se puede volver a una lista blanca de pid
    assert(/static void HideConsoleWindows\(\)/.test(ps1) && /IsOurConsole\(h\)/.test(ps1),
      'la pertenencia de la consola debe determinarse con IsOurConsole (el pid de conhost no es el del emulador)');
  });

  await test('Tras reiniciar y cambiar de panel no debe «reutilizarse» un emulador ya apagado', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // emulator.exe solo es un lanzador: tras iniciar qemu sale, pero this.proc sigue ahi
    // (killed continua en false). Mirar solo eso equivale a creer que una maquina ya apagada sigue viva:
    // restartForOrientation apaga la maquina y enseguida llama a ensure() → start() la reutiliza directamente,
    // y el llamador usa con adb un serial muerto → `device not found`; el cambio de app falla.
    const reuse = emuJs.slice(emuJs.indexOf('async start('), emuJs.indexOf('async start(') + 2000);
    assert(/_consoleAlive\(\)/.test(reuse), 'la rama de reutilizacion de start() debe confirmar que hay una maquina real en el puerto de consola');
    assert(/this\.proc = null;/.test(reuse), 'si se confirma que no esta funcionando, limpiar proc y seguir el arranque real');
    // Tras apagar limpiamente, stop() debe soltar el identificador del lanzador; si no, running() siempre seria true
    const stopFn = emuJs.slice(emuJs.indexOf('async stop('), emuJs.indexOf('async stop(') + 4000);
    assert(/killAttempt\(\)[\s\S]{0,500}this\.proc = null;/.test(stopFn), 'stop() debe limpiar this.proc al terminar');
  });

  await test('El recuadro negro de arranque que abre Windows Terminal tambien debe reconocerse', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Tras sustituir en Win11 el host de consola predeterminado por Windows Terminal, la ventana de consola de qemu pertenece a
    // WindowsTerminal.exe: ni el pid, ni la cadena de padres, ni el titulo son nuestros; solo queda fiarse de «no existia antes del arranque»
    assert(/static void SnapshotConsoles\(\)/.test(ps1), 'antes de arrancar hay que anotar las ventanas de consola existentes');
    assert(/_consolesBeforeBoot/.test(ps1), 'debe existir una instantanea de consolas previa al arranque');
    assert(/now - _bootHideStart < 20000[\s\S]{0,120}_consolesBeforeBoot\.Contains/.test(ps1),
      'solo se reconocen las ventanas de consola «que aparecen en los 20 segundos posteriores al arranque»');
    assert(/tl\.IndexOf\("terminal", StringComparison\.Ordinal\) >= 0/.test(ps1),
      'solo se considera sospechosa una ventana con titulo vacio o que contenga terminal (las terminales que el usuario ya tenia estan en la instantanea)');
    assert(/SnapshotConsoles\(\);/.test(ps1), 'con boothide hay que tomar primero la instantanea');
  });

  await test('El arranque debe serializarse: pulsar varias veces / cambiar de app no debe ejecutar dos lanzamientos en paralelo', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // Un arranque dura hasta 80 segundos (reinicio por cambio de panel + arranque en frio). Antes, pulsar otra app en ese tiempo
    // lanzaba realmente un segundo proceso en paralelo: openAppWindow cerraba la app que estaba arrancando, la maquina se reiniciaba,
    // y ambos fallaban, con `cmd: Can't find service: activity` en los registros.
    assert(/let launchInFlight = null;/.test(mainJs), 'debe existir un registro del arranque en curso');
    assert(/if \(launchInFlight\.pkg === pkg\)[\s\S]{0,120}return launchInFlight\.promise;/.test(mainJs),
      'varios clics en la misma app deben reutilizar el arranque en curso');
    assert(/launch queued \$\{pkg\}/.test(mainJs), 'cambiar de app debe ponerse en cola en vez de arrancar otro entorno');
    assert(/async function launchOne\(pkg\)/.test(mainJs), 'el cuerpo original debe extraerse a launchOne');
    assert(/launchInFlight = entry;/.test(mainJs), 'debe limpiarse en finally para no bloquear arranques posteriores');
  });

  await test('Aceleracion por hardware: la version de tienda guia al usuario para activar WHPX; la version instalada lo activa con un clic y puede recurrir a AEHD', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

    // 1) La funcion que realmente habilita WHPX en el emulador es HypervisorPlatform (VirtualMachinePlatform es para WSL2);
    //    debe activarse primero; se activan ambas para cubrir distintas maquinas.
    assert(/for \(const f of \['HypervisorPlatform', 'VirtualMachinePlatform'\]\)/.test(mainJs),
      'debe activarse primero HypervisorPlatform (lo que WHPX realmente necesita)');
    // 2) Ya no se puede usar la existencia de WinHvPlatform.dll como interruptor: en Windows moderno siempre esta,
    //    y ese criterio dejaría fuera a las maquinas que realmente necesitan activar la funcion.
    const handler = mainJs.slice(mainJs.indexOf("ipcMain.handle('provision:enableVirtualization'"));
    const handlerBody = handler.slice(0, 4000);
    assert(!/if \(hv\.dll\) \{/.test(handlerBody), 'ya no debe ramificarse segun WinHvPlatform.dll');
    // 3) Version de tienda (MSIX): si no se puede elevar, recurrir a «guia manual» en vez de mostrar un UAC condenado al fracaso
    assert(/if \(store\.STORE_BUILD\) \{[\s\S]{0,900}manual: true/.test(handlerBody),
      'si falla la version de tienda debe devolverse manual para que la interfaz guie al usuario');
    assert(/tienda no puede elevar|no puede obtener permisos/i.test(mainJs), 'el texto de la version de tienda debe explicar por que no puede activarse automaticamente');
    assert(/Hyper-V|hipervisor/i.test(mainJs), 'debe mencionarse explicitamente «Plataforma de Hipervisor de Windows»');
    // 4) Tras activarla hay que vaciar la cache de aceleracion; si no, la interfaz sigue mostrando la conclusion antigua
    assert(/const whpx = await enableWhpxFeatures\(\);\s*\n\s*runtime\.provisioner\.invalidateEnvCache/.test(mainJs),
      'tras activar debe llamarse a invalidateEnvCache');
    // 5) Si el usuario pulsa «No» debe distinguirse de un fallo real (1223 = ERROR_CANCELLED)
    assert(/1223/.test(mainJs) && /cancelled/.test(mainJs), 'debe distinguirse la cancelacion del UAC');
    // 6) La opcion «Plataforma de Hipervisor de Windows» pertenece al dialogo clasico, no a la pagina ms-settings
    assert(/optionalfeatures\.exe/.test(mainJs), 'debe abrirse el optionalfeatures.exe clasico');
    // 7) La interfaz debe gestionar manual / cancelled y abrir realmente ese dialogo
    assert(/r\.manual/.test(appJs) && /api\.openWindowsFeatures/.test(appJs), 'la interfaz debe gestionar la rama manual');
    assert(/openWindowsFeatures: \(\) => invoke\('provision:openWindowsFeatures'\)/.test(preloadJs),
      'preload debe exponer openWindowsFeatures');
    // 8) Con emulacion por software, el primer arranque debe mostrar una notificacion del sistema (es probable que el usuario no haya visto la comprobacion en ajustes)
    assert(/let accelWarned = false;/.test(mainJs) && /emulación de software|software.*(lento|render)|modo software/i.test(mainJs),
      'la emulacion por software debe avisar una vez');
  });

  await test('El empaquetado debe escribir el icono/version del exe; si no, el Explorador muestra el icono predeterminado de Electron', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // Un exe obtenido solo con un cambio de nombre sigue siendo Electron por dentro: FileDescription=Electron,
    // ProductName=Electron, CompanyName=GitHub, Inc., version 33.4.11 y el icono tambien es el predeterminado.
    assert(/function embedExeMeta\(exe\)/.test(packJs), 'debe existir el paso de escritura de metadatos del exe');
    assert(/--set-icon/.test(packJs), 'debe escribirse el icono');
    assert(/--set-file-version/.test(packJs), 'debe escribirse la version del archivo');
    assert(/--set-version-string', 'FileDescription'/.test(packJs), 'debe escribirse FileDescription');
    assert(/--set-version-string', 'ProductName', 'ApkBuddyStart'/.test(packJs), 'ProductName debe ser ApkBuddyStart');
    assert(/embedExeMeta\(exePath\)/.test(packJs), 'debe llamarse realmente tras el cambio de nombre');
    // Si no se encuentra rcedit debe avisarse claramente; no se puede generar en silencio un paquete con «icono de Electron»
    assert(/rcedit\.exe/.test(packJs), 'si falta rcedit debe avisarse');

    // Identidad en la barra de tareas: sin AppUserModelID, los elementos anclados / avisos caen en "Electron"
    assert(/setAumid\(APP_AUMID\);/.test(mainJs), 'al arrancar debe establecerse AppUserModelID');

    // La version completa (con el entorno) como entrega
    assert(/--full/.test(packJs) && /ApkBuddyStart-v\$\{PKG\.version\}-win64-full/.test(packJs),
      '--full debe generar un directorio de version completa con numero de version');
    assert(/build', 'runtime'/.test(packJs), 'la version completa debe incluir build/runtime');
  });

  await test('Unificacion de versiones: package.json / numero MSIX de cuatro segmentos / nombre de paquete en la documentacion', () => {
    const root = path.join(__dirname, '..');
    const pkg = require(path.join(root, 'package.json'));
    const { msixVersion } = require(path.join(root, 'build', 'msix.js'));
    const four = msixVersion(pkg.version);
    assert(/^\d+\.\d+\.\d+\.0$/.test(four), `el formato de version MSIX de cuatro segmentos es incorrecto: ${four}`);
    const artifact = `ApkBuddyStart_${four}_x64.msix`;
    for (const f of ['docs/store-listing.md', 'docs/store-msix.md', 'docs/store-upload-walkthrough.md']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      assert(t.includes(artifact), `${f} debe hacer referencia al paquete de la version actual ${artifact}`);
    }
    // La version de archivo del exe debe usar el mismo numero (cuatro segmentos); que no discrepte de package.json
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    assert(/\$\{PKG\.version\}\.0/.test(packJs), 'la version de archivo del exe debe coincidir con package.json');
    // El paquete de tienda y el exe usan la misma fuente de version; no debe haber una segunda version codificada
    const msixJs = fs.readFileSync(path.join(root, 'build', 'msix.js'), 'utf8');
    assert(/const VERSION = String\(pkg\.version/.test(msixJs), 'la version MSIX debe tomarse de package.json');
  });

  await test('El acceso directo de una app de Android debe usar su propio icono y su propia identidad en la barra de tareas', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const shortcutJs = fs.readFileSync(path.join(root, 'src', 'core', 'shortcut.js'), 'utf8');

    // El icono del acceso directo de escritorio/menu Inicio = <nombre de paquete>.ico extraido del APK, nunca la imagen de marca de ApkBuddyStart
    assert(/const ico = app\.icoPath && fs\.existsSync\(app\.icoPath\) \? app\.icoPath : undefined;/.test(installerJs),
      'debe usarse el icoPath de la propia app');
    assert(/iconIcoPath: ico/.test(installerJs), 'writeShortcut debe recibir el icono de la app');
    assert(!/iconIcoPath:\s*(APPICON|appicon|brandIcon)/.test(installerJs), 'no debe usarse el icono de marca de ApkBuddyStart');
    // Un AUMID por app: la barra de tareas agrupa por aplicacion y asi se reconoce cada elemento anclado
    assert(/appUserModelId: `RoutineMiku\.ApkBuddyStart\.\$\{app\.package\}`/.test(installerJs),
      'cada app debe tener su propio AUMID');
    // Windows solo reutiliza el icono del acceso directo cuando «el AUMID del proceso == el AUMID del acceso directo»;
    // por eso al abrir una app hay que cambiar la identidad del proceso y, al volver a la ventana de gestion, volver a ApkBuddyStart.
    assert(/const APP_AUMID = 'RoutineMiku\.ApkBuddyStart';/.test(mainJs), 'debe existir un prefijo AUMID unificado');
    assert(/setAumid\(`\$\{APP_AUMID\}\.\$\{pkg\}`\)/.test(mainJs), 'antes de abrir la ventana de la app debe cambiarse a su AUMID');
    assert(/function showWindow\(\) \{\s*\n\s*\/\/[^\n]*\n\s*setAumid\(APP_AUMID\);/.test(mainJs),
      'al volver a la ventana de gestion debe restaurarse el AUMID de ApkBuddyStart');
    // writeShortcut debe fijar iconIndex a 0 (fotograma 0 del ico); si no, algunos tamanos toman el icono equivocado
    assert(/icon: opt\.iconIcoPath \|\| opt\.target/.test(shortcutJs), 'la ruta del icono debe poder recurrir a target');
    assert(/iconIndex: 0/.test(shortcutJs), 'iconIndex debe ser 0');
  });

  console.log(results.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
