'use strict';
/**
 * Pure logic tests for the local health check / auto-configuration: no Electron, no emulator, no real system changes.
 *
 * Two things are guarded:
 *   1. Conclusions must match plain language (if BIOS is disabled, say BIOS; if the Store edition cannot
 *      self-elevate, only provide an entry point);
 *   2. Auto-configuration writes only "safe" settings, and generated drivers must pass driver validation.
 *
 * Run: node test/preflight-test.js
 */
const assert = require('assert/strict');
const path = require('path');

const preflight = require('../src/core/preflight');
const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const hwBase = () => ({
  platform: 'win32',
  arch: 'x64',
  osBuild: 22631,
  cpu: {
    name: 'AMD Ryzen 7 7840HS', cores: 8, threads: 16,
    vtSupported: true, vtFirmware: true, slat: true,
  },
  memory: { totalMB: 32768, freeMB: 8192 },
  gpu: {
    name: 'AMD Radeon 780M', vendor: 'amd', vramMB: 2048,
    driverVersion: '31.0.12027.9001', driverDate: '2024-05-01', status: 'OK',
  },
  virtualization: {
    hypervisorPresent: true,
    hypervisorPlatform: 'enabled',
    vmPlatform: 'enabled',
    hyperV: 'disabled',
    winHvApi: true,
    vmCompute: true,
    aehdInstalled: false,
    accelOk: true,
    accelKind: 'whpx',
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

(() => {
  console.log('\n[Health check · resource recommendations]');

  test('32GB / 16 threads: recommend 8GB + 4 cores', () => {
    const r = preflight.recommendResources({ totalMB: 32768, cores: 16, accelOk: true, vramMB: 2048 });
    assert.equal(r.memoryMB, 8192);
    assert.equal(r.cores, 4);
    assert.equal(r.renderSize, 'auto');
  });

  test('8GB / 4 threads: recommend 3GB + 2 cores, not exceeding half the host', () => {
    const r = preflight.recommendResources({ totalMB: 8192, cores: 4, accelOk: true, vramMB: 1024 });
    assert.equal(r.memoryMB, 3072);
    assert.equal(r.cores, 2);
    assert.ok(r.memoryMB <= 8192 / 2);
  });

  test('4GB of memory still yields only 2GB, without overloading Windows', () => {
    const r = preflight.recommendResources({ totalMB: 4096, cores: 4, accelOk: false, vramMB: 256 });
    assert.equal(r.memoryMB, 2048);
    assert.equal(r.renderSize, '540x960', 'Resolution should be lowered when there is no acceleration');
  });

  test('No acceleration -> 540p; small VRAM -> 540p too', () => {
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: false, vramMB: 4096 }).renderSize, '540x960');
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: true, vramMB: 256 }).renderSize, '540x960');
  });

  console.log('\n[Health check · rendering backend recommendations]');

  test('Without acceleration, always software (first ensure something renders)', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: false, vramMB: 8192 }).gpuMode, 'software');
  });

  test('NVIDIA + acceleration -> host; AMD/Intel -> swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: true, vramMB: 8192 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
  });

  test('When the GPU model is unavailable, do not guess; return auto', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'unknown', accelOk: true, vramMB: 0 }).gpuMode, 'auto');
  });

  console.log('\n[Health check · scenario assessment]');

  test('All good: level=good, recommend host or swangle, do not force TCG', () => {
    const r = preflight.evaluate({ hw: hwBase(), settings: {} });
    assert.equal(r.level, 'good', r.summary);
    assert.equal(r.patch.engine.forceTcg, false);
    assert.equal(r.patch.engine.gpuMode, 'auto');
    assert.equal(r.recommended.gpuMode, 'swangle');
  });

  test('BIOS virtualization disabled: judge as bad, give only manual "enter BIOS" guidance, do not pretend one-click works', () => {
    const hw = hwBase();
    hw.cpu.vtFirmware = false;
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'bad');
    const item = r.items.find((i) => i.key === 'vt-bios-off');
    assert.ok(item, 'Missing BIOS hint');
    assert.equal(item.action.kind, 'manual');
    assert.equal(r.patch.engine.forceTcg, true, 'Software emulation should be locked when BIOS is disabled');
  });

  test('CPU without virtualization support: explain software emulation only, no BIOS-enabling guidance', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = false;
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'vt-unsupported'));
    assert.ok(!r.items.some((i) => i.key === 'vt-bios-off'));
  });

  test('Windows feature disabled + installer edition: offer "enable with one click (admin required)"', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.ok(item);
    assert.equal(item.action.kind, 'elevate');
    assert.equal(item.action.id, 'virtualization');
    assert.ok(/activar|habilitar/i.test(item.action.label));
  });

  test('Store edition cannot self-elevate: for the same issue, only open the "Windows Features" dialog', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'store' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.equal(item.action.kind, 'elevate');
    assert.ok(/Funciones de Windows/i.test(item.action.label), item.action.label);
    assert.ok(!/一键/.test(item.action.label));
  });

  test('No acceleration + installer edition: additionally offer an "install AEHD" entry point', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.hypervisorPlatform = 'disabled';
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const accel = r.items.find((i) => i.key === 'accel-off');
    assert.equal(accel.action.id, 'accel');
  });

  test('When Hyper-V takes over VT, a false WMI report must not be misjudged as "unsupported"', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = 'unknown';
    hw.cpu.vtFirmware = true;
    hw.cpu.slat = 'unknown';
    hw.virtualization.accelOk = true;
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'good', r.summary);
    assert.ok(!r.items.some((i) => i.key === 'vt-unsupported'));
  });

  test('VRAM unavailable / unknown GPU: give warn, not a fatal conclusion', () => {
    const hw = hwBase();
    hw.gpu = { name: '', vendor: 'unknown', vramMB: 0, driverVersion: '', driverDate: '', status: '' };
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-unknown'));
    assert.equal(r.level, 'warn');
  });

  test('An outdated GPU driver triggers an update reminder (a common cause of black screens)', () => {
    const hw = hwBase();
    hw.gpu.driverDate = '2019-03-01';
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-driver-old'));
  });

  test('Low memory / outdated OS are each flagged separately', () => {
    const hw = hwBase();
    hw.memory.totalMB = 4096;
    hw.osBuild = 18363;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'mem-low'));
    assert.ok(r.items.some((i) => i.key === 'os-old'));
  });

  console.log('\n[Health check · auto-configuration boundaries]');

  test('Auto-configuration writes only safe settings (no touching data partitions / resolution modes, etc.)', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    assert.deepEqual(Object.keys(r.patch.engine).sort(),
      ['autoMemory', 'cores', 'forceTcg', 'gpuMode', 'memoryMB', 'renderSize'].sort());
  });

  test('The auto-generated driver passes validation and its match is bound to this machine', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.deepEqual(v.driver.match.gpuVendor, ['amd']);
    assert.equal(v.driver.effect.gpuMode, 'swangle');
    assert.equal(v.driver.effect.forceTcg, null, 'forceTcg should not be written when acceleration is available');
  });

  test('A driver generated without acceleration locks software emulation', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.equal(v.driver.effect.forceTcg, true);
    assert.equal(v.driver.effect.gpuMode, 'software');
  });

  test('A failed probe must still produce a conclusion (unknown != crash)', () => {
    const r = preflight.evaluate({ hw: { platform: 'win32' } });
    assert.ok(['warn', 'bad'].includes(r.level));
    assert.ok(r.items.length >= 3);
    assert.equal(typeof r.summary, 'string');
  });

  test('collect() is asynchronous (does not block the UI)', () => {
    assert.equal(preflight.collect.constructor.name, 'AsyncFunction');
  });

  test('Assessment is a pure function: the same input must produce the same configuration', () => {
    const a = preflight.evaluate({ hw: {}, settings: {} });
    const b = preflight.evaluate({ hw: {}, settings: {} });
    assert.deepEqual(a.patch, b.patch);
    assert.deepEqual(a.driver, b.driver);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
