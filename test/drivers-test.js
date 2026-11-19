'use strict';
/**
 * Pure Node tests for the driver (compatibility patch) extension: no Electron, no emulator, no network.
 *
 * This guards the bottom line that "no matter how wild the user's JSON is, it can only change whitelisted
 * parameters; it cannot execute code or delete data on the machine", plus matching / stacking / import-export behavior.
 *
 * Run: node test/drivers-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-drv-${name}-`));
}

const HOST = {
  platform: 'win32',
  arch: 'x64',
  totalMB: 16384,
  cores: 8,
  gpuVendor: 'amd',
  gpuName: 'AMD Radeon 780M',
  cpuVendor: 'amd',
  osBuild: 22631,
  accel: 'whpx',
  emulatorVersion: '36.4.9',
};

const base = () => ({
  format: drivers.DRIVER_FORMAT,
  id: 'test-driver',
  name: 'Test Driver',
  version: '1.0.0',
  match: { any: true },
  effect: { gpuMode: 'swangle' },
});

(() => {
  console.log('\n[Drivers · validation]');

  test('All built-in examples pass validation (otherwise copying them would be wrong)', () => {
    const dir = path.join(ROOT, 'src', 'drivers');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(files.length >= 3, `Only ${files.length} built-in examples found`);
    for (const f of files) {
      const r = drivers.validateDriver(readJSON(path.join(dir, f)), { file: f });
      assert.equal(r.ok, true, `${f}: ${r.errors.join('；')}`);
    }
  });

  test('Reject an incorrect format outright', () => {
    const d = { ...base(), format: 'something-else' };
    const r = drivers.validateDriver(d);
    assert.equal(r.ok, false);
    assert.ok(/format/.test(r.errors.join('')));
  });

  test('Reject path traversal / spaces in id (id becomes the filename on import)', () => {
    for (const id of ['../evil', 'a b', 'x', 'name/../../etc/passwd']) {
      const r = drivers.validateDriver({ ...base(), id });
      assert.equal(r.ok, false, `id=${id} unexpectedly passed`);
    }
  });

  test('A wrong key name in match raises an error instead of silently doing nothing', () => {
    const r = drivers.validateDriver({ ...base(), match: { gpu: 'amd' } });
    assert.equal(r.ok, false);
    assert.ok(/match\.gpu/.test(r.errors.join('')));
  });

  test('A wrong field in effect raises an error', () => {
    const r = drivers.validateDriver({ ...base(), effect: { gpu: 'swangle' } });
    assert.equal(r.ok, false);
    assert.ok(/effect\.gpu/.test(r.errors.join('')));
  });

  console.log('\n[Drivers · whitelist (no data deletion / no code execution)]');

  test('Reject -wipe-data (it would erase user apps and saves)', () => {
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } });
    assert.equal(r.ok, false);
    assert.ok(/no permite -wipe-data/i.test(r.errors.join('')), r.errors.join('；'));
  });

  test('Reject -partition-size / -datadir / -sysdir', () => {
    for (const a of ['-partition-size=8192', '-datadir=D:/x', '-sysdir=D:/y']) {
      const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: [a] } });
      assert.equal(r.ok, false, `${a} unexpectedly passed`);
    }
  });

  test('-gpu only accepts known backends', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=host'] } }).ok, true);
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=../evil'] } });
    assert.equal(r.ok, false);
  });

  test('config.ini only allows whitelisted keys (no changing the data partition / location)', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle' } } }).ok, true);
    for (const k of ['disk.dataPartition.size', 'image.sysdir.1', 'hw.ramSize', 'hw.cpu.arch']) {
      const r = drivers.validateDriver({ ...base(), effect: { configIni: { [k]: '1' } } });
      assert.equal(r.ok, false, `${k} unexpectedly passed`);
    }
  });

  test('config.ini / env values must not contain newlines (prevent line injection)', () => {
    const a = drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle\nhw.ramSize=99999' } } });
    assert.equal(a.ok, false);
    const b = drivers.validateDriver({ ...base(), effect: { env: { ANDROID_X: 'a\nb' } } });
    assert.equal(b.ok, false);
  });

  test('env only allows ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefixes', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { env: { ANDROID_EMU_BACKEND: 'x' } } }).ok, true);
    for (const k of ['PATH', 'SystemRoot', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      const r = drivers.validateDriver({ ...base(), effect: { env: { [k]: 'x' } } });
      assert.equal(r.ok, false, `${k} unexpectedly passed`);
    }
  });

  test('Driver module contains no eval / new Function / dynamic require of user files', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'drivers.js'), 'utf8');
    assert(!/\beval\s*\(/.test(src), 'eval found');
    assert(!/new\s+Function\s*\(/.test(src), 'new Function found');
    assert(!/require\s*\(\s*(raw|d\.|driver)/.test(src), 'require based on driver content found');
  });

  console.log('\n[Drivers · matching]');

  test('gpuVendor hit / miss', () => {
    assert.equal(drivers.matchHost({ gpuVendor: ['amd'] }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuVendor: ['nvidia'] }, HOST).ok, false);
  });

  test('gpuName uses a regex (case-insensitive)', () => {
    assert.equal(drivers.matchHost({ gpuName: 'radeon\\s+780m' }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuName: 'geforce' }, HOST).ok, false);
  });

  test('Memory / cores / OS version match by range', () => {
    assert.equal(drivers.matchHost({ totalMB: { min: 8192 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ totalMB: { max: 8192 } }, HOST).ok, false);
    assert.equal(drivers.matchHost({ cores: { min: 8 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 22000 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 30000 } }, HOST).ok, false);
  });

  test('Emulator version compares numerically, not as a string (36.4.9 < 36.4.10)', () => {
    const host = { ...HOST, emulatorVersion: '36.4.9' };
    assert.equal(drivers.matchHost({ emulatorVersion: { max: '36.4.10' } }, host).ok, true);
    assert.equal(drivers.matchHost({ emulatorVersion: { min: '36.4.10' } }, host).ok, false);
  });

  test('accel matching: a machine without hardware acceleration only accepts tcg patches', () => {
    const noHv = { ...HOST, accel: 'none' };
    assert.equal(drivers.matchHost({ accel: ['none'] }, noHv).ok, true);
    assert.equal(drivers.matchHost({ accel: ['none'] }, HOST).ok, false);
  });

  test('Empty / non-matching match does not "default to a hit"', () => {
    assert.equal(drivers.matchHost({}, HOST).ok, false);
    assert.equal(drivers.matchHost(null, HOST).ok, false);
  });

  console.log('\n[Drivers · stacking and toggles]');

  test('Built-in examples are inactive by default (enabled:false); they only apply when enabled in the UI', () => {
    const d = { ...drivers.validateDriver(readJSON(path.join(ROOT, 'src', 'drivers', 'example-amd-igpu-swangle.json'))).driver };
    const off = drivers.resolve({ drivers: [d], host: HOST });
    assert.equal(off.applied.length, 0, 'Built-in example is active by default');
    const on = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: true } });
    assert.equal(on.applied.length, 1);
    assert.equal(on.effect.gpuMode, 'swangle');
  });

  test('state=false can override enabled:true in the file', () => {
    const d = drivers.validateDriver({ ...base(), enabled: true }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: false } });
    assert.equal(r.applied.length, 0);
  });

  test('Higher priority is applied later (overriding earlier gpuMode / same-named params)', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', priority: 0, effect: { gpuMode: 'software', emulatorArgs: ['-gpu=software'] } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', priority: 10, effect: { gpuMode: 'swangle', emulatorArgs: ['-gpu=swangle'] } }).driver;
    const r = drivers.resolve({ drivers: [b, a], host: HOST });
    assert.equal(r.effect.gpuMode, 'swangle');
    const gpus = r.effect.args.filter((x) => x.flag === '-gpu');
    assert.equal(gpus.length, 1, 'The same parameter was stacked twice');
    assert.equal(gpus[0].value, 'swangle');
  });

  test('ini / env are merged rather than overwriting each other wholesale', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', effect: { configIni: { 'hw.gpu.mode': 'swangle' }, env: { ANDROID_AA: '1' } } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', effect: { configIni: { 'hw.keyboard': 'no' }, env: { ANDROID_BB: '2' } } }).driver;
    const r = drivers.resolve({ drivers: [a, b], host: HOST });
    assert.deepEqual(r.effect.ini, { 'hw.gpu.mode': 'swangle', 'hw.keyboard': 'no' });
    assert.deepEqual(r.effect.env, { ANDROID_AA: '1', ANDROID_BB: '2' });
  });

  test('notes include the driver name so the UI can show who made the change', () => {
    const d = drivers.validateDriver({ ...base(), name: 'Old GPU Patch', effect: { notes: ['Disable hardware rendering'] } }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST });
    assert.deepEqual(r.effect.notes, ['Old GPU Patch：Disable hardware rendering']);
  });

  console.log('\n[Drivers · load / import / export]');

  test('A bad file only records an error, without affecting other drivers in the same directory', () => {
    const dir = tmpDir('load');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 1);
    assert.equal(r.errors.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Files over 256KB are not loaded as drivers', () => {
    const dir = tmpDir('big');
    fs.writeFileSync(path.join(dir, 'big.json'), `{"pad":"${'x'.repeat(300 * 1024)}"}`);
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 0);
    assert.ok(/demasiado grande|archivo.*grande/i.test(JSON.stringify(r.errors)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Import: after validation, save as <id>.json (filename does not come from user input)', () => {
    const src = tmpDir('src');
    const dst = tmpDir('dst');
    const f = path.join(src, 'any-name.json');
    fs.writeFileSync(f, JSON.stringify(base()));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(path.basename(r.file), 'test-driver.json');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('Import: a validation failure writes nothing to disk', () => {
    const src = tmpDir('src2');
    const dst = tmpDir('dst2');
    const f = path.join(src, 'bad.json');
    fs.writeFileSync(f, JSON.stringify({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } }));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(dst).length, 0, 'Bad driver was written to disk');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('The exported local template must itself be a valid driver', () => {
    const tpl = drivers.templateFromHost(HOST);
    const r = drivers.validateDriver(tpl);
    assert.equal(r.ok, true, r.errors.join('；'));
    assert.deepEqual(r.driver.match.gpuVendor, ['amd']);
  });

  console.log('\n[Drivers · wired into the startup chain]');

  test('buildArgs / env / config.ini all apply driver effects', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(ROOT);
    emu._driverEffect = {
      gpuMode: 'swangle',
      forceTcg: true,
      args: [{ flag: '-feature', value: 'Vulkan' }, { flag: '-gpu', value: 'host' }],
      ini: { 'hw.gpu.mode': 'swangle', 'hw.audioInput': 'yes' },
      env: { ANDROID_EMU_TEST: '1' },
      notes: [],
    };
    const args = emu.buildArgs({ gpu: 'host', accel: 'auto', memoryMB: 4096, cores: 4 });
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('-gpu'), 'swangle', 'Driver did not override -gpu');
    assert.equal(at('-accel'), 'off', 'forceTcg was not converted to -accel off');
    assert.equal(args.filter((a) => a === '-gpu').length, 1, '-gpu appears twice (the driver one was not skipped)');
    assert.equal(at('-feature'), 'Vulkan');
    const env = emu.env(ROOT, { accel: 'off' });
    assert.equal(env.ANDROID_EMU_TEST, '1');
    const ini = emu._iniWithDrivers('hw.gpu.mode=host\nhw.keyboard=yes\n');
    assert(/hw\.gpu\.mode=swangle/.test(ini), 'ini was not overridden');
    assert(/hw\.audioInput=yes/.test(ini), 'ini new key was not appended');
    assert.equal((ini.match(/hw\.gpu\.mode=/g) || []).length, 1, 'ini has a duplicate key');
    emu._driverEffect = null;
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
