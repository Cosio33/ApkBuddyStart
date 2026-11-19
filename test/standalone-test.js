'use strict';
/**
 * Pure Node tests for standalone operation: no Electron, no emulator, no network.
 *
 * This guards a product bottom line (upgraded to a hard constraint in 0.5.6):
 *   **ApkBuddyStart runs only its bundled runtime on any machine, with any settings, with any leftover config.**
 *
 * Three things to watch:
 *   1. No implementation files for third-party backends (MuMu / LDPlayer / BlueStacks / WSA / FydeOS) exist in the code;
 *   2. Even if settings.json says mode=mumu / fydeos / attach, only builtin is returned;
 *   3. The packaged output must not contain any third-party emulator binaries or directories.
 *
 * Run: node test/standalone-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBundled, findForbiddenSource, assertStandalone } = require('../build/guard-standalone');
const backends = require('../src/core/backends');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-${name}-`));
  return d;
}
function touch(dir, rel, bytes = 8) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

(() => {
  console.log('\n[Standalone · only one backend]');

  const store = require('../src/core/store');
  const settings = store.getSettings();

  test('The default engine is the bundled runtime', () => {
    assert.equal(settings.engine.mode, 'builtin', `Default mode=${settings.engine.mode}`);
  });

  test('The registry has only builtin, no second backend', () => {
    assert.equal(backends.REGISTRY.length, 1, `Registry has ${backends.REGISTRY.length} backends`);
    assert.deepEqual(backends.describe().map((d) => d.id), ['builtin']);
  });

  test('Any leftover mode only creates builtin (mumu / fydeos / attach / arbitrary values)', () => {
    for (const mode of ['mumu', 'fydeos', 'attach', 'ldplayer', 'whatever', '']) {
      const made = backends.create({
        appRoot: ROOT, settings: { engine: { mode } }, store, log: () => {},
      });
      assert.equal(made.id, 'builtin', `mode=${mode} produjo ${made.id}`);
      assert.equal(made.backend.constructor.id, 'builtin', 'el tipo de instancia no es BuiltinBackend');
    }
  });

  test('Pasar otro id explicitamente no funciona (la ruta de reserva no crea otra base de terceros)', () => {
    const made = backends.create({
      appRoot: ROOT, settings: { engine: { mode: 'builtin' } }, store, log: () => {}, id: 'mumu',
    });
    assert.equal(made.id, 'builtin', 'El id=mumu explicito fue aceptado');
  });

  test('La seleccion automatica ya no busca ningun entorno de ejecucion externo', async () => {
    // Asercion sincronica: autoPick debe «devolver builtin directamente»; el codigo fuente no debe contener probe()
    const src = read('src', 'core', 'backends', 'index.js');
    assert(!/\.probe\(/.test(src), 'el registro sigue buscando emuladores externos');
    assert(!/mumu|fydeos|ldplayer|bluestacks/i.test(src.replace(/[\s\S]*?const REGISTRY[\s\S]*?\];/, '')),
      'queda alguna base de terceros en el registro');
  });

  console.log('\n[Ejecucion independiente: codigo de bases de terceros eliminado]');

  test('Solo base / builtin / index bajo backends/', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'core', 'backends')).sort();
    assert.deepEqual(files, ['base.js', 'builtin.js', 'index.js'], `real: ${files.join(', ')}`);
  });

  test('Ya no estan los modulos mumu / fydeos / mumu-compat / frame', () => {
    for (const rel of [
      ['src', 'core', 'backends', 'mumu.js'],
      ['src', 'core', 'backends', 'fydeos.js'],
      ['src', 'core', 'mumu-compat.js'],
      ['src', 'core', 'frame.js'],
    ]) {
      assert.equal(exists(...rel), false, `${rel.join('/')} todavia existe`);
    }
  });

  test('El motor no tiene ramas como «base de terceros no disponible → reserva»', () => {
    const src = read('src', 'core', 'engine.js');
    assert(!/_fallbackFrom/.test(src), 'queda la marca de reserva de bases de terceros');
    assert(!/backend\.id !== 'builtin'/.test(src), 'queda logica que ramifica segun el id de la base');
    assert(!/engine\.mode === 'attach'/.test(src), 'queda la rama attach (conectar a un entorno existente)');
    assert(!/ATTACH_ENDPOINTS/.test(src), 'sigue sondeando el puerto adb de emuladores externos');
  });

  test('La pagina de ajustes no tiene desplegable de modo de motor ni campos de MuMu / FydeOS', () => {
    const html = read('src', 'ui', 'index.html');
    assert(!/setEngineMode/.test(html), 'la pagina de ajustes sigue teniendo el desplegable de modo de motor');
    assert(!/value="mumu"|value="fydeos"|value="attach"/.test(html), 'la pagina de ajustes sigue teniendo opciones de terceros');
    assert(!/setMumuPath|setMumuMemGB|setMumuCores|setFydeosHost/.test(html), 'la pagina de ajustes sigue teniendo campos de terceros');
    assert(/id="setEngineLabel"/.test(html), 'falta la descripcion de solo lectura del entorno de ejecucion');
  });

  test('La capa de persistencia reescribe in situ los campos residuales mode / mumu*', () => {
    const src = read('src', 'core', 'store.js');
    assert(/s\.engine\.mode = 'builtin'/.test(src), 'getSettings no fuerza mode=builtin');
    assert(/mumuPath/.test(src) && /delete s\.engine\[k\]/.test(src), 'no se limpiaron los campos residuales de terceros');
  });

  test('Las rutas candidatas de adb no incluyen el adb de emuladores de terceros', () => {
    const src = read('src', 'core', 'adb.js');
    const block = src.slice(src.indexOf('const COMMON_ADB_PATHS'), src.indexOf('];', src.indexOf('const COMMON_ADB_PATHS')));
    assert(!/mumu|ldplayer|bluestacks|hd-adb/i.test(block), 'sigue usando el adb de un emulador de terceros');
  });

  console.log('\n[Ejecucion independiente: el paquete no debe incluir otros emuladores]');

  test('La guardia reconoce el binario de MuMu', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `numero de coincidencias ${hits.length}`);
    assert.equal(hits[0].vendor, 'Emulador MuMu');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia reconoce los directorios de MuMu (nx_main / nx_device / nemu)', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} no fue bloqueado`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('La guardia tambien reconoce LDPlayer / BlueStacks', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has('Emulador LDPlayer'), 'LDPlayer no fue bloqueado');
    assert.ok(vendors.has('Emulador BlueStacks'), 'BlueStacks no fue bloqueado');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia no afecta a nuestro propio entorno de ejecucion', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/builtin.js', 64);
    touch(d, 'app/src/core/resources.js', 64);
    assert.equal(findBundled(d).length, 0, 'confundio nuestro codigo fuente con un emulador');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia bloquea el codigo adaptador de bases de terceros (para evitar que reaparezca)', () => {
    const d = tmpDir('guard-adapter');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/backends/fydeos.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    const hits = findForbiddenSource(d);
    assert.equal(hits.length, 3, `numero de coincidencias ${hits.length} (deberian ser 3)`);
    const r = assertStandalone(d, { label: 'prueba', exit: false });
    assert.equal(r.ok, false, 'el codigo adaptador no hizo fallar la guardia');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia no confunde un frame.js / js normal con una base de terceros', () => {
    const d = tmpDir('guard-other-js');
    touch(d, 'app/src/render/frame.js', 64);
    touch(d, 'app/src/core/backends/builtin.js', 64);
    assert.equal(findForbiddenSource(d).length, 0, 'frame.js / builtin.js fuera de core no deben considerarse bases de terceros');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('Un directorio de entorno limpio no produce errores', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: 'prueba', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('Si el directorio no existe, omitir la comprobacion en lugar de fallar', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'apkstart-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[Ejecucion independiente: la guardia esta integrada en la compilacion]');

  test('El empaquetado portable analiza resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)/.test(src), 'pack.js no tiene integrada la guardia');
  });

  test('El empaquetado MSIX analiza la carga app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'msix.js no tiene integrada la guardia');
  });

  test('El paquete solo incluye build/runtime (entorno de Google), sin otros directorios de emuladores', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), 'aparece un emulador de terceros en extraResources');
    assert(/build\/runtime/.test(head), 'extraResources no incluye el entorno de ejecucion');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
