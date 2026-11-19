'use strict';
/**
 * Gestión unificada de orígenes de descarga: doble fuente (GitHub / Gitee) + prefijos de espejo.
 *
 * Conectar directamente a GitHub desde China tiene dos trampas:
 *   1. api.github.com a menudo tarda decenas de segundos en responder, o incluso agota el tiempo — el síntoma es «el check de actualización se queda girando»;
 *   2. La descarga de assets (objects.githubusercontent.com) limita cada conexión, normalmente a unos 100 KB/s —
 *      el paquete de runtime de 1,5 GB tardaría 4 horas.
 *
 * Así que aquí no se asume «quién es el origen principal», sino que se mide con bytes reales cada vez:
 *   - Info de versión: se pregunta a GitHub / Gitee **en concurrencia** y se usa quien dé primero una versión más alta;
 *   - URLs de descarga: se enumeran «GitHub directo / asset homónimo en Gitee / prefijo de espejo»,
 *     se descargan 128 KB reales de cada una, se ordenan por velocidad medida y se toma la más rápida.
 *
 * El resultado de la medición se cachea en memoria 30 minutos (las comprobaciones repetidas en el mismo proceso no vuelven a medir).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** Prefijos de aceleración de GitHub conocidos y funcionando. Solo participan en la medición si el usuario activa autoMirror y no ha definido uno propio. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * Número de bytes muestreados por medición.
 * 128 KB es demasiado poco: el handshake + TLS ya son cientos de ms, y la «velocidad» medida es sobre todo latencia,
 * lo que marca como lento un origen con mucha latencia pero gran ancho de banda. 256 KB separa ambas cosas y el tráfico es asumible.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Demasiadas redirecciones'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Dirección no válida')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkBuddyStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera de conexión agotado')));
    req.on('error', reject);
    req.end();
  });
}

/** Obtener un pequeño fragmento de JSON (con redirecciones, tiempo de espera y límite de tamaño) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Descargar un pequeño fragmento real de bytes para medir la velocidad.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // El rendimiento solo se calcula desde «que empiezan a llegar bytes»: los cientos de ms del handshake TLS + DNS son un coste fijo,
      // casi no afectan al total en un paquete de 1,4 GB, y mezclarlos en la velocidad sesga el juicio.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // El propio asset es más pequeño que la muestra: llegar a EOF también cuenta como éxito
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Aplicar el prefijo de espejo a una URL de asset de GitHub */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Los archivos adjuntos de releases de Gitee tienen un límite de 100 MB por archivo y el instalador de 105~110 MB no cabe, así que al publicar se corta en
 * xxx.zip.part1 / xxx.zip.part2. Aquí se reconstruyen los fragmentos en un único asset lógico:
 *   { name: 'xxx.zip', size: suma total, parts: [{index, size, urls:[...]}] }
 * Los fragmentos deben ser consecutivos desde part1; si no, se considera incompleto y se descarta (mejor usar el paquete entero que bajar uno roto).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Ojo: las entradas de assets de releases de Gitee solo traen name/url, **sin size**.
    // Exigir «size>0» como condición de integridad descartaría todo el grupo de fragmentos (tropezado en la práctica),
    // así que aquí solo se pide «fragmentos consecutivos + cada fragmento con dirección»; si se desconoce el tamaño, el progreso se muestra por bytes recibidos.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Lista de mirrors: primero los definidos por el usuario, luego los integrados (con autoMirror desactivado se usan solo los del usuario) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Caché del resultado de comprobación de versión: la API anónima de Gitee limita muy fuerte (tras unas pocas llamadas seguidas da 403),
    // y «si hay versión nueva» tampoco necesita frescura de segundos.
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Circuit breaker: cuando un origen se ve limitado / da error, se salta durante un tiempo en vez de chocar contra él en cada arranque
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** ¿Está este origen en periodo de corte? Devuelve null si está disponible; si no, el motivo para mostrar al usuario */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Se omite temporalmente (${Math.ceil((until - Date.now()) / 60000)} minutos sin volver a intentarlo)`;
  }

  /** Último release de cada origen (en concurrencia; el fallo de uno no afecta al otro) */
  /**
   * Respaldo sin API: seguir directamente el 302 de `/releases/latest` para obtener el tag.
   *
   * Por qué tiene que existir: la API anónima de GitHub solo permite 60 llamadas por IP y hora,
   * y la de Gitee es aún más estricta (en pruebas, unos pocos clics seguidos dan 403 Rate Limit Exceeded).
   * Tras un NAT de empresa/campus o de operador, es fácil que el usuario vea «falló la comprobación de actualización»,
   * mientras que el salto de la página `releases/latest` va por CDN y no consume cuota de API.
   *
   * Con el tag en mano, los nombres de asset se componen según la convención de publicación:
   *   ApkBuddyStart-<tag>-win64-portable.zip / ApkBuddyStart-<version>-Setup.exe / ApkBuddyStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Componer un release «mínimamente usable» a partir del tag (cuando no hay API) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkBuddyStart-${tag}-win64-portable.zip`,
      `ApkBuddyStart-${ver}-Setup.exe`,
      `ApkBuddyStart-runtime-${tag}.zip`,
    ];
    // Tanto GitHub como Gitee admiten la URL canónica /releases/download/<tag>/<nombre de archivo>
    // (en pruebas Gitee hace 302 a los adjuntos de foruda.gitee.com y se bajan los bytes completos),
    // así que sin API también se pueden componer URLs de descarga válidas. Los assets que no existen en Gitee dan 404,
    // y el ordenamiento por velocidad posterior los salta automáticamente.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // La API de releases de repositorios públicos se puede leer de forma anónima; si el repo es privado, Gitee responde 404
    // "Not Found Project" (no 401), y solo en ese caso hace falta rellenar aquí un token de solo lectura.
    // Además, las llamadas anónimas tienen límite de frecuencia; los usuarios interesados pueden poner un token para ampliarlo.
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // Si Gitee no tiene un release formal o GitHub está bloqueado, se vuelve a la lista y se toma el primero
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* Se sigue probando el respaldo sin API */ }
        // Respaldo cuando la API está limitada / bloqueada: el salto de la página da el tag y los nombres de asset se componen por convención
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* El respaldo tampoco funciona */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? '(Limitado de velocidad; se ha suspendido temporalmente el uso de esta fuente)'
          : (id === 'gitee' && !token ? '（puedes reintentarlo más tarde o indicar un token de solo lectura en los ajustes para aumentar el límite）' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Combinar las últimas versiones de ambos lados: gana la versión más alta, pero **la lista de assets se une**,
   * para que incluso si Gitee solo pone metadatos y los assets están en GitHub, se puedan probar las dos vías.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // El origen limitado se registra en el circuit breaker (se hace aquí y no dentro de fetchReleases para que «quién aporta
    // el resultado» se pueda sustituir/probar, y para garantizar que cualquier 403 de cualquier entrada dispare el corte)
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'Sin datos'}`).join('；');
      // Si todo falló pero tenemos el resultado anterior: mejor dar una info de versión «quizá antigua»
      // que dejar que la interfaz muestre un error directamente — al menos el usuario ve la versión actual y el enlace a la página de releases.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`No se puede conectar con el servidor de actualizaciones (${why}）`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Solo cuentan los assets de la misma versión (no se pueden usar assets de versiones antiguas de otro origen para instalar).
    // Si coexisten el paquete completo y el grupo de fragmentos con el mismo nombre, se prefiere el completo: los fragmentos requieren ensamblaje, un punto de fallo más.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Gitee cuelga automáticamente los «paquetes de código fuente» como assets (v0.3.2.zip / v0.3.2.tar.gz),
        // que no son instaladores y la regla `\.zip$` los descargaría como paquete de actualización — hay que excluirlos.
        // Los assets de nuestras publicaciones empiezan todos por ApkBuddyStart; usar esa lista blanca de prefijo es más seguro.
        if (!/^ApkBuddyStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // El mismo asset está en los dos orígenes (ahora que el paquete completo no se fragmenta es lo normal): se conservan todas las direcciones como candidatas.
    // Antes se «deducía por nombre y se usaba la primera» — como GitHub iba primero, la dirección de Gitee se perdía,
    // y «elegir automáticamente el origen con mejor red» degeneraba en usar solo GitHub. Ahora se elige por velocidad real (véase rank()).
    // El tamaño de cada dirección se guarda por separado: los paquetes de los dos orígenes no son los mismos bytes (compresor/máquina de build distinta, pueden diferir varios MB),
    // y downloadMulti solo mezcla direcciones que declaran el mismo tamaño total, así que jamás se debe promediar el tamaño de ambos.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Direcciones candidatas de un asset en todos los orígenes + espejos (sin duplicados y en orden: primero el sitio original, luego los espejos).
   * Los espejos solo se aplican a direcciones de GitHub: ghfast / gh-proxy solo proxyan GitHub,
   * y concatenar el enlace de Gitee solo produce un 403, una medición de velocidad desperdiciada.
   */
  candidates(assetOrUrl) {
    // Admite tres formas de entrada: una sola dirección, un objeto asset (url) o un objeto asset combinado (array urls con dos orígenes)
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Ordenar las direcciones candidatas por velocidad medida. La medición se cachea 30 minutos;
   * si todas fallan, se vuelve al orden original (para garantizar que «en el peor caso todavía se puede descargar»).
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Probando velocidad ${need.length} fuentes de descarga…` });
      // Se mide en serie y no en concurrencia: en paralelo se roban ancho de banda entre sí y el ranking pasa a ser «quien más fuerte empuja»,
      // no «quien es realmente más rápido». 256 KB por origen, normalmente unos segundos.
      // Un solo origen se abandona tras 6 s como máximo (antes 9 s × 4 orígenes = hasta 36 s sin ningún byte de progreso,
      // y el usuario ve «se quedó en Preparando el runtime»); un fallo en la medición solo lo coloca al final, no impide descargar.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* Dirección no válida, se muestra tal cual */ }
        onProgress?.({ stage: 'probe', message: `Probando la velocidad de la fuente ${i}/${need.length} fuentes:${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Fuente más rápida seleccionada: ${new URL(best).host} (aprox. ${(s / 1048576).toFixed(2)} MB/s）`,
      });
    }
    return sorted;
  }

  /** Vaciar la caché de medición (se llama cuando el usuario cambia el prefijo de espejo / cambia de red) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
