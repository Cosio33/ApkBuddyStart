'use strict';
/**
 * Pure Node tests for resource allocation (memory / CPU / storage): no Electron, no emulator.
 *
 * The value of this layer is "nothing breaks even if the user enters nonsense": if a user enters
 * 32GB of memory or a 128GB partition, it must be clamped to what the host can really provide before
 * saving; otherwise the result is a black screen at boot / a failed mid-install, and the user cannot
 * tell what went wrong.
 *
 * Run: node test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskVerdict, diskLimits, clampDataGB, storageVerdict,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[Resource allocation · host capabilities]');

  test('hostProfile accepts injected values (test environment does not touch the real machine)', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('hostProfile does not return 0 cores / NaN when no values are given', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('Memory limit reserves 25% for the host', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `A 32GB host can allocate at most 24GB, got ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('A conservative limit is used even when host memory is unavailable', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[Resource allocation · memory clamping]');

  test('0 means automatic; return 0 unchanged', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('3GB input is aligned to 512MB, giving 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('64GB input is clamped to the host limit with a reason given', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/24 GB|como máximo/i.test(r.reason), r.reason);
  });

  test('128MB input is raised to the minimum bootable value', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('A small-memory machine (4GB) does not give all 4GB to Android', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[Resource allocation · CPU clamping]');

  test('A 16-core machine can allocate at most 15 cores', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('A single-core machine still gets 1 core', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = automatic', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[Resource allocation · memory usage hints]');

  test('Overallocation warns about Windows paging', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/paginar|paginación/i.test(v.note), v.note);
  });

  test('Normal range does not bother the user', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('Below 768MB is judged unbootable', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[Resource allocation · storage]');

  test('A 50GB game is estimated at 1.8x + 2GB reserve', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('Data partition limit is 80% of the hosting disk', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('A 64GB partition is not allowed when only 20GB of disk space remains', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/20\.0 GB.*queda|queda.*20\.0 GB/i.test(r.reason), r.reason);
  });

  test('A 64GB partition is allowed when there is enough disk space', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('When space is insufficient, storageVerdict reports how much is missing', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/faltan|falt/i.test(v.note), v.note);
  });

  test('Skip the precheck rather than blocking when free disk space is unavailable', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[Resource allocation · disk precheck]');

  test('diskVerdict allows operation when there is enough space', () => {
    const v = diskVerdict(200 * 1024, 100 * 1024);
    assert.equal(v.ok, true);
    assert.equal(v.message, '');
  });

  test('diskVerdict reports how much is missing when space is insufficient (hints at the runtime disk)', () => {
    const v = diskVerdict(10 * 1024, 60 * 1024);
    assert.equal(v.ok, false);
    assert.ok(/insuficiente.*espacio|espacio.*insuficiente/i.test(v.message), v.message);
    assert.ok(/entorno de ejecución/i.test(v.message), v.message);
  });

  test('diskVerdict does not block when free space is unavailable', () => {
    assert.equal(diskVerdict(0, 60 * 1024).ok, true);
  });

  test('Precheck space for a 50GB-class package is estimated at 1.8x + 2GB', () => {
    const need = diskRequiredMB(50 * GB);
    assert.ok(need > 85 * 1024 && need < 95 * 1024, `Need ${need} MB`);
  });

  console.log('\n[Resource allocation · wiring checks]');

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('The built-in backend also provides resources()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'builtin is missing resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('The main process clamps out-of-range values and exposes a resource overview', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), 'Resource values are not clamped when saving settings');
    assert(/engine:resources/.test(mainSrc), 'Missing engine:resources IPC');
    assert(/runtime:resetAndResize/.test(mainSrc), 'Missing the reset + rebuild-with-new-capacity channel');
    assert(!/mumuMemoryGB|mumuCores/.test(mainSrc), 'Main process still contains third-party backend memory clamping logic');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('quickboot overlay disk reports errors honestly when in-place resize is blocked, not fake success', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), 'qcow2 overlay disk is not detected');
    assert(/needsReset: true/.test(emulatorSrc), 'needsReset is not marked when resize fails');
    assert(/fsGB/.test(emulatorSrc), 'dataInfo does not expose the actual filesystem size');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('Auto-tier memory/core limits follow the host instead of being hardcoded to 8GB/8 cores', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'doctor does not clamp memory to the host');
    assert(!/1536, 8192/.test(doctorSrc), 'doctor still hardcodes the 8192 limit');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
