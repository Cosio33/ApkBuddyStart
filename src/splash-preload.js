'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apkstartSplash', {
  version: () => ipcRenderer.invoke('splash:version'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  // Indica si los componentes de ejecución vienen incluidos en el paquete (versión completa / MSIX de la tienda) o hay que descargarlos (versión ligera).
  // La animación de arranque cambia según esto el texto «descargando xx MB»: si ya están integrados no debe decir «descargando»,
  // o el usuario pensará que tiene que volver a descargarlo todo tras la instalación.
  bundled: () => ipcRenderer.invoke('splash:bundled'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
