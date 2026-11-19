'use strict';
/**
 * Pure Node tests for the issue #99 fix ("half-rendered display on non-100% scaled screens")
 * (no Electron/emulator needed).
 *
 * Root cause: detached-window mode fed Electron's DIP logical pixels directly to SetWindowPos in a
 * DPI-aware process (which expects physical pixels); at 125%/150% scaling the window was only 2/3
 * the size, offset, and clicks landed in the wrong place. Fix: multiply by scaleFactor via _physical()
 * before handing the rect to agent.layout.
 *
 * Coverage:
 *  - _physical conversion at 100%/125%/150%/175% (including negative coords and rounding)
 *  - sf=1 / missing sf leaves the rect unchanged
 *  - _area() carries an sf field from the same screen as area
 *  - Source-level: all three detached-mode layouts go through _physical, restore path does not double-multiply
 *
 * Run: node test/display-scale-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
// Only require the zero-dependency pure conversion module -- CI uses ELECTRON_SKIP_BINARY_DOWNLOAD=1,
// so requiring appwin.js directly would throw due to the missing electron binary (the original pitfall of this test).
const { physicalRect } = require('../src/core/geometry');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(() => {
  console.log('\n[issue #99 · DIP -> physical pixel conversion]');

  test('100% scaling: rect returned as-is (same object, zero overhead)', () => {
    const r = { x: 100, y: 60, w: 1280, h: 720 };
    assert.equal(physicalRect(r, 1), r, 'sf=1 should return the original object directly');
    assert.equal(physicalRect(r, 0), r, 'Missing-sf fallback should not change it either');
  });

  test('150% scaling: width, height and coordinates all scale up, with rounding', () => {
    assert.deepEqual(physicalRect({ x: 100, y: 60, w: 1280, h: 720 }, 1.5),
      { x: 150, y: 90, w: 1920, h: 1080 });
  });

  test('125% scaling: round to the nearest integer when fractions appear', () => {
    assert.deepEqual(physicalRect({ x: 33, y: 41, w: 1001, h: 777 }, 1.25),
      { x: Math.round(33 * 1.25), y: Math.round(41 * 1.25), w: Math.round(1001 * 1.25), h: Math.round(777 * 1.25) });
  });

  test('Negative coordinates (-8 gray-edge overflow) also scale proportionally, keeping the sign', () => {
    assert.deepEqual(physicalRect({ x: -8, y: 30 - 8, w: 900, h: 500 }, 2),
      { x: -16, y: 44, w: 1800, h: 1000 });
  });

  test('Fullscreen fill: workArea DIP x sf = physical resolution', () => {
    // At 150% scaling, the workArea of a 1920x1080 physical screen is about 1280x693 DIP
    const phys = physicalRect({ x: 0, y: 0, w: 1280, h: 693 }, 1.5);
    assert.equal(phys.w, 1920);
    assert.equal(phys.h, Math.round(693 * 1.5)); // ~1040, leaving room for the taskbar
  });

  console.log('\n[Source-level · all detached-mode layouts go through conversion]');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');

  test('appwin._physical delegates to the zero-dependency geometry.physicalRect', () => {
    assert(/require\('\.\/geometry'\)/.test(src), 'appwin should import geometry');
    const start = src.indexOf('_physical(rect, sf) {');
    const body = src.slice(start, start + 200);
    assert(/physicalRect\(rect/.test(body), '_physical must call physicalRect (so we test the real implementation)');
  });

  test('_area() returns sf, taken from the same screen as area', () => {
    const fn = src.slice(src.indexOf('_area() {'), src.indexOf('_scale() {'));
    assert(/scaleFactor/.test(fn), '_area must record scaleFactor');
    assert(/return \{[^}]*sf:/s.test(fn), '_area return value must include the sf field');
  });

  test('openDetached layout goes through _physical', () => {
    const start = src.indexOf('async openDetached(');
    const body = src.slice(start, src.indexOf('async embed(', start));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'The rect handed to agent.layout in openDetached must go through _physical first');
  });

  test('toggleMaximize fullscreen layout goes through _physical', () => {
    const start = src.indexOf('async toggleMaximize()');
    const body = src.slice(start, src.indexOf('openDetachedLayoutOnly(area) {'));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'Fullscreen in detached mode must also be converted');
    // The restore path uses physical pixels from the probe; it must never multiply again
    assert(/agent\.layout\(this\._preFullscreenRect\)/.test(body),
      'Restoring the physical rect from the probe must not convert twice');
  });

  test('openDetachedLayoutOnly layout goes through _physical', () => {
    const start = src.indexOf('openDetachedLayoutOnly(area) {');
    const body = src.slice(start, start + 600);
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'The path that restores the default size must also be converted');
  });

  test('Embedded mode _rect() keeps its own sf conversion (not broken by this change)', () => {
    const start = src.indexOf('_rect() {');
    const body = src.slice(start, start + 500);
    assert(/this\._scale\(\)/.test(body) && /\* sf/.test(body),
      'Embedded mode physical conversion must be preserved');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
