'use strict';
/**
 * Autocomprobación de dos fuentes: un solo comando muestra "la versión más reciente de cada fuente" y "la velocidad real de cada URL de descarga".
 *
 *   node tools/check-sources.js            # Comprobar el paquete de actualización
 *   node tools/check-sources.js runtime    # Comprobar el paquete completo del runtime
 *
 * Descarga realmente 256 KB, así que consume algo de tráfico; el objetivo es confirmar antes de tocar el código
 * qué fuente conviene usar en esta máquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sources-'));
process.env.APPDATA = TMP;

const { Sources } = require('../src/core/sources');
const store = require('../src/core/store');
const { Provisioner } = require('../src/core/provision');

const mb = (n) => (n / 1048576).toFixed(2);
const host = (u) => { try { return new URL(u).host; } catch (_) { return u.slice(0, 40); } };

(async () => {
  const which = (process.argv[2] || 'update').toLowerCase();
  const sources = new Sources(() => store.getSettings());

  console.log('=== 1) Información de versiones de las dos fuentes ===');
  const rels = await sources.fetchReleases();
  for (const r of rels) {
    if (r.rel) {
      const assets = (r.rel.assets || []).length;
      console.log(`  ${r.name.padEnd(7)} ${String(r.rel.tag_name || r.rel.name || '').padEnd(10)} ${assets} recursos`);
    } else {
      console.log(`  ${r.name.padEnd(7)} Inaccesible: ${r.error}`);
    }
  }

  console.log('\n=== 2) Resultado combinado ===');
  const merged = await sources.latest();
  console.log(`  Versión más alta ${merged.tag} (${merged.assets.length} recursos)`);
  for (const a of merged.assets) {
    console.log(`    · ${a.name}  ${(a.size / 1048576).toFixed(0)}MB  [${a.source}]`);
  }

  console.log('\n=== 3) Velocidad real de cada URL de descarga ===');
  let target = null;
  if (which === 'runtime') {
    const p = new Provisioner(path.resolve(__dirname, '..'));
    const pack = await p.resolveRuntimePack().catch((e) => { console.log('  Error al resolver:', e.message); return null; });
    if (pack) {
      console.log(`  Paquete completo del runtime ${pack.name} (${pack.tag} · ${pack.from || '?'})`);
      target = pack.url;
    }
  } else {
    const pick = merged.assets.find((a) => /portable.*\.zip$/i.test(a.name)) || merged.assets[0];
    if (pick) {
      console.log(`  Paquete de actualización ${pick.name}`);
      target = pick.url;
    }
  }
  if (!target) {
    console.log('  No hay recursos que medir');
  } else {
    const cands = sources.candidates(target);
    for (const c of cands) console.log(`  ${host(c).padEnd(22)} ${c === target ? '(directo)' : '(espejo)'}`);
    const t0 = Date.now();
    const ranked = await sources.rank(cands, { onProgress: (p) => console.log('  ·', p.message) });
    console.log(`  La medición tardó ${Date.now() - t0} ms; orden final:`);
    ranked.forEach((u, i) => {
      const c = sources._rankCache.get(u) || {};
      console.log(`    ${i + 1}. ${host(u).padEnd(22)} ${c.ok ? `${mb(c.speed)} MB/s` : 'no disponible'}`);
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
