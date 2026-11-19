'use strict';
/* Script de la animación de arranque de ApkBuddyStart: recibe el progreso del proceso principal y controla el desvanecimiento */

const api = window.apkstartSplash;
if (!api) { /* si no se inyectó preload, salir silenciosamente */ }

const $ = (id) => document.getElementById(id);

// Versión
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// Marcador de primera instalación + si los componentes vienen incluidos
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // Entorno de ejecución integrado (instalador completo / MSIX de Microsoft Store): no debe mencionarse en absoluto la «descarga».
  // La queja del usuario era «instalé 850 MB y sigue descargando la imagen»; en realidad solo se extrae la imagen comprimida
  // del paquete al directorio del usuario, sin conexión a la red.
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'Primer arranque · preparación local (sin conexión)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Los componentes del entorno ya vienen en el instalador; no se descarga nada</li>',
        '<li>Extraer la imagen del sistema al directorio de usuario (unos 1 minuto, solo una vez)</li>',
        '<li>Preparar aceleración hardware y teclado chino</li>',
        '<li>Después, haz doble clic en un APK o en el icono del escritorio para abrir aplicaciones al instante</li>',
      ].join('');
    }
  }
}).catch(() => {});

// Actualización del progreso
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Completado → desvanecer
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
