'use strict';
/**
 * Pruebas unitarias puras de Node (sin Electron / adb / red)
 * Ejecutar: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'fallo la asercion');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('Puede analizar la estructura del paquete package.json de su propio proyecto', () => {
  // Validar el analisis con un zip minimo construido en memoria (modo stored)
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // tamaño total del directorio central
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // desplazamiento del directorio central

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'deberia encontrar hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', 'el contenido deberia coincidir');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('El codificador PNG genera una firma e IHDR validos', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'firma PNG');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'longitud razonable');
});
test('El icono de la aplicacion se puede dibujar en cualquier tamaño', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `el ancho deberia ser ${s}, real ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Accesorio de prueba: se especifica primero con la variable de entorno APKSTART_TEST_APK;
// si no, se prueban las ubicaciones habituales de APK locales (solo lectura, sin copiar)
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (accesorio: ${fixture})`);
  test('quickCheck reconoce la cabecera PK', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('Analiza el nombre de paquete / version / Activity de inicio', () => {
    assert(/^[\w.]+$/.test(meta.package), `nombre de paquete inesperado: ${meta.package}`);
    assert(meta.versionName, 'falta versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `Activity de inicio inesperada: ${meta.launchActivity}`);
  });
  test('Analiza un icono utilizable', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'el icono esta vacio o es demasiado pequeno');
    assert(meta.label, 'el nombre de la aplicacion esta vacio');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('La raiz AXML es manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc se puede analizar', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'deberia haber al menos un package');
    }
  });
} else {
  console.log('  (omitido: no se encontro ningun accesorio APK; puedes configurar APKSTART_TEST_APK)');
}

// El constructor del APK sintetico esta en test/lib/make-apk.js: cubre la pila de analisis
// aunque falte el accesorio real; run-tests / auto-test comparten el mismo codigo (para evitar dos implementaciones).
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[APK sintetico: axml + apk, ciclo completo]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('Semantica de espacios de nombres de attrValue: null = sin restriccion; por defecto solo android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: '测试' },
      ],
    };
    // Los atributos sin espacio de nombres (como package) requieren null; es clave para parseApk
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package requiere ns=null');
    assert(attrValue(node, 'package') === null, 'por defecto solo se reconoce el espacio de nombres android');
    assert(attrValue(node, 'label') === '测试', 'los atributos android usan el espacio de nombres predeterminado');
    assert(attrValue(node, 'label', null) === '测试', 'con ns=null deberian encontrarse los atributos android');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('Nombre de paquete: package en manifest es un atributo sin espacio de nombres', () => {
      assert(meta.package === 'com.example.test', `real ${meta.package}`);
    });
    test('Nombre de aplicacion / version / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('La Activity de inicio se analiza desde intent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('Directorios ABI y recursos de icono', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'el icono deberia ser PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'el tamaño del archivo deberia rellenarse');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

{
  const { detectOrientation } = require('../src/core/apk');
  const { ANDROID_NS } = require('../src/core/axml');
  const act = (name, ori) => ({
    name: 'activity',
    attrs: [
      { ns: ANDROID_NS, name: 'name', typed: name },
      ...(ori == null ? [] : [{ ns: ANDROID_NS, name: 'screenOrientation', typed: ori }]),
    ],
  });
  test('Orientacion de pantalla: determinar la orientacion natural de la app segun las declaraciones de Activity', () => {
    // Caso «docenas de portrait + una pantalla de inicio sensor» → portrait
    const hongguo = [
      act('SplashActivity', 3), act('MainActivity', 1), act('ReaderActivity', 3),
      act('WebActivity', 1), act('DetailActivity', 1),
    ];
    assert(detectOrientation(hongguo, hongguo[0]) === 'portrait', 'la mayoria de declaraciones portrait deben dar vertical');
    // Caso de una sola Activity con landscape explicito
    const modu = [act('MainActivity', 2)];
    assert(detectOrientation(modu, modu[0]) === 'landscape', 'una sola Activity landscape debe dar horizontal');
    // Solo sensor / sin especificar → no se puede determinar; se deja a los ajustes
    const sensorOnly = [act('A', 3), act('B', 11), act('C', 0), act('D', 14)];
    assert(detectOrientation(sensorOnly, sensorOnly[0]) === null, 'si todo sigue al giroscopio debe devolver null');
    assert(detectOrientation([act('A', null)], null) === null, 'sin orientacion declarada devuelve null');
    // La Activity de inicio pesa mas: es la primera pantalla que ve el usuario
    const launcherWins = [act('Launcher', 2), act('P1', 1), act('P2', 1), act('P3', 1)];
    assert(detectOrientation(launcherWins, launcherWins[0]) === 'landscape', 'la orientacion de la Activity de inicio debe ponderarse');
    // reversePortrait / userLandscape tambien deben clasificarse correctamente
    assert(detectOrientation([act('A', 7)], null) === 'portrait', 'reversePortrait es vertical');
    assert(detectOrientation([act('A', 12)], null) === 'landscape', 'userLandscape es horizontal');
  });
}

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
