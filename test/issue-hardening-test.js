'use strict';
/**
 * Pure Node tests for issue-feedback hardening (no emulator/network/registry needed).
 *
 * Covers the 5 items implemented from this round of GitHub issue summaries:
 *  - #2 P0-1: APK package name not validated -> arbitrary path writes / adb command injection
 *  - #2 P0-4: provision/updater extraction without zip-slip protection
 *  - #2 P1-1: Promise never settles after _fetchText exceeds its limit
 *  - #51: installer one-click uninstall misjudged as portable (inconsistent uninstaller naming in two places)
 *  - #98: portable version does not restart after update download -> infinite loop (false-positive copy check + payload deleted)
 *
 * Run: node test/issue-hardening-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { validPackageName, safeFilePart } = require('../src/core/pkgname');
const { resolveZipEntry } = require('../src/core/zip');
const store = require('../src/core/store');
const { findUninstaller, Updater } = require('../src/core/updater');
const { Provisioner } = require('../src/core/provision');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-hardening-'));

(async () => {
  console.log('\n[issue #2 P0-1 · package name validation]');
  test('Valid Android package names pass', () => {
    for (const p of ['com.github.tvbox.osc', 'com.tencent.mm', 'org.example.app_2']) {
      assert.equal(validPackageName(p), true, `${p} should be valid`);
    }
  });
  test('Reject path traversal / drive letters / shell metacharacters / spaces', () => {
    for (const p of ['../evil', 'com..x', '.com.x', 'com/x', 'com\\x', 'C:evil', 'a;rm -rf', 'a|b',
      'a b', 'a$(id)', 'a`id`', '', 'com.x.', '1com.x', 'com.x-y']) {
      assert.equal(validPackageName(p), false, `${JSON.stringify(p)} should be rejected`);
    }
  });
  test('Invalid package names are rewritten into safe filenames', () => {
    const safe = safeFilePart('../evil');
    assert.ok(!safe.includes('/') && !safe.includes('\\') && !safe.includes('..'), `Rewritten name must contain no path characters: ${safe}`);
    assert.equal(safeFilePart('com.ok.pkg'), 'com.ok.pkg');
  });
  test('store icon/APK paths cannot escape the data directory', () => {
    const icon = store.iconPath('../../Windows/System32/drivers/etc/hosts');
    const apk = store.apkPath('../../evil', '../../x');
    assert.ok(!icon.includes('..'), `Icon path should not contain ..: ${icon}`);
    assert.ok(!apk.includes('..'), `APK path should not contain ..: ${apk}`);
    assert.match(path.basename(apk), /\.apk$/);
  });

  console.log('\n[issue #2 P0-4 · zip-slip]');
  test('Normal relative paths are allowed', () => {
    const root = path.join(TMP, 'zip-ok');
    assert.equal(resolveZipEntry(root, 'emulator/qemu.exe'), path.join(root, 'emulator', 'qemu.exe'));
    assert.equal(resolveZipEntry(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  });
  test('Reject ../ / absolute paths / drive letters / backslash traversal / UNC', () => {
    const root = path.join(TMP, 'zip-root');
    for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/Windows/x',
      'a\\..\\..\\evil', '\\\\server\\share\\x', 'a/../b']) {
      assert.equal(resolveZipEntry(root, n), null, `${JSON.stringify(n)} should be rejected`);
    }
  });
  test('Both provision and updater source have the zip-slip guard wired in', () => {
    const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'updater.js'), 'utf8');
    assert.ok(/resolveZipEntry\(/.test(prov), 'provision.extractZip must validate entry names');
    assert.ok(/resolveZipEntry\(/.test(upd), 'updater._extract must validate entry names');
  });

  console.log('\n[issue #2 P1-1 · _fetchText no longer hangs]');
  await atest('Over the size limit, the Promise settles instead of never resolving', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * 1024) });
      res.end(Buffer.alloc(64 * 1024, 0x61));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/index.xml`;
    try {
      const p = new Provisioner({});
      const out = await Promise.race([
        p._fetchText(url, 1024),
        new Promise((_, rej) => setTimeout(() => rej(new Error('_fetchText hung without settling')), 5000)),
      ]);
      assert.equal(out, '', 'Over-limit content must be discarded, not treated as complete');
    } finally {
      srv.close();
    }
  });
  test('_fetchText source contains a one-shot settle latch and a hard timeout', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    assert.ok(/let done = false/.test(src) && /const finish = \(\) =>/.test(src), 'A one-shot settle latch is required');
    assert.ok(/setTimeout/.test(src), 'A hard timeout fallback is required');
  });

  console.log('\n[issue #51 · uninstaller detection]');
  test('electron-builder Uninstall X.exe is recognized as an installer edition', () => {
    const dir = path.join(TMP, 'uninst-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Uninstall ApkBuddyStart.exe'), 'x');
    assert.equal(findUninstaller(dir), 'Uninstall ApkBuddyStart.exe');
  });
  test('Legacy uninstaller.exe is recognized too', () => {
    const dir = path.join(TMP, 'uninst-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uninstaller.exe'), 'x');
    assert.equal(findUninstaller(dir), 'uninstaller.exe');
  });
  test('Portable edition (no uninstaller) returns null', () => {
    const dir = path.join(TMP, 'uninst-c');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findUninstaller(dir), null);
  });

  console.log('\n[issue #98 · update-without-restart infinite loop]');
  await atest('A ready payload can be resumed; a version mismatch / missing exe makes it unusable', async () => {
    const dataDir = path.join(TMP, 'upd-resume');
    const exe = path.join(dataDir, 'ApkBuddyStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });

    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkBuddyStart.exe'), 'new');
    assert.equal(u.findResumableJob(), null, 'Should not reuse without a ready marker');
    u._markPayloadReady(payload, '0.5.4');
    const job = u.findResumableJob();
    assert.ok(job && job.version === '0.5.4', 'Should recover the 0.5.4 resumable job');

    // Version older than current -> do not reuse
    const cur = new Updater({ currentVersion: '0.5.4', exePath: exe, isPackaged: true, dataDir });
    assert.equal(cur.findResumableJob(), null, 'Payload not newer than the current version cannot be resumed');
    // Marker version mismatch -> do not reuse
    fs.writeFileSync(u._readyFile(payload), JSON.stringify({ version: '0.5.2' }));
    assert.equal(u.findResumableJob(), null, 'A mismatched marker version cannot be reused');
  });
  test('apply script verifies replacement by byte count, keeps failed payloads, and has two restart paths', () => {
    const dataDir = path.join(TMP, 'upd-apply');
    const exe = path.join(dataDir, 'ApkBuddyStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkBuddyStart.exe'), 'new-version-bytes');
    const script = u.apply({ mode: 'zip', payload, version: '0.5.4' }, { spawn: false });
    assert.ok(/\(Get-Item \$target\)\.Length -eq \$expected/.test(script), 'The new exe must be verified by byte count');
    assert.ok(/keeping payload for next launch/.test(script), 'A failed copy must keep the payload for resumption');
    assert.ok(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), 'Restart must have a fallback path');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Error:', e.stack || e.message);
  process.exit(1);
});
