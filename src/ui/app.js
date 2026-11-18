'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Ahora mismo';
  if (d < 3600000) return `${Math.floor(d / 60000)} minutos atrás`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} horas atrás`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} días atrás`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限：
 * 安装失败时里面有「运行时启动日志」在持续推送，以前每条都新建一个 toast，
 * 于是屏幕上会不停叠加同一条错误，看起来像「失败信息一直循环」。
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重：同样的标题 + 正文（4 秒内）只刷新那一条，不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限：同时最多 4 条，超出先挤掉最旧的
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'Primer uso: abre Ajustes arriba a la derecha → Entorno de ejecución → Completar con un clic y vuelve aquí para instalar aplicaciones.'
      : 'Nota: todas las aplicaciones comparten el mismo entorno de ejecución de Android, por lo que iniciar la segunda aplicación es casi instantáneo.';
    grid.innerHTML = '';
    return;
  }

  // 末尾放一块「添加应用」虚线卡片。
  // 目的不只是好看：应用少的时候下面是一大片空白，用户不知道该干什么；
  // 这块卡片把「还能拖 APK 进来」这件事直接摆在眼前，也顺手填掉了空白。
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="En ejecución"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'En ejecución' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Cambiar a primer plano' : 'Abrir'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Arrastra el archivo APK aquí, o haz clic para seleccionarlo">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Agregar aplicación</div>
      <div class="meta">Arrastra un APK para instalarlo</div>
    </div>
  `;
}

/* ---------------- 数据刷新 ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} aplicaciones` : 'Sin aplicaciones';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Entorno no desplegado — abre Ajustes → Entorno y completa en un clic';
      tag.textContent = 'Necesita despliegue';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Entorno de ejecución listo · Android ${s.android || '?'}${s.freeform ? '· Ventana independiente activada' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Iniciando Android…';
      tag.textContent = 'Arrancando';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // 说清「怎么修」而不是只说「没开」——这句是状态条上最容易被看到的位置
      text.textContent = 'Aceleración de hardware desactivada: se ha recurrido a la emulación por software (muy lenta). Haz clic en «Revisión del entorno → Reparar» abajo a la derecha para activarla';
      tag.textContent = 'Emulación por software';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Falta la imagen de sistema universal de Android 14: descárgala en Ajustes → Entorno de ejecución (aprox. 1.5GB, solo una vez)';
      tag.textContent = 'Imagen pendiente de descarga';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'El motor del entorno de ejecución no está instalado: abre Ajustes → Entorno de ejecución y completa la configuración con un clic';
      tag.textContent = 'Necesita despliegue';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'El entorno de ejecución está listo: instala un APK o haz doble clic en el icono del escritorio para iniciar automáticamente';
      tag.textContent = 'Esperando arranque';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Instalador en ejecución: completa la instalación en la ventana de la máquina virtual';
      tag.textContent = 'Instalando';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Entorno de ejecución en espera (se inicia automáticamente al instalar o abrir una aplicación)'
        : 'El entorno de ejecución aún no tiene instalado el sistema Android: abre Ajustes → Entorno de ejecución para continuar';
      tag.textContent = s.installed ? 'En espera' : 'Pendiente de instalación';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // 网络状态：这是用户最容易踩的坑（应用里一直「网络错误」，但看不出是虚拟机没网）。
    // 直接摆在状态栏，出问题时一眼能看到，不用去翻日志。
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Red correcta ${s.network.ip || ''}`.trim() : 'La máquina virtual no tiene conexión a la red';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'La máquina virtual Android está conectada a la red; las aplicaciones que requieren conexión pueden cargarse con normalidad'
          : 'La máquina virtual de Android no tiene red; las páginas que requieren internet aparecerán en blanco o con errores. Puedes solucionarlo en «Ajustes → Reparar red»';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Error en la comprobación del estado: ${e.message}`;
  }
}

/* ---------------- 运行时部署（固定在设置里） ---------------- */

/**
 * 运行时/部署/自检面板现在都收在「设置」里，主界面只留已安装应用。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复用，语义改为「打开设置并定位到运行时」。
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // 启动即见已安装应用：不再用部署向导整屏接管主界面，
  // 状态只在设置里的运行时面板 + 底部状态条上体现。
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Motor');
    if (!imgDone0) missing.push('Imagen del sistema');
    stateText.textContent = s.deviceOnline
      ? `Listo · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Iniciando Android…'
        : allDone0
          ? 'Componentes completos · En espera de arranque (se inicia automáticamente al abrir la aplicación)'
          : `Falta ${missing.join('、')}${accelOk ? '' : '(Sin aceleración por hardware; se recurrirá a la emulación por software)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一个步骤：下载、参数自适应、开机全部由「一键完成」串起来，
  // 且首次启动会在后台自动跑，用户不需要逐步点击。
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('Cadena de herramientas de adb');
  if (!emuDone) left.push('Entorno de ejecución de Android');
  if (!imgDone) left.push('Imagen del sistema');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Todo listo' : 'Completar en un clic',
    tag: allDone ? 'Se completó automáticamente' : 'Automático',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} Listo · La ventana de la aplicación se adaptará automáticamente a la pantalla`
      : booting
        ? 'Iniciando Android…'
        : allDone
          ? 'Todos los componentes están listos; haz doble clic en cualquier APK o icono del escritorio para iniciar automáticamente'
          : `Faltan ${left.join('、')}; haz clic en «Completar con un clic» abajo: se instalará todo en segundo plano y se iniciará automáticamente`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Detener entorno de ejecución</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparando…' : (allDone ? 'Completado · Haz clic aquí para volver a revisar' : 'Completar en un clic');
  // 「上次为什么没起来」优先显示落盘的失败记录：进程重启后内存里的 diagnosis 是空的，
  // 只显示 autoProfile 会让用户完全看不出原因（issue #20/#25 的报告就是这样）。
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Error en el último inicio: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Diagnóstico automático del último arranque:${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Totalmente automático: sin elegir imagen, sin activar aceleración, sin ajustar memoria';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行，所有子步骤的进度都落在这唯一的进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // 一次调用把 adb / 引擎 / 系统镜像全装完，进度统一显示在唯一那一行
    // 用户点「一键部署」属于明确的手动重试，绕过失败冷却
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Error de preparación', body: (r && r.error) || 'Compruebe la red e inténtelo de nuevo', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Componentes listos; arrancando automáticamente…', body: 'La primera vez, unos 1-3 minutos; después, solo unos segundos.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Entorno listo', body: 'Ahora arrastra un APK a la ventana o haz doble clic en el icono del escritorio.', type: 'ok' }
      : { title: 'El inicio no se completó', body: (started && started.error) || 'Exporta el informe de diagnóstico para ver la causa', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Error de preparación', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Ya hay una tarea de implementación en curso' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Instalando el controlador de aceleración por hardware…',
        body: 'Haz clic en «Sí» en la ventana emergente «¿Permitir?»',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Aceleración de hardware habilitada', type: 'ok' });
      else t.update({ title: 'La aceleración no está habilitada', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Paso desconocido' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'No se puede iniciar el entorno de instalación', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'Ventana de la máquina virtual abierta', body: 'Sigue los 6 pasos de abajo para completar la instalación; cuando termines, haz clic en «Ya completé la instalación».', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Instalación completada, el entorno de ejecución se ha tomado el control', body: 'Ahora puedes arrastrar el APK directamente para instalarlo.', type: 'ok' });
}



/* ---------------- 安装 ---------------- */

/** 把安装失败翻译成「下一步该做什么」，只对最常见的几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Error desconocido');
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|ENOSPC/i.test(s)) {
    return `${s}
La partición de datos de Android es insuficiente: ve a Ajustes → Rendimiento y uso de recursos, aumenta el tamaño de la partición de datos de Android y haz clic en «Ampliar ahora».`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}
Este paquete solo tiene bibliotecas ARM; se cambiará automáticamente a una imagen compatible y se volverá a intentar.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}
Mismo nombre de paquete pero distinta firma (habitual si se instaló desde otra fuente). Haz clic derecho en la tarjeta de la aplicación y elige «Desinstalar» antes de volver a instalar.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}
La versión instalada es superior; desinstálala primero desde el menú contextual y vuelve a instalar.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}
Este paquete de instalación es demasiado grande o hay memoria insuficiente, y el sistema rechazó el análisis. Comprueba que haya suficiente espacio en disco y memoria y vuelve a intentarlo;`
      + 'Si sigue fallando, cambia la ruta del paquete de instalación a una ruta corta solo en inglés (p. ej., D:\\a.apk).';
  }
  return s;
}

/* 当前那条「正在安装…」的 sticky 提示。install:error 事件要能把它收掉：
 * 主进程是先 send('install:error') 再让 invoke 失败的，两者都可能到得很晚，
 * 只靠 catch 收会出现「报错了右下角还在转圈」。 */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Ya hay una tarea de instalación en curso', body: 'Espera a que termine de instalarse la aplicación actual antes de continuar.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Instalando ${name}`, body: 'Analizando el APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Instalando ${pr.meta.label}` : `Instalando ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} instalado`, body: r.app.shortcutPath ? 'Se ha creado el acceso directo en el escritorio; haz doble clic para abrirlo directamente.' : 'Puedes crear un acceso directo en el escritorio haciendo clic derecho en la tarjeta de la aplicación.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} nota de compatibilidad`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // 先把那条「正在安装…」的 sticky 提示收掉，否则它会一直转圈、还继续被
      // 运行时日志刷新 —— 用户看到的就是「失败信息一直在循环」。
      // 错误提示统一由下面的 install:error 监听器负责（带文件名与中文原因），
      // 这里不再重复弹一条。
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- 应用操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Abriendo ${app ? app.label : pkg}`,
    body: 'El primer arranque requiere precalentar el entorno de ejecución; espera un momento…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // 应用有自己的窗口，主界面自动收起；这里只留一句提示，然后隐藏窗口
    t.update({ title: 'Iniciado', body: 'La aplicación se está ejecutando en una ventana independiente (puedes girar la pantalla desde la parte superior).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Acceso directo en el escritorio creado', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Error al crear el acceso directo', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Confirmar desinstalación de "${app.label}»?

Los datos de la aplicación también se borrarán, y se eliminará el acceso directo del escritorio.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Desinstalado', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Error al desinstalar', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Abrir aplicación', kbd: 'Enter' },
  // 只在应用真的在运行时才出现（见 showMenu 里的过滤）。
  // 以前完全没有这一项，独立窗口模式下又没有可点的关闭按钮，
  // 应用一起来就关不掉，只能退到托盘退出整个 ApkBuddyStart。
  { key: 'stop', label: 'Cerrar aplicación', onlyRunning: true },
  { key: 'shortcut', label: 'Crear acceso directo en el escritorio' },
  { key: 'pin', label: 'Fijar arriba' },
  { key: 'keymap', label: 'Asignación de teclas…' },
  { divider: true },
  { key: 'reveal', label: 'Abrir la ubicación del APK' },
  { key: 'clear', label: 'Borrar los datos de la aplicación' },
  { divider: true },
  { key: 'uninstall', label: 'Desinstalar', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Desanclar' : 'Fijar arriba') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'Cerrado', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Error al cerrar', body: (r && r.error) || 'Error desconocido', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Error al cerrar', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Limpiar «${app.label}» de todos los datos? Esta operación no se puede deshacer.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Se borraron los datos', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Error al limpiar', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * 按键映射预设选择器。用 confirm + prompt 做最简交互（不引入新 UI 组件）。
 * 后续可以做成更精致的弹窗编辑器。
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('0. Borrar el mapeo actual');
    const msg = `Para «${label}» para seleccionar un preset de mapeo de teclas:

${lines.join('\n')}

Introduzca el número:`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // 取消
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: 'Asignación de teclas borrada', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: 'Número no válido', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `Aplicado «${chosen.label}」`, body: `${label} · el teclado estará listo para usar al abrir la aplicación`, type: 'ok' });
  } catch (e) {
    toast({ title: 'Error al configurar la asignación de teclas', body: e.message, type: 'error' });
  }
}

/* ---------------- 设置 ---------------- */

// ---------------- 安卓系统设置 ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Leyendo…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Entorno de ejecución no listo (${String(r.error).slice(0, 36)}）` : 'Entorno no iniciado';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi activado' : 'Wi-Fi desactivado'}` +
    `${r.airplane ? ' · modo avión' : ''} · volumen ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Aplicado') : `Error:${(r && r.error) || 'El entorno de ejecución no está listo'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi activado' : 'Wi-Fi desactivado'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Modo avión activado' : 'Modo avión desactivado'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Animaciones del sistema activadas' : 'Animaciones del sistema desactivadas, interfaz más rápida'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Tamaño de fuente ajustado'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Tamaño de pantalla ajustado'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Se ajustó el volumen'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Optimizado: animaciones desactivadas, restricciones de segundo plano relajadas, lista blanca de batería' : 'Error en la optimización; es posible que el entorno de ejecución no se haya iniciado' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Es necesario abrir la aplicación una vez para que se inicie el entorno de ejecución' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** 设置页字段同步：只剩自带运行时，所有资源项都露出来，不再按底座切换 */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** 本机资源上限 + 当前分配（设置页里那几行灰字） */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : 'Desconocido');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || 'No se puede leer temporalmente la información de asignación de recursos';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `Local ${gb(host.totalMB)} memoria / ${host.cores} núcleos;`
    + `La memoria se puede dividir en un máximo de ${gb(lim.maxMB)}, núcleos máximos ${Math.max(1, (host.cores || 1) - 1)} (reservando 1/4 de memoria y 1 núcleo para Windows en cada caso).`
    + `Límite de la partición de datos ${lim.maxGB || 0} GB${free ? `(espacio restante en el disco: ${(free / 1024).toFixed(1)} GB）` : ''}。`
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** 本机体检：渲染报告（每条带等级点和可执行动作） */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || 'La revisión del sistema no devolvió resultados, inténtalo de nuevo';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Procesando…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: 'La operación no se completó', body: 'Puedes volver a intentarlo más tarde o seguir las indicaciones manualmente' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: 'Cancelado', body: 'No se modificaron los ajustes del sistema' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? 'La aceleración de hardware ya está disponible' : (reboot ? 'Aplicado; es necesario reiniciar' : 'Aplicado'),
            body: r.already ? '' : (reboot ? 'La aceleración de hardware solo surte efecto tras reiniciar el equipo; vuelve y haz clic en «Iniciar revisión del sistema» para confirmarlo' : 'Puedes hacer clic en «Iniciar revisión del sistema» para confirmar el resultado'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: 'No se pudo completar automáticamente', body: (r.error || r.note || 'Siga las indicaciones para hacerlo manualmente') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary}. Configuración recomendada:${Math.round((rec.memoryMB || 0) / 1024)} GB de memoria / `
      + `${rec.cores || 2} núcleos / ${rec.renderSize || 'auto'} · renderizado ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? '(Versión de tienda: las características del sistema solo se pueden activar manualmente en «Características de Windows»)' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Revisando el sistema…';
  if (sum) sum.textContent = 'Comprobando virtualización, tarjeta gráfica y memoria… (la primera vez unos 2~3 segundos)';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || 'Error en la revisión del sistema' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** 驱动（兼容补丁）：渲染清单 + 命中状态 */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? 'Sin aceleración por hardware' : (host.accel || 'Desconocido');
    sum.textContent = `Local:${host.platform || ''}/${host.arch || ''} · ${host.gpuVendor || 'Desconocido'} tarjeta gráfica · ${accel}`
      + ` · emulator ${host.emulatorVersion || 'Desconocido'}; controlador ${drivers.length} elementos, ya activos en este equipo ${onCount} elementos.`
      + (errors.length ? ` ${errors.length} archivos fallaron al cargar (ver abajo).` : '');
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: 'Error al guardar', body: (res && res.error) || 'Inténtalo de nuevo más tarde' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = 'Aplicado';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = 'Ejemplo integrado';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · aciertos:${d.hits.join(' / ')}` : ' · no coincide con este equipo');
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = 'Aún no hay controladores. Puedes hacer clic en «Exportar plantilla local» para crear uno, o importar un JSON preparado por otra persona.';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = 'No se puede leer la lista de controladores (es posible que el entorno de ejecución aún no esté implementado)';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'zh-CN';
  if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === false ? 'detached' : 'embed';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Error al leer la información de la partición de datos'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // 有 quickboot 差量盘时底座镜像的大小不等于 guest 看到的容量（实测 8GB 镜像、guest 5.7GB），
  // 与其显示一个会误导人的数字，不如明确说「以运行时为准」。
  const img = info.overlay
    ? 'Disco diferencial de inicio rápido (la capacidad real se rige por /data del entorno de ejecución)'
    : (info.fsGB ? `Sistema de archivos real ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : 'Aún no creado'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Desconocido';
  const pending = Number(info.pendingGB) > 0
    ? ` objetivo ${info.configuredGB} GB aún no surte efecto: Android está usando un disco diferencial de inicio rápido; es necesario «Restablecer datos de Android» y reconstruir con la nueva capacidad (esto borrará las aplicaciones instaladas).`
    : '';
  el.textContent = `Partición de datos actual: ${img}${auto ? '(Automático)' : ''} · Quedan ${free}。${pending}`
    + 'Si el juego indica «Espacio de almacenamiento insuficiente», aumenta este valor y haz clic en «Ampliar ahora»; cuando se puede ampliar in situ, no se pierden las aplicaciones instaladas.';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Asociado · Haz clic para cancelar' : 'No asociado · Haz clic para activar';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Modo automático'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · se pueden recuperar ${u.reclaimableText}（${u.count} elementos)` : ' · ya está en estado simplificado'}`
      : 'Estadísticas no disponibles';
  }).catch(() => { $('usageText').textContent = 'Estadísticas no disponibles'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- 软件更新 ---------------- */

let lastUpdate = null;

/** 把一次检查结果画到设置面板（也用于启动时静默检查推送过来的状态） */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Error en la revisión:${info.error || 'La red no está disponible'}`;
    // 检查失败也要给一条出路：直接把发布页打开，用户至少能手动下载。
    // 以前这里是「什么都不显示」，用户只会觉得「更新功能坏了」。
    showUpdateBtn(true);
    btn.textContent = 'Abrir la página de descarga';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // 如实说明这次是哪个源给出的版本、另一个源为什么没参与 ——
    // 用户排查「为什么检查更新很慢」时，这一行比任何日志都直接。
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? '(caché sin conexión, puede no ser la más reciente)' : '';
    st.textContent = `Se encontró una nueva versión ${info.tag}${src ? `（${src}）` : ''}${bad ? `；${bad} inalcanzable` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Actualizar ahora' : 'Abrir la página de descarga';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Novedades:
${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '(caché sin conexión)' : '';
    st.textContent = `Ya es la versión más reciente (v${info.current}）${src ? ` · a través de ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Error de actualización:${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Error al actualizar', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Actualizando…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Comprobando…';
      $('updateState').textContent = 'Conectando con GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Se encontró una nueva versión ${info.tag}`, body: 'Haz clic en «Actualizar ahora» para descargar e instalar automáticamente', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Ya es la última versión', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Error en la revisión:${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Actualizando…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Actualizar ahora';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Error de actualización:${r.error}`;
        toast({ title: 'Error al actualizar', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Descargada la v${r.version}, reiniciando para completar la instalación…`;
    }
  });

  // 打开设置时如果还没结果，就顺手查一次（放后台，不打扰）
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: 'Error al aplicar', body: (r && r.error) || 'Inténtalo de nuevo más tarde' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: 'Configurado según este equipo',
        body: `Memoria ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} núcleos / ${r.recommended.renderSize}`
          + (r.driverFile ? '; se ha generado el controlador y se aplicará automáticamente en el próximo arranque' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: 'No se pudo escribir el controlador', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: 'No se puede abrir la carpeta de controladores' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: 'Error al importar', body: (r.errors || []).slice(0, 3).join('；') });
        return;
      }
      toast({ type: 'ok', title: 'Controlador importado y habilitado', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: 'Error al exportar' }); return; }
      toast({ type: 'ok', title: 'Se exportó la plantilla', body: 'Tras modificar effect, colócalo en la carpeta de controladores y haz clic en «Actualizar» para que surta efecto' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // 内存 / 核心：填了具体值就关掉「自动」，填 0 又回到自动。
  // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
  // 于是「手动填了内存」一直被忽略 —— 这是设置页最容易被当成“没用”的一项。
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Estrategia de recursos cambiada', body: 'Surte efecto la próxima vez que se abra la aplicación', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: 'Idioma del sistema actualizado', body: 'Se aplicará tras el próximo reinicio del entorno de ejecución de Android', type: 'ok' });
    });
  }
  if ($('setChineseIme')) {
    $('setChineseIme').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked } });
      toast({
        title: e.target.checked ? 'Método de entrada en chino activado' : 'Método de entrada en chino desactivado',
        body: 'Se aplicará tras el próximo reinicio del entorno de ejecución de Android',
        type: 'ok',
      });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Selecciona primero una capacidad', body: '«Automático» significa que el software lo decide según el espacio libre en disco; no hace falta ampliar', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: '¿Ampliar ahora la partición de datos de Android?',
        message: `Ajustará /data a ${gb} GB (ampliación in situ; se conservarán las aplicaciones instaladas y los datos guardados).`,
        detail: 'Para ampliar, primero debes cerrar las aplicaciones de Android en ejecución; cuando termine, la próxima vez que abras una aplicación se reiniciará el sistema, lo que añadirá unos diez segundos.',
        okLabel: 'Iniciar expansión',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Expandiendo…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // 快速启动的差量盘挡着：就地扩容做不到，只能按新容量重建 /data。
        // 这是明确的数据丢失操作，必须单独再确认一次。
        const again = await api.confirm({
          title: 'Es necesario restablecer los datos de Android para poder ampliar',
          message: `Android está usando un disco diferencial de inicio rápido y no se puede ampliar in situ. Para obtener ${gb} GB de espacio; es necesario reconstruir /data con la nueva capacidad.`,
          detail: 'La reconstrucción borrará las aplicaciones instaladas y sus datos (el emulador y la imagen no se ven afectados). ¿Confirmas que quieres continuar?',
          okLabel: 'Vaciar y reconstruir',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = 'Reconstruyendo…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? 'Reconstruido con la nueva capacidad' : 'Error al reconstruir',
          body: rr && rr.ok
            ? `La próxima vez que se abra la aplicación se usará ${gb} GB para reconstruir /data (la primera vez habrá que esperar unas decenas de segundos)`
            : (rr && rr.error) || 'Error desconocido',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Partición de datos ampliada' : 'Error en la expansión',
        body: r && r.ok ? `Ahora aproximadamente ${r.fsGB || r.imageGB || gb} GB disponibles` : (r && r.error) || 'Error desconocido',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/卸载钩子，不用等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? 'Asignación de teclado activada' : 'Asignación de teclado desactivada', type: 'ok' });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来，否则影响是持久的
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'Componentes del sistema restaurados', body: 'Recorte profundo desactivado; se están restaurando los paquetes en segundo plano', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'Modo compatible con ARM activado', body: 'También necesitas descargar la imagen compatible con Google Play (Android 14, aprox. 1.5GB); haz clic en el botón de abajo para empezar', type: 'info' });
    else if (on) toast({ title: 'Modo compatible con ARM activado', body: 'Surte efecto tras reiniciar el entorno de ejecución', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Cambiado a pantalla completa' : 'Se cambió a la ventana vertical', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Pantalla completa automática activada' : 'Pantalla completa automática desactivada', body: 'Surte efecto al abrir la aplicación la próxima vez', type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? 'Configurado para seguir a la aplicación' : (mode === 'landscape' ? 'Se forzó la horizontal' : 'Se forzó la vertical'),
        body: mode === 'auto'
          ? 'La próxima vez que abras la aplicación se elegirá el panel según su propia orientación; si no coincide, se reiniciará el entorno de ejecución una vez.'
          : 'La próxima vez que abras la aplicación se reiniciará el entorno de ejecución una vez para cambiar el panel a la orientación indicada; después no se reiniciará de nuevo.',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? 'Se activó el diseño de tableta' : 'Se desactivó el diseño de tableta',
        body: 'Surte efecto la próxima vez que abras la aplicación (se reiniciará el entorno de ejecución una vez para cambiar la densidad lógica).',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'El panel se configuró en horizontal' : 'El panel se configuró en vertical',
        body: 'La próxima vez que abras la aplicación se reiniciará el entorno de ejecución una vez para cambiar la orientación física del panel (unos diez segundos); después no volverá a reiniciarse.',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Se actualizó el tamaño de la pantalla', body: 'Toma efecto la próxima vez que abras una aplicación o cambies de aplicación', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    state.settings = await api.setSettings({ display: { windowEmbed: embed } });
    toast({
      title: embed ? 'Se volvió al modo integrado' : 'Se cambió al modo de ventana independiente',
      body: 'Surte efecto la próxima vez que abras la aplicación. En modo independiente, el emulador abre su propia ventana para la pantalla de Android y gestiona tanto la orientación como el escalado.',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Se completaron los accesos directos' : 'Los accesos directos siguen ahí',
      body: r && r.fixed && r.fixed.length ? r.fixed.join('、') : 'Los accesos de escritorio y menú de inicio funcionan correctamente',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Se exportó el informe de diagnóstico', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Error al exportar', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Ya está en modo simplificado', body: 'No hay imágenes ni instantáneas antiguas que se puedan recuperar.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Limpieza completada',
        body: `Liberado aproximadamente ${(r.saved / 1048576).toFixed(0)} MB（${r.removed.length} elementos), se conservan las aplicaciones instaladas.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · se pueden recuperar ${u.reclaimableText}（${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error en la limpieza', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 重置安卓数据：二级确认（先确认意图，再确认不可撤销），清完刷新占用统计
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: '¿Restablecer los datos de Android?',
        message: 'Esto restaurará el sistema Android a un estado limpio, «recién instalado»:',
        detail: '• Eliminar todas las aplicaciones de terceros instaladas (incluidas Hongguo, juegos, etc.) y sus datos y sesiones de inicio\n'
          + '• Eliminar la instantánea de inicio rápido del AVD actual\n'
          + '• La imagen de sistema no se ve afectada; al volver a abrir la aplicación se hará otro arranque en frío para crear los datos\n\n'
          + 'Esta operación no se puede deshacer. ¿Continuar?',
        buttons: ['Cancelar', 'Continuar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirmar una vez más',
        message: 'Las aplicaciones instaladas y sus datos se eliminarán permanentemente. ¿Confirmas que quieres restablecer?',
        detail: 'Tranquilo: la imagen de sistema, los demás AVD, la caché de APK locales y los iconos no se modificarán.',
        buttons: ['Cancelar', 'Confirmar restablecimiento'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Error al restablecer', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      toast({
        title: 'Se restablecieron los datos de Android',
        body: `Liberado aproximadamente ${r.reclaimedMB} MB; se ha borrado el registro de aplicaciones instaladas.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · se pueden recuperar ${u.reclaimableText}（${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al restablecer', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 修复网络：安卓里联网页面一直黑屏（红果点「同意并继续」后整屏黑）时用。
  // 根因是虚拟机 /data 里的 Wi-Fi 配置坏了，wlan0 没起来、没有默认路由。
  // Play Store 镜像不允许 root，只能整体重置 /data；应用清单保留，点开时会自动重装。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Reparar la red de la máquina virtual?',
        message: 'Si las páginas que requieren internet dentro de la aplicación aparecen siempre en negro o cargando, normalmente es porque la máquina virtual de Android no tiene red.',
        detail: 'La reparación se intentará por orden, de menor a mayor coste:\n\n'
          + '1. Arranca en frío la máquina virtual (sin cargar la instantánea) y espera a que haya red: no afecta a ningún dato\n'
          + '2. Si sigue sin funcionar, restablece los datos de Android: la lista de aplicaciones se conserva y se reinstalarán automáticamente al abrirlas,\n'
          + '   Pero se perderán el estado de inicio de sesión, el historial de series, etc., dentro de la aplicación\n\n'
          + 'Solo afecta al AVD actual; la imagen de sistema y la caché de APK locales no se modifican. El proceso completo tarda unos 1–5 minutos. ¿Continuar?',
        buttons: ['Cancelar', 'Iniciar reparación'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'La red aún no se ha restaurado',
          body: (r && r.error) || 'Si tras restablecer la máquina virtual sigue sin haber red, comprueba si la red/firewall local está bloqueando el emulador.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'La red se restauró',
        body: `${(r.network && r.network.ip) || 'Conectado'}${r.wiped ? '(Se restablecieron los datos de Android para reparar la red; las aplicaciones se reinstalarán automáticamente al abrirlas)' : '(no se tocaron sus datos)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Error en la reparación', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 清理旧版本残留：扫描旧程序目录 / 失效卸载项 / 更新临时文件，确认后一次性清掉。
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Error en el análisis', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Muy limpio', body: 'No se han encontrado restos de versiones anteriores.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`…además hay ${items.length - 8} elementos`);
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Limpiar los restos de versiones anteriores?',
        message: `Encontrados ${items.length} elementos restantes, aprox. ${mb} MB：`,
        detail: `${lines.join('\n')}

Solo se eliminan «la carpeta de la versión anterior / las entradas de desinstalación obsoletas / los archivos temporales de actualización»,`
          + 'No se modificará la versión actualmente en ejecución ni tus datos de aplicaciones.',
        buttons: ['Cancelar', 'Iniciar limpieza'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Error en la limpieza', body: (c && c.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `，${c.failed.length} elementos ocupados que no se eliminaron` : '';
      toast({
        title: 'Restos de versiones anteriores eliminados',
        body: `Eliminar ${c.removed.length} elementos, se liberaron ${c.freedMB || 0} MB${failNote}。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · se pueden recuperar ${u.reclaimableText}（${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error en la limpieza', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // 重建快捷方式：桌面图标被误删 / 被安全软件拦掉时的兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Se reconstruyeron los accesos directos', body: fixed.join('、'), type: 'ok' }
        : { title: 'Los accesos directos están todos', body: 'No hay entradas que reconstruir', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // 共享目录：先浏览选目录，再「保存并迁移」把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Nueva carpeta seleccionada', body: 'Haz clic en «Guardar y migrar» para mover los archivos antiguos', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Complete o examine primero la carpeta', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Se actualizó la carpeta compartida', body: moved ? 'Los archivos existentes en la carpeta antigua se han migrado a la nueva carpeta' : 'Guardado', type: 'ok' });
    } else {
      toast({ title: 'Error al guardar', body: r.error, type: 'error' });
    }
  });

  // 一键卸载 ApkBuddyStart 本体（取消 .apk 关联 + 启动卸载程序；便携版手动删除）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('¿Confirmar la desinstalación de ApkBuddyStart?\n\nSe cancelará la asociación de archivos .apk y se eliminará el programa. Esta acción no se puede deshacer.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'La versión portátil no se puede desinstalar automáticamente',
        body: `Elimina manualmente el directorio del programa (${r.exeDir}) y la carpeta de datos (${r.dataDir}）`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Error al desinstalar', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Desinstalando…', body: 'Se ha iniciado el desinstalador; ApkBuddyStart se cerrará en breve', type: 'ok', sticky: true });
  });

  // ARM 兼容镜像下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Iniciando la descarga de la imagen compatible con ARM', body: 'Preparando…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Descargar imagen compatible con ARM', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'Imagen compatible con ARM lista', body: 'Surte efecto tras reiniciar el entorno de ejecución', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', progress: null });
        t.dismiss();
        toast({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Error al descargar la imagen compatible', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // 兼容镜像状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Listo (${(env.playImage.size / 1073741824).toFixed(2)} GB）` : 'Sin descargar';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Se actualizó la carpeta de datos', body: 'Reinicia ApkBuddyStart para que surta efecto (los datos anteriores no se moverán automáticamente)', type: 'ok', sticky: true });
  });

  // 安卓数据目录（AVD + 快照）：真正吃盘的那块，单独指到别的盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Carpeta de datos de Android actualizada',
        body: 'Reinicia ApkBuddyStart para que surta efecto. La carpeta apkstart.avd de la ubicación anterior se puede mover completa a la nueva y luego eliminar la antigua.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Iniciando…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Listo:${r.engine}` : `Error al iniciar:${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Máquina virtual integrada detenida';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'No asociado · Haz clic para activar';
      btn.dataset.on = '0';
      toast({ title: 'Asociación de .apk cancelada' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Asociado · Haz clic para cancelar';
      btn.dataset.on = '1';
      toast({ title: 'Asociación de .apk activada', body: r.ok ? 'Ahora, al hacer doble clic en un APK se instalará directamente en ApkBuddyStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统浏览器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 状态标签也当入口：点「需要部署 / 引导中 / Android 14」直接进设置的运行时面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署：入口已收进设置，这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上的自检计数：点开就是设置里的运行时面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Operación fallida', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'Se importó la imagen del sistema', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Se importó el disco virtual', body: 'Puede iniciar el entorno de ejecución directamente', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Iniciando el entorno de ejecución…', body: 'El primer arranque requiere iniciar el sistema Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Entorno listo', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'La sesión del entorno de ejecución ha terminado' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 共享目录入口移到设置里：同步 + 打开都在「文件互通」组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Se sincronizó la carpeta compartida', type: 'ok' });
    } catch (_) {
      toast({ title: 'Error de sincronización', body: 'Se omitirá la sincronización cuando el entorno de ejecución no esté listo', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // 「添加应用」卡片没有 data-pkg，走安装流程而不是启动。
    // 直接转调工具栏那个「安装 APK」按钮，复用它的文件选择逻辑。
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // 拖放安装
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Solo se pueden arrastrar archivos .apk', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「正在安装…」那条一直转圈（可能来自双击 APK 的另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Error de instalación:${name}` : 'Error de instalación',
      body: friendlyInstallErrorText((p && p.message) || 'Error desconocido'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // 应用被关掉（托盘「关闭当前应用」、右键菜单、或窗口被关）后要刷新「运行中」标记
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 启动 8 秒后才拿到更新信息：欢迎卡若还开着，把「发现新版本」这条补进去
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- 启动欢迎卡 ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Ya es de noche';
  if (h < 11) return 'Buenos días';
  if (h < 13) return 'Buen mediodía';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** 决定要不要弹：开机自启必弹；手动打开则每天最多一次，且用户可永久关闭 */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // 冒烟截图时不要弹欢迎卡：否则每次自动截图都被它挡住主界面
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, bienvenido de nuevo`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkBuddyStart${ver ? ` v${ver}` : ''} · ${ready ? 'Entorno de ejecución listo, ábrelo y úsalo' : 'El entorno de ejecución se preparará automáticamente cuando sea necesario'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Aplicaciones instaladas' },
    { k: ready ? 'Listo' : 'En espera', v: 'Entorno de ejecución de Android' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Dispositivo / puerto' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** 提示区单独渲染：启动 8 秒后才拿到更新信息，那时卡片可能还开着，需要补一次 */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`Nueva versión disponible <b>${esc(lastUpdate.tag || '')}</b>, puedes actualizar con un clic en «Ajustes → Actualización de software»`);
  }
  if (!apps) {
    tips.push('Arrastra un APK a la ventana para instalarlo; al terminar se creará automáticamente un icono en el escritorio');
  } else {
    tips.push('Haz doble clic en la tarjeta de una aplicación para ejecutarla en una ventana independiente; arriba a la derecha puedes girar / escalar / cerrar');
  }
  tips.push('Cerrar la ventana solo sale de esa aplicación; el entorno Android se mantiene, así que la próxima vez se abre más rápido');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- 环境自检 ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck：把问题渲染到设置里的自检面板，并在状态条上留一个计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检失败不阻断主流程 */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // 「组件缺失」在同一个面板的一键完成里已经覆盖，不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅：只在底部状态条上留一个可点的计数，点开就是设置里的自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} elementos por reparar` : `${issues.length} notas`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Revisión del entorno superada, no se encontraron problemas que afecten la ejecución.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Verificar de nuevo</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Revisión del entorno</span>
      ${errs ? `<span class="ec-count">${errs} graves</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} notas</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Verificar de nuevo</button>
      <button class="btn primary sm" id="btnEnvFixAll">Reparar todo</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Reparar</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'No se encontró el paquete de instalación integrado', body: 'Se ha abierto la página oficial de descarga de Microsoft; descarga la versión x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'El entorno de ejecución de VC++ está instalado', type: 'ok' }
        : { title: 'Instalación incompleta', body: r.error || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Activando aceleración de hardware…', body: 'Haz clic en «Sí» en la ventana emergente', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Aceleración de hardware habilitada', body: r.restartNeeded ? 'Reinicia el equipo para obtener el mejor rendimiento' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // 商店（MSIX）版：包固定 mediumIL，通常拿不到管理员授权。
        // 与其让用户点一个注定失败的按钮，不如直接把「启用或关闭 Windows 功能」
        // 对话框弹出来，并告诉他勾哪一项。
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: 'Debe activarse manualmente una vez (solo una vez)',
          body: r.note || 'En la ventana que se abrió, marca «Plataforma de hipervisor de Windows», acepta y reinicia el equipo.',
          type: 'info',
          sticky: true,
        });
      } else if (r.cancelled) {
        t.update({ title: 'Cancelado', body: r.error || 'No se obtuvo la autorización de administrador; no se modificó la aceleración por hardware.', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        t.update({ title: 'No se pudo activar', body: r.error || r.note || 'Inténtalo de nuevo', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // 主进程会弹出原生确认框（含可释放空间预览），这里不再重复 confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Error en la limpieza', body: 'Inténtalo de nuevo', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Limpieza completada', body: `Liberado aproximadamente ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Se recomienda moverlo a una carpeta solo en inglés', body: 'Cambia «Directorio de datos del entorno» en Ajustes → Integración del sistema y reinicia el programa.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Completando componentes del entorno que faltan…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Archivos de bloqueo residuales eliminados', type: 'ok' } : { title: 'Error en la limpieza', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: 'No se admite reparación automática todavía', body: issue.hint || '', type: 'info' });
  }
  // 修复后重新自检，刷新横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Error de inicialización', body: e.message, type: 'error', sticky: true });
});
