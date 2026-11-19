'use strict';
/**
 * Actualización en línea: obtiene la última versión de GitHub Releases (RoutineMiku/apkstart), descarga y reemplaza in situ.
 *
 * Hay que cubrir tres formatos:
 *   - Instalador (NSIS): descarga `ApkBuddyStart-x.y.z-Setup.exe` e instala en silencio (/S);
 *   - Edición portable ligera (zip, el runtime se descarga bajo demanda): descarga `ApkBuddyStart-vX-win64-portable.zip`
 *     y tras descomprimir sobrescribe el directorio del programa: el directorio de runtime (%APPDATA%\apkstart\runtime), las apps instaladas
 *     y las instantáneas están todas en el directorio del usuario, así que reemplazar los archivos del programa no las toca;
 *   - Edición completa (portable pero con runtime): igual que la ligera, solo que el directorio incluye resources\runtime.
 *
 * El reemplazo no se puede hacer en este proceso (el exe está ocupado), así que se genera un script de PowerShell
 * y se entrega a un proceso independiente mediante EncodedCommand: espera a que este proceso salga → copia los archivos → vuelve a lanzar.
 * Se pasa el script en base64 en vez de escribir un .ps1 para esquivar problemas clásicos como «las rutas con caracteres chinos se decodifican como GBK»
 * (PowerShell 5.1 interpreta como ANSI los scripts sin BOM).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** Cadena entre comillas simples de PowerShell: un ' interno se escribe como '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Buscar un archivo por nombre (sin distinción de mayúsculas) en el primer nivel del directorio; devuelve el nombre real o null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Buscar el desinstalador NSIS en el directorio del programa; si no se encuentra, devuelve null.
 * El nombre por defecto de electron-builder es `Uninstall <productName>.exe` (updater.flavor lo reconoce),
 * pero las versiones antiguas / los empaquetados a medida también pueden llamarse `uninstaller.exe` (el código antiguo de main.js solo reconocía este).
 * Ambos sitios deben usar la misma regla, o en el instalador «Desinstalar con un clic» se confundiría con la edición portable (issue #51).
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() para sources: decide «si se usa GitHub o Gitee» y «si hay prefijo de espejo»
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Formato de instalación: instalador (con desinstalador) o paquete portable */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Comprobar actualizaciones: se pregunta a GitHub / Gitee en concurrencia, se toma la versión más alta y se unen los assets.
   * Las URLs concretas de descarga se ordenan después por velocidad real en prepare().
   */
  /**
   * @param {{force?:boolean}} [opts] con force=true se omite la caché de versiones de 10 minutos
   *        (si el usuario pulsa «Comprobar actualizaciones» debe obtener el resultado más reciente; la comprobación silenciosa al arrancar usa la caché)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // En la release cuelgan a la vez el «paquete portable» y el «paquete completo de runtime» (ApkBuddyStart-runtime-*.zip).
    // La coincidencia de respaldo .zip debe excluir el paquete completo de runtime: si alguna publicación solo trae el runtime y
    // no el portable, la lógica antigua lo tomaba como paquete de actualización y lo descomprimía en el directorio del programa (1,5 GB extra y el programa estropeado).
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Ojo con incluir parts: los paquetes fragmentados de Gitee no tienen una única url; si se pierde parts, queda «asset sin dirección»
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // El mismo asset está en GitHub y en Gitee: se conservan ambas direcciones y prepare() elige la más rápida midiendo.
          // sizes es «el tamaño de cada dirección por separado»: los bytes comprimidos por los dos orígenes no coinciden.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // La última versión de cada origen y cuál está inaccesible: la interfaz puede mostrar con total transparencia «qué origen se usó esta vez»
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Descargar y preparar la «carga útil»: la portable se descomprime en update/<ver>/payload; la instalación deja Setup.exe tal cual.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('Esta versión no tiene un paquete de instalación automática; descárgala manualmente desde la página de lanzamientos de GitHub');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee limita los archivos adjuntos a 100 MB, así que al publicar se corta el paquete en .part1/.part2.
    // Cada fragmento se mide por separado para elegir origen (pueden venir unos de Gitee y otros del espejo de GitHub),
    // y al terminar se unen en orden — para el usuario sigue siendo solo «descargar + descomprimir».
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Descargando ${it.asset.name}…` });
      // Candidatos = sitio original + prefijo de espejo; primero se descargan 256 KB de cada uno para medir la velocidad real y luego se baja por bloques del más rápido.
      // Es la única forma fiable cuando «GitHub directo va a decenas de KB/s y el espejo a varios MB/s»:
      // adivinar por dominio no sirve, la diferencia cambia mucho según la hora del mismo día.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // El tamaño total de la barra de progreso debe ser el del origen que se está descargando de verdad: los paquetes de GitHub y Gitee no son los mismos bytes
      // (distinto compresor, pueden diferir varios MB); si se coge el equivocado, se queda mostrando 92 % y de pronto salta a completado.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti: baja por bloques a la vez de «GitHub directo» y del «espejo», sumando ancho de banda;
      // si solo hay un origen disponible o el otro no admite Range, él mismo vuelve a bloques de un solo origen.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Descargando ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      // issue #98: si la vez anterior ya se descargó y descomprimió pero el reemplazo/reinicio falló,
      // se reutiliza esa carga sin volver a bajar 100 MB: esa es justo la causa del «bucle infinito de actualización».
      // La marca de listo la escribe esta función y la borra el script de reemplazo cuando tiene éxito, así que solo se reutilizan cargas completamente descomprimidas.
      if (this._payloadReady(out, it.version)) {
        this.onProgress({ stage: 'ready', percent: 100, message: 'Ya hay un paquete de actualización descargado; se reutilizará directamente' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Paquete de actualización descomprimido' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Paquete de instalación descargado' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Descargar y unir los paquetes fragmentados.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Descargando ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (Parte ${part.index}/${asset.parts.length} parte)${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Fragmento ${part.index} tamaño incorrecto (${buf.length} ≠ ${part.size}), se ha abortado, puedes reintentarlo`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`El tamaño del paquete de actualización ensamblado es incorrecto (${doneBytes} ≠ ${total}), se ha abortado, puedes reintentarlo`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // Anti zip-slip: se pasa por el guardián de zip.js (bloquea ../, rutas absolutas, letras de unidad y evasiones con barra invertida)
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Extrayendo ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** Archivo de marca de carga lista: se escribe solo tras descomprimir y guardar todo, para decidir reutilización entre procesos */
  _readyFile(payload) { return path.join(payload, '.apkstart-ready'); }

  _markPayloadReady(payload, version) {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now() }), 'utf8');
    } catch (_) { /* Si no se puede escribir la marca, se vuelve a descargar la próxima vez; no afecta a la corrección */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // Versión distinta = la vez anterior se descargó otra versión; no se puede reutilizar
      if (m.version !== version) return false;
      // Clave: el exe principal debe estar en la carga. Si no está, la descompresión se interrumpió o un antivirus lo borró.
      const exeName = path.basename(this.exePath || 'ApkBuddyStart.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Se llama al arrancar: recupera las actualizaciones «ya descargadas y descomprimidas, pero cuyo reemplazo/reinicio falló» y las continúa.
   * Usa directamente la carga local, sin volver a descargar (erradicación del bucle de la issue #98).
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // Solo se aceptan versiones más nuevas que la actual, para evitar reinicios repetidos
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * Generar y lanzar el script de «reemplazo + reinicio»; el llamador se encarga de salir de la aplicación.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] en pruebas se puede indicar otro pid / no lanzar de verdad
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // Esperar a que este proceso salga de verdad (máximo 90 s), o el exe/dll sigue ocupado
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // issue #98: el script antiguo solo comprobaba «si el exe de destino existe» — y ya existe, así que un copy
      // fallido se daba por bueno, se borraba la carga y se reiniciaba la versión antigua → al arrancar se volvía a detectar la actualización → bucle.
      // Ahora: antes de copiar se renombra el exe de destino a .old; tras copiar se confirma que el exe nuevo se guardó de verdad y que su número de bytes
      // coincide con la carga; si falla, se revierte .old y se **conserva la carga** para que el próximo arranque continúe.
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // Solo se limpian la carga y la marca de listo cuando se confirma que la copia salió bien; si no, se dejan para findResumableJob.
        `  try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // issue #98: un único Start-Process que falla en silencio → el usuario ve «se cerró pero no reinició».
      // Se añade -WorkingDirectory (recursos con rutas relativas en portable), y si falla se recurre a cmd /c start y se escribe en el log.
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // Si la copia falla, se conserva todo el directorio de versión (carga + marca de listo) para continuar en el próximo arranque;
      // si no, se diría «se conserva la carga» y justo después se borraría, y la continuación nunca encontraría los archivos.
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // Que falle la sentencia de limpieza final (directorio ya borrado / ocupado por el antivirus) no debe hacer creer al llamador que la actualización falló
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand usa UTF-16LE en base64: aunque el script contenga rutas con caracteres chinos, no se estropea al decodificar como GBK
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Aquí **no** se puede usar detached: ciertos antivirus / políticas de sandbox bloquean directamente «los procesos de consola separados»,
    // y el síntoma es que el script no se ejecuta en absoluto y la interfaz se queda en «Reemplazando el programa y reiniciando».
    // En Windows, salir del proceso padre no mata a los hijos normales, así que «hijo normal + unref» también sigue trabajando
    // después de que nosotros salgamos, y tiene mejor compatibilidad.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Cuando no se puede abrir la interfaz (o no hay assets instalables automáticamente), se entrega la página de la release al navegador */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
