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
      assert.equal(made.id, 'builtin', `mode=${mode} 却创建了 ${made.id}`);
      assert.equal(made.backend.constructor.id, 'builtin', '实例类型不是 BuiltinBackend');
    }
  });

  test('显式传别的 id 也压不过去（回退路径不会再建出第三方底座）', () => {
    const made = backends.create({
      appRoot: ROOT, settings: { engine: { mode: 'builtin' } }, store, log: () => {}, id: 'mumu',
    });
    assert.equal(made.id, 'builtin', '显式 id=mumu 仍然被接受了');
  });

  test('自动挑选不再探测任何外部运行时', async () => {
    // 同步断言：autoPick 必须是「直接返回 builtin」，源码里不许出现 probe()
    const src = read('src', 'core', 'backends', 'index.js');
    assert(!/\.probe\(/.test(src), '注册表仍在探测外部模拟器');
    assert(!/mumu|fydeos|ldplayer|bluestacks/i.test(src.replace(/[\s\S]*?const REGISTRY[\s\S]*?\];/, '')),
      '注册表里还有第三方底座');
  });

  console.log('\n[独立运行 · 第三方底座代码已删除]');

  test('backends/ 下只有 base / builtin / index', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'core', 'backends')).sort();
    assert.deepEqual(files, ['base.js', 'builtin.js', 'index.js'], `实际：${files.join(', ')}`);
  });

  test('mumu / fydeos / mumu-compat / frame 模块都不在了', () => {
    for (const rel of [
      ['src', 'core', 'backends', 'mumu.js'],
      ['src', 'core', 'backends', 'fydeos.js'],
      ['src', 'core', 'mumu-compat.js'],
      ['src', 'core', 'frame.js'],
    ]) {
      assert.equal(exists(...rel), false, `${rel.join('/')} 仍然存在`);
    }
  });

  test('引擎里没有「第三方底座不可用 → 回退」这类分支', () => {
    const src = read('src', 'core', 'engine.js');
    assert(!/_fallbackFrom/.test(src), '还留着第三方底座的回退标记');
    assert(!/backend\.id !== 'builtin'/.test(src), '还有按底座 id 分叉的逻辑');
    assert(!/engine\.mode === 'attach'/.test(src), '还有 attach（连接已有运行时）分支');
    assert(!/ATTACH_ENDPOINTS/.test(src), '还在探测外部模拟器的 adb 端口');
  });

  test('设置页没有引擎模式下拉，也没有 MuMu / FydeOS 字段', () => {
    const html = read('src', 'ui', 'index.html');
    assert(!/setEngineMode/.test(html), '设置页仍有引擎模式下拉');
    assert(!/value="mumu"|value="fydeos"|value="attach"/.test(html), '设置页仍有第三方选项');
    assert(!/setMumuPath|setMumuMemGB|setMumuCores|setFydeosHost/.test(html), '设置页仍有第三方字段');
    assert(/id="setEngineLabel"/.test(html), '设置页缺少只读的运行时说明');
  });

  test('持久化层把残留的 mode / mumu* 字段就地改写', () => {
    const src = read('src', 'core', 'store.js');
    assert(/s\.engine\.mode = 'builtin'/.test(src), 'getSettings 没有强制 mode=builtin');
    assert(/mumuPath/.test(src) && /delete s\.engine\[k\]/.test(src), '没有清理残留的第三方字段');
  });

  test('adb 候选路径不含第三方模拟器自带的 adb', () => {
    const src = read('src', 'core', 'adb.js');
    const block = src.slice(src.indexOf('const COMMON_ADB_PATHS'), src.indexOf('];', src.indexOf('const COMMON_ADB_PATHS')));
    assert(!/mumu|ldplayer|bluestacks|hd-adb/i.test(block), '仍在借用第三方模拟器的 adb');
  });

  console.log('\n[独立运行 · 包内不许有别的模拟器]');

  test('守卫能认出 MuMu 二进制', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `命中数 ${hits.length}`);
    assert.equal(hits[0].vendor, 'MuMu 模拟器');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫能认出 MuMu 的目录（nx_main / nx_device / nemu）', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} 没被拦下`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('守卫也认雷电 / 蓝叠', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has('雷电模拟器'), '雷电没被拦下');
    assert.ok(vendors.has('蓝叠模拟器'), '蓝叠没被拦下');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫不会误伤我们自己的运行时', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/builtin.js', 64);
    touch(d, 'app/src/core/resources.js', 64);
    assert.equal(findBundled(d).length, 0, '把自家源码当成模拟器本体了');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫会拦第三方底座的适配器源码（防止又长回来）', () => {
    const d = tmpDir('guard-adapter');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/backends/fydeos.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    const hits = findForbiddenSource(d);
    assert.equal(hits.length, 3, `命中数 ${hits.length}（应为 3）`);
    const r = assertStandalone(d, { label: '测试', exit: false });
    assert.equal(r.ok, false, '适配器源码没让守卫失败');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫不会把普通的 frame.js / 业务 js 当成第三方底座', () => {
    const d = tmpDir('guard-other-js');
    touch(d, 'app/src/render/frame.js', 64);
    touch(d, 'app/src/core/backends/builtin.js', 64);
    assert.equal(findForbiddenSource(d).length, 0, 'core 外的 frame.js / builtin.js 不应被误判');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('干净的运行时目录不报错', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: '测试', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('目录不存在时跳过检查而不是崩掉', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'apkstart-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[独立运行 · 构建链路已接入守卫]');

  test('便携版打包会扫一遍 resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)/.test(src), 'pack.js 未接入守卫');
  });

  test('MSIX 打包会扫一遍载荷 app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'msix.js 未接入守卫');
  });

  test('打包只带 build/runtime（Google 运行时），没有别的模拟器目录', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), 'extraResources 里出现了第三方模拟器');
    assert(/build\/runtime/.test(head), 'extraResources 没有内置运行时');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
