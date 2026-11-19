'use strict';
/**
 * Pure Node tests for boot authorization / install verification (no real emulator, no network).
 *
 * Covers root-cause fixes for two real 0.5.3 failures:
 *  1) A snapshot was taken before the "Allow USB debugging" dialog was confirmed -> every restore
 *     produced device unauthorized -> probing waited 240s x 4 and was misdiagnosed as a GPU issue.
 *     Fix: detect unauthorized, invalidate the old snapshot and cold-boot, save snapshots only when healthy.
 *  2) PackageManager reported installed=true but the /data/app files were lost due to snapshot/data
 *     inconsistency -> am start failed. Fix: isInstalled verifies each APK file really exists.
 *
 * Run: node test/boot-auth-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AdbClient, parseDeviceState, isUnauthorizedError, parsePmPaths,
} = require('../src/core/adb');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const adbDevices = (line) => `List of devices attached\n${line}\n`;

(async () => {
  console.log('\n[adb device state parsing]');
  test('unauthorized and authorized must be distinguishable (get-state cannot tell)', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tunauthorized'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tdevice'), 'emulator-5554'), 'device');
  });
  test('offline / no permissions / no device must all be reported accurately', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\toffline'), 'emulator-5554'), 'offline');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tno permissions'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices(''), 'emulator-5554'), 'no-device');
  });
  test('Only trust the status line for our own serial, ignore other devices', () => {
    const out = adbDevices('emulator-5556\tdevice\nemulator-5554\tunauthorized');
    assert.equal(parseDeviceState(out, 'emulator-5554'), 'unauthorized');
  });
  test('Error text matches unauthorized (including the official ADB_VENDOR_KEYS hint)', () => {
    assert.equal(isUnauthorizedError('error: device unauthorized.'), true);
    assert.equal(isUnauthorizedError("This adb server's $ADB_VENDOR_KEYS is not set. error: device unauthorized"), true);
    assert.equal(isUnauthorizedError('error: device offline'), false);
    assert.equal(isUnauthorizedError('error: no devices/emulators found'), false);
  });

  console.log('\n[pm path parsing + file existence verification]');
  test('pm path must parse all split APK fragments', () => {
    const out = 'package:/data/app/~~x/com.foo-1/base.apk\npackage:/data/app/~~x/com.foo-1/split_arm64.apk\n';
    assert.deepEqual(parsePmPaths(out), [
      '/data/app/~~x/com.foo-1/base.apk',
      '/data/app/~~x/com.foo-1/split_arm64.apk',
    ]);
  });
  test('pm path empty output = not installed', () => {
    assert.deepEqual(parsePmPaths(''), []);
    assert.deepEqual(parsePmPaths('Error: package not found'), []);
  });

  await atest('PM says installed but the APK file is gone -> isInstalled returns false', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      // File verification command: the file is gone, no PRESENT echo
      return '';
    };
    assert.equal(await c.isInstalled('com.foo'), false);
  });
  await atest('APK file really exists -> isInstalled returns true', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      return '__APKSTART_PRESENT__';
    };
    assert.equal(await c.isInstalled('com.foo'), true);
  });
  await atest('One of several split APKs is missing -> judged not installed (cannot launch)', async () => {
    const c = Object.create(AdbClient.prototype);
    const seen = [];
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) {
        return 'package:/data/app/~~x/com.foo/base.apk\npackage:/data/app/~~x/com.foo/split.apk';
      }
      seen.push(cmd);
      return ''; // both [ -s ] checks fail
    };
    assert.equal(await c.isInstalled('com.foo'), false);
    assert.ok(seen.some((s) => s.includes('/data/app/~~x/com.foo/split.apk')), 'Verification command must cover every split');
  });

  console.log('\n[Snapshot save guard]');
  await atest('adb unauthorized -> do not save a snapshot', async () => {
    const emu = Object.create(require('../src/core/emulator').EmulatorEngine.prototype);
    emu.port = 5554; // serial is a getter: emulator-${port}
    emu._log = [];   // log() pushes into this
    emu._adbGuestHealthy = async () => false;
    const ok = await emu._saveViaAdb('adb');
    assert.equal(ok, false, 'Saving is not allowed when unhealthy');
  });
  await atest('Source-level: the snapshot save path must go through the health guard first', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const fn = src.slice(src.indexOf('async _saveViaAdb('), src.indexOf('async _saveViaAdb(') + 700);
    assert.ok(/_adbGuestHealthy/.test(fn), '_saveViaAdb must check guest health first');
    const stopFn = src.slice(src.indexOf('async stop('), src.indexOf('async stop(') + 2400);
    assert.ok(/_adbGuestHealthy/.test(stopFn), 'stop() must also check health before shutdown');
    assert.ok(/invalidateSnapshot\(\)/.test(stopFn), 'An unhealthy shutdown must invalidate the snapshot');
  });
  await atest('Source-level: boot probing must detect unauthorized and self-heal with a cold boot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    const boot = src.slice(src.indexOf('async bootEmulator('), src.indexOf('async bootEmulator(') + 4200);
    assert.ok(/isUnauthorizedError/.test(boot), 'Probing must detect unauthorized from the error text');
    assert.ok(/deviceState\(\)/.test(boot), 'Probing must double-check via the devices state column');
    assert.ok(/invalidateSnapshot\(\)/.test(boot), 'A stuck authorization must invalidate the old snapshot');
    assert.ok(/_coldBoot = true/.test(boot), 'Must force a cold boot to re-inject the adb public key');
    assert.ok(/ADB_UNAUTHORIZED/.test(boot), 'Must give an accurate diagnosis, no longer misattributed to a GPU issue');
  });
  await atest('adb server injects ADB_VENDOR_KEYS to align host/guest keys', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    assert.ok(/ADB_VENDOR_KEYS/.test(src), 'The adb public key directory must be specified explicitly');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Error:', e.stack || e.message);
  process.exit(1);
});
