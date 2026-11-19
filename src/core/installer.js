'use strict';
/**
 * Capa de orquestación de instalación / arranque / desinstalación.
 * Encadena en una sola canalización «analizar APK → instalar en el runtime → guardar metadatos locales → crear acceso directo en el escritorio».
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** El APK solo tiene bibliotecas nativas ARM (así es la inmensa mayoría de apps chinas) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Dividir un paquete de instalación (.apks / .xapk): extrae los APK fragmentados a un directorio temporal con nombre ASCII puro.
 * Se usa el lector ZIP basado en archivos + escritura en flujo: los paquetes divididos suelen superar los 2 GB y leerlos enteros en memoria fallaría.
 * Devuelve { meta, files, cleanup }; meta procede del APK base que contiene AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No se encontraron fragmentos de APK en este paquete (puede que no sea .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // Un único fragmento también puede ser de cientos de MB: se descomprime en flujo, sin pasar por Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* El fragmento no tiene manifiesto */ }
    }
    if (!meta) throw new Error('Error al analizar el APK base del paquete dividido');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

  /**
   * Dos copias: escritorio + menú Inicio.
   * El índice de búsqueda de Windows indexa los .lnk de «Menú Inicio \ Programas»; poner solo el del escritorio hace que no se encuentre;
   * en algunos equipos, OneDrive redirige el escritorio y la copia del menú Inicio garantiza que no se pierda la entrada.
   *
   * En Linux (FydeOS) el equivalente es el .desktop de freedesktop:
   * una copia en el escritorio y otra en el menú de aplicaciones ~/.local/share/applications.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Se pone en un subdirectorio propio: así lo indexa la búsqueda de Windows sin sobrescribir el acceso directo de una app de terceros con el mismo nombre
      // (en la práctica, «Hongguo, drama corto gratuito» ya estaba ocupado en el menú Inicio por otra utilidad de escritorio)
      out.push(path.join(this.ctx.startMenuDir, 'ApkBuddyStart', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

  /** La imagen de compatibilidad se descarga bajo demanda «al encontrar la primera app ARM» y, como capa base compartida de solo lectura, solo se descarga una vez */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'Primera instalación de una aplicación ARM: descargando la imagen compatible (unos 1,5 GB, solo una vez)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Fallo al descargar la imagen compatible; revisa la conexión e inténtalo de nuevo');
    return true;
  }

  /** Cambiar de imagen obliga a reiniciar el runtime; tras el reinicio se vuelven a cargar las apps instaladas desde la copia local de los APK */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Cambiando a la imagen compatible y reiniciando el entorno…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Se espera a que el dispositivo antiguo desaparezca de la lista de adb para que ensure() no lo trate como instancia reutilizable
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'El entorno no está disponible tras cambiar a la imagen compatible');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Restaurando las aplicaciones instaladas ${app.label}…` });
      } catch (_) { /* Si falla la restauración de una sola app, no se bloquea */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Analizando el APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Identificado ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // Juegos de 50 GB: primero se comprueba el espacio libre en el disco de datos del emulador, en lugar de avisar a mitad de instalación con
    // INSTALL_INSUFFICIENT_STORAGE (lo que el usuario ve es «estuvo instalando mucho rato y al final falló»).
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
            try { bytes += fs.statSync(f).size; } catch (_) { /* Se ignoran los archivos temporales */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* Se usa 0 como respaldo */ }
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
      // Que falle la detección de capacidad no debe bloquear la instalación
    }

    try {
      // Cero configuración: las apps que solo contienen bibliotecas ARM se completan automáticamente con una imagen que incluye la capa de traducción ARM, sin que el usuario toque ningún interruptor
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparando el entorno Android…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Entorno no disponible');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Instalar el cuerpo + guardar metadatos en disco + acceso directo; con un reintento de reparación automática si falla */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // Tras instalar, el estado del disco en la instantánea quickboot anterior queda obsoleto; conservarla haría que «la app recién instalada desapareciera al reiniciar»
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Actualizando la aplicación…' : 'Instalando la aplicación…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // Si aun así se llega aquí con un error de ABI, significa que el runtime actual es una imagen AOSP: se cambia automáticamente a una imagen compatible y se instala otra vez
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Imagen compatible activada; reinstalando…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Se guarda el icono en disco. Los iconos APK suelen ser WebP, que nativeImage no puede decodificar; se pasa al proceso de renderizado para decodificarlo +
    // una imagen de marcador de posición de respaldo, para garantizar que el .lnk siempre tenga icono (antes icoPath quedaba siempre en null).
    // iconFallback registra «no se pudo decodificar el icono real y se usó la imagen de marcador»: eso hay que avisarlo como advertencia leve,
    // si no, en el escritorio solo habría un triángulo verde y el usuario pensaría que ApkBuddyStart puso el icono equivocado.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* Si falla el icono, no afecta a la instalación */ }
    }

    // Se hace una copia del APK para poder reinstalarlo / recuperarlo más adelante
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // La entrada de arranque se rige por lo que resuelve el sistema: la «Activity principal» hallada en el APK suele no ser
    // la entrada LAUNCHER real, y usarla directamente se salta la página de inicialización de la app y provoca un cierre inesperado.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* Se conserva el resultado del análisis del APK */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      // Orientación vertical/horizontal natural de la app (calculada sin conexión desde el manifiesto del APK):
      // decide qué orientación usa el panel físico del emulador; solo con la misma orientación la imagen llena la ventana sin bordes negros.
      // Si el usuario ha configurado orientationOverride a mano, prevalece lo suyo; aquí solo se da el «valor por defecto».
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creando el acceso directo…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Error al crear el acceso directo:${e.message}` });
      }
    }

    // Aviso de compatibilidad: con solo bibliotecas nativas ARM, el runtime x86 necesita una capa de traducción
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`Esta aplicación requiere Android ${meta.minSdk}+, superior al entorno de ejecución actual; es posible que no funcione correctamente.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('No se pudo interpretar el icono de la aplicación (puede ser un icono adaptativo en un formato especial); el acceso directo usa un icono provisional.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('Error al decodificar el icono WebP; el acceso directo usa un icono provisional.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Al instalar la app se invalidó la instantánea antigua; aquí se programa otra: cuando haya reposo se guarda el estado «ya instalé la app nueva»,
    // o si no, el próximo arranque tendría que hacer un arranque en frío de nuevo (más de 20 s).
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} instalación completada`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    // El .desktop de Linux solo acepta rutas absolutas PNG/SVG; el ICO no sirve, así que se pasan las dos rutas y
    // writeShortcut elige según la plataforma. (Windows usa ico; FydeOS usa png)
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
      description: `${app.label} — ejecutado por ApkBuddyStart`,
      cwd: this.ctx.cwd,
      // Un AUMID por app: así la barra de tareas agrupa por aplicación en lugar de apilarlo todo dentro de ApkBuddyStart
      appUserModelId: `RoutineMiku.ApkBuddyStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Si falla la ruta principal (directorio de accesos directos personalizado no grabable / bloqueado por seguridad):
    // se vuelve a intentar en el escritorio — solo si hay icono en el escritorio encuentra el usuario la aplicación.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Error al crear el acceso directo');
    // La ruta de la copia del menú Inicio también se guarda, para borrarla al desinstalar
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Completar accesos directos e iconos que falten: las versiones antiguas solo creaban la del escritorio y el icono WebP no se convertía entonces */
  async ensureShortcuts() {
    const made = [];
    // Si el usuario desactivó explícitamente «crear automáticamente al instalar» y esta app no tenía ninguna entrada, no se añade nada por nuestra cuenta;
    // si no, con el interruptor apagado seguiría recreándose al arrancar.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* Si falla la creación del icono, no afecta a la entrada */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // Cuando el icono se acaba de crear, hay que reconstruir el .lnk aunque ya exista, para que el acceso directo muestre el icono real de la app
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* Si falla una sola entrada, no se bloquea el arranque */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
    // Se usa let: beforeStart puede reiniciar el runtime por «desacuerdo entre la orientación del panel y la de la app» y
    // devolver un rt nuevo (el client antiguo ya no sirve tras stop). Antes aquí había un const y, si se entraba de verdad
    // en la rama de reinicio, se lanzaba "Assignment to constant variable." y se cortaba todo el arranque —
    // el síntoma era «al cambiar a horizontal/vertical y pulsar una app, falla directamente».
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Entorno no disponible');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // La resolución se cambia antes de lanzar la app, para que un wm size no provoque un cambio de configuración que reconstruya la Activity recién iniciada
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Adaptación de pantalla omitida: ${e.message}`); return null; });
      // beforeStart puede devolver un rt nuevo (tras reiniciar el runtime, el client antiguo ya no sirve);
      // a partir de ahí se usa el nuevo. Si no devuelve nada, se sigue con el original.
      if (replaced && replaced.client) rt = replaced;
    }
    // Se limpian las posibles sobreescrituras de wm size / density y los ajustes de rotación automática que una versión antigua dejó en /data.
    // Estas sobreescrituras son persistentes; sin limpiarlas, cada arranque giraría la imagen 90° tumbada, con bordes negros y
    // los clics del ratón sin correspondencia (lo que los usuarios describen como «rotación con bordes negros / sin llenar / no se puede pulsar Aceptar»).
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Durante el arranque en frío ya se hizo una comprobación de red: si no hay red, se dice claramente. Si no, el usuario solo ve «esta app siempre sale negra»,
    // y nunca se le ocurre que es la máquina virtual la que no tiene red (una página que necesita red se queda como un fondo negro).
    // Arreglo clave: la asociación Wi-Fi suele llegar decenas de segundos después que sys.boot_completed; Hongguo al entrar tira de los datos de la portada,
    // y sin red la portada se dibuja como un bloque negro entero — esa es la verdadera causa de «tras pulsar Aceptar y continuar, sigue negro para siempre».
    // Por eso, antes de lanzar la app se espera a que la red esté lista (máximo 90 s): más vale esperar unos segundos que dejar al usuario con una pantalla negra.
    // Antes de lanzar, se mira la red: **solo se espera, no se reinicia**.
    // Antes aquí se llamaba a ensureNetwork(), que con una red lenta «apagaba la máquina virtual → arranque en frío»,
    // y el dispositivo adb desaparecía justo durante la instalación, convirtiéndose directamente en «no se abre Hongguo».
    // En la ruta de arranque no se pueden hacer acciones tan destructivas: si no se consigue red, se arranca igual y la página irá más lenta.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`Red de la máquina virtual lista ( ${net.ip || ''}）`);
      } else {
        // Si no se consigue red, se hace una reparación **no destructiva**: pulsar el AndroidWifi «guardado pero que no se conecta solo».
        // No reinicia la máquina virtual ni toca los datos del usuario: solo abre Ajustes y pulsa un punto de acceso guardado,
        // así que es seguro en la ruta de arranque.
        // En equipos reales, el «la máquina virtual nunca tiene red» se debe casi siempre a esto (véase emulator.repairWifi).
        onLog('La máquina virtual no puede conectarse a Wi-Fi; se está intentando reconectar…');
        try {
          // Ojo: repairWifi cuelga de engine (this.runtime), no de rt.
          // rt es el objeto devuelto por ensure() { ok, client, engine, ... } y dentro solo está client;
          // escribir rt.repairWifi daría undefined, y al llamarlo saltaría un TypeError que el catch se tragaría,
          // con el síntoma de «el log dice que está reconectando pero 1 ms después vuelve a decir que no hay red».
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
              onLog(`Se ha restaurado la red de la máquina virtual (${net.ip || ''}）`);
              // Clave: se guarda en la instantánea el estado «red ya conectada» de inmediato.
              // Si no se guarda, el próximo arranque volverá a restaurar la instantánea antigua «sin red» y habrá que reconectar otros diez segundos cada vez.
              // Se usa forceSnapshotSave porque se va a lanzar la app enseguida y nunca se alcanzaría el «reposo».
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* Si no se puede guardar, no afecta al arranque */ }
            }
          }
        } catch (e) {
          // No se trague la excepción en silencio: esta línea de log es la única prueba de si la reconexión llegó a ejecutarse.
          onLog(`Error al reconectar automáticamente a Wi-Fi:${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('La red de la máquina virtual aún no está lista; inicia la aplicación primero (las páginas con internet podrían cargarse un poco después)');
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // Puede ser que la app aún no esté instalada en el runtime actual (imagen reconstruida / datos borrados / primera vez) y lanzarla directamente dé
    // "Invalid packageName". Se instala primero desde la caché local y luego se arranca, así «abrir una app» siempre entra,
    // sin tener que instalarla a mano antes: es justo la experiencia que se quiere con «pulsar una app instalada y entrar directamente».
    // Clave: usar isInstalled() (pm path + comprobar uno a uno que los archivos APK existen de verdad) y no
    // `pm list packages`. Cuando la instantánea y la partición de datos no concuerdan, PackageManager sigue diciendo installed=true,
    // pero los archivos bajo /data/app ya se revirtieron — entonces am start falla sí o sí. Si la comprobación de archivos no pasa, se reinstala.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* Se trata como no instalada y se pasa a reinstalar */ }
      if (!installed) {
        onLog('Faltan archivos de la aplicación (la instantánea y los datos no coinciden); se está reinstalando automáticamente desde la copia de seguridad local…');
        // Antes de reinstalar se invalida la instantánea: si no, el packages.xml de la instantánea antigua sigue diciendo «instalada» y al próximo arranque volvería a fallar
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Error en la instalación automática: ${e.message}`));
      }
    }
    // Se observan 25 s y se exige «sobrevivir 5 s seguidos» para dar el arranque por bueno.
    // Clave: hay que distinguir «el proceso aún no ha arrancado» de «arrancó y luego desapareció». Antes, en cuanto pidof salía vacío se daba por fallo,
    // y las apps grandes (como Hongguo, que tarda más de diez segundos en arrancar la primera vez) se force-stopaban y reiniciaban a mitad de carga,
    // y solo a la tercera ronda arrancaban a duras penas: el usuario lo notaba como «pulsé y tuve que esperar un minuto».
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Se consulta antes de dormir: en el contenedor residente, un arranque en caliente suele mostrar el proceso en menos de 1 s,
        // y hacer sleep de 1 s primero retrasa a propósito la ruta más rápida un segundo entero.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // Había arrancado y desapareció = se ha caído de verdad
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // En cuanto aparece el proceso se engancha la imagen (sin esperar los 4 s de observación).
            // Esos 4 s son para «confirmar que no se va a caer enseguida», pero el usuario ve «pulsé y no pasa nada»;
            // dejarle ver la app cargando da mejor sensación que esconderla 4 s.
            // El callback es fire-and-forget: si falla, no afecta a la comprobación de supervivencia posterior.
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // Si en ningún momento apareció el proceso, es un fallo
    };
    try {
      // Primero se asegura de que los permisos del runtime estén completos: el -g de la instalación puede dejar de valer tras borrar datos,
      // y si faltan permisos el sistema para la app con un cuadro de autorización: lo que el usuario ve es «pulsé y no abre».
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // Con el cuadro de autorización delante, la app parece «no abrirse»; primero se completan los permisos y se cierra el aviso
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Solo se pasa a la capa superior si hay un log de cierre claro (puede haber que cambiar de imagen); sin pruebas, lo más probable es que solo vaya lento y baste reintentar
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // En cuanto la Activity arranca se fija la orientación. Se hace aquí porque el propio arranque de la app dispara
        // un cambio de configuración (reconstrucción de la Activity) y el user-rotation puesto antes puede volver a 0 —
        // en cuanto vuelve a 0, la imagen en el panel horizontal queda tumbada 90° (lo que el usuario ve es «no se endereza»).
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`La aplicación se cierra tras iniciarse (vez ${attempt} veces), reintentando automáticamente…`);
      }
      if (!ok) {
        // Respaldo: una salida anómala deja datos «a medio inicializar» y hace que fallen todos los arranques posteriores.
        // Se limpian una vez los datos de la app y se vuelve a lanzar: es lo que más éxito tiene (el usuario no tiene que ir a Ajustes a borrar la caché).
        onLog('La aplicación se cierra repetidamente; se están restableciendo sus datos para volver a intentarlo…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear también borra los permisos del runtime, hay que volver a concederlos o se quedará en el cuadro de autorización del sistema
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('La aplicación se cerró justo después de abrirla; se ha reintentado y se han reiniciado sus datos, sin éxito');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // El cierre viene de la capa de traducción ARM: se cambia de imagen automáticamente, se reinstala el APK de respaldo y se lanza otra vez
        onLog('Se detectó un fallo de la capa de traducción ARM; se está cambiando automáticamente a una imagen compatible…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* Se conserva el paquete original */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
