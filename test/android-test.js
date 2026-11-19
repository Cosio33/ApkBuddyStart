'use strict';
/**
 * Pure Node tests for Android system settings (src/core/android.js): use a fake adb client to record commands
 * and return preset output; no emulator needed. Run: node test/android-test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AndroidSettings, volumeCmd, parseVolume, volumePercent } = require('../src/core/android');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

/** Fake runtime: shell() returns the outputs from replies in order and records the scripts it receives */
function fakeSettings(replies) {
  const scripts = [];
  const client = {
    async shell(script) {
      scripts.push(script);
      return replies.length ? replies.shift() : '';
    },
  };
  const runtime = { async ensure() { return { ok: true, client }; } };
  return { set: new AndroidSettings(runtime), scripts };
}

(async () => {
  console.log('\n[android.js volume]');

  await test('parseVolume reads the level and range', () => {
    const v = parseVolume('[V] will get volume\nvolume is 5 in range [0..15]\n');
    assert(v && v.index === 5 && v.min === 0 && v.max === 15, JSON.stringify(v));
    assert(parseVolume('media: inaccessible or not found') === null, 'Unrecognized output should return null');
    assert(parseVolume('') === null && parseVolume(undefined) === null, 'Empty output should return null');
  });

  await test('volumePercent converts a level to a percentage based on the range', () => {
    assert(volumePercent({ index: 0, min: 0, max: 15 }) === 0);
    assert(volumePercent({ index: 15, min: 0, max: 15 }) === 100);
    assert(volumePercent({ index: 5, min: 0, max: 15 }) === 33);
    assert(volumePercent({ index: 3, min: 0, max: 0 }) === 0, 'Should not divide by zero when the range is 0');
    assert(volumePercent(null) === 0);
  });

  await test('Volume commands prefer cmd media_session and fall back to media on old images', () => {
    const c = volumeCmd('--set 7');
    assert(c.indexOf('cmd media_session volume --stream 3 --set 7') >= 0, c);
    assert(c.indexOf('|| media volume --stream 3 --set 7') > c.indexOf('cmd media_session'), c);
    assert(!/^media volume/.test(c), 'Should not rely only on the media tool, removed since Android 11');
  });

  await test('setVolume converts the percentage to a level before setting it (Android 11+)', async () => {
    const { set, scripts } = fakeSettings(['volume is 4 in range [0..15]\n', '']);
    const r = await set.setVolume(60);
    assert(scripts.length === 2, `Should read the range first, then set it; got ${scripts.length} commands`);
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), scripts[0]);
    assert(scripts[1].includes('cmd media_session volume --stream 3 --set 9'), scripts[1]);
    assert(!scripts[1].includes('--set 60'), 'Should not treat the percentage directly as a level');
    assert(r.ok && r.volume === 60, JSON.stringify(r));
  });

  await test('setVolume converts on a different level range (0..25)', async () => {
    const { set, scripts } = fakeSettings(['volume is 10 in range [0..25]\n', '']);
    const r = await set.setVolume(100);
    assert(scripts[1].includes('--set 25'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('When the range is unavailable, use the common 0..15 and clamp to 0~100', async () => {
    const { set, scripts } = fakeSettings(['', '']);
    const r = await set.setVolume(250);
    assert(scripts[1].includes('--set 15'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('status() displays the level converted to a percentage', async () => {
    const out = ['wifi=1', 'air=0', 'font=1.0', 'density=320', 'animw=1.0', 'sdk=34', 'vol=volume is 6 in range [0..15]'].join('\n');
    const { set, scripts } = fakeSettings([out]);
    const s = await set.status();
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), 'Status should read the volume via media_session');
    assert(s.volume === 40, `Should be 40%, got ${s.volume}`);
    assert(s.sdk === 34 && s.wifi === true, JSON.stringify(s));
  });

  // Verify command fallback in a real shell: PATH contains only a fake `media` (simulating an old image
  // without cmd) plus a fake `cmd` (simulating Android 11+).
  if (process.platform !== 'win32') {
    await test('In sh: fall back to media when cmd is absent, do not call media when cmd exists', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-vol-'));
      const log = path.join(dir, 'calls.log');
      const write = (name, body) => {
        fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
        fs.chmodSync(path.join(dir, name), 0o755);
      };
      write('media', 'echo "volume is 3 in range [0..15]"');
      const run = () => execFileSync('/bin/sh', ['-c', `${volumeCmd('--get')} 2>/dev/null`], {
        env: { PATH: dir },
        encoding: 'utf8',
      });
      assert(parseVolume(run()).index === 3, 'Old images should read the volume via media');
      write('cmd', 'echo "volume is 8 in range [0..15]"');
      fs.writeFileSync(log, '');
      assert(parseVolume(run()).index === 8, 'Should read the media_session result when cmd exists');
      assert(!fs.readFileSync(log, 'utf8').includes('media volume'), 'Should not call media when cmd exists');
    });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
