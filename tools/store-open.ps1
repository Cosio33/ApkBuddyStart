# ApkBuddyStart · publicación en la tienda: abrir con un clic las ventanas necesarias
# Uso: clic derecho → Ejecutar con PowerShell
# Función: colocar de una vez en el escritorio las 4 cosas necesarias para publicar y evitar buscar directorios

$ErrorActionPreference = 'Continue'
$root = 'D:\apkstart-dsh\apkstart'
# La versión se lee de package.json; no la fijes en el script: con cada subida de versión acabarías olvidando actualizarla.
# La versión MSIX tiene cuatro segmentos (0.5.2 → 0.5.2.0), igual que la regla de build/msix.js.
$ver = '0.0.0.0'
try {
    # Hay que indicar -Encoding UTF8 de forma explícita: la codificación por defecto de Windows PowerShell 5.1 es ANSI,
    # y package.json contiene una descripción en chino; leerla como ANSI da caracteres corruptos → ConvertFrom-Json lanza un error.
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $ver = ('{0}.0' -f $pkg.version)
} catch {
    Write-Host '  [!] No se pudo leer la versión de package.json; se busca el paquete 0.5.3.0' -ForegroundColor Yellow
    $ver = '0.5.3.0'
}
$msix = Join-Path $root ('dist\store\ApkBuddyStart_{0}_x64.msix' -f $ver)
$guide = Join-Path $root 'docs\store-upload-walkthrough.md'
$listing = Join-Path $root 'docs\store-listing.md'

Write-Host ''
Write-Host '  Asistente de publicación de ApkBuddyStart' -ForegroundColor Green
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

if (-not (Test-Path $msix)) {
    Write-Host "  [!] No se encontró el paquete de instalación: $msix" -ForegroundColor Red
    Write-Host '      Ejecuta primero node build/msix.js para reempaquetar.' -ForegroundColor DarkGray
} else {
    $mb = [math]::Round((Get-Item $msix).Length / 1MB, 1)
    Write-Host "  [1] Paquete de instalación  $mb MB" -ForegroundColor Cyan
    Write-Host '      Ya está seleccionado en el Explorador de archivos; arrástralo al subir' -ForegroundColor DarkGray
    Start-Process explorer.exe "/select,`"$msix`""
}

Write-Host '  [2] Partner Center (se abre en el navegador; debes iniciar sesión)' -ForegroundColor Cyan
Start-Process 'https://partner.microsoft.com/dashboard/apps-and-games'

if (Test-Path $guide) {
    Write-Host '  [3] Guía de publicación (para copiar)' -ForegroundColor Cyan
    Start-Process $guide
}

if (Test-Path $listing) {
    Write-Host '  [4] Texto del listado (descripción larga / características / notas de revisión)' -ForegroundColor Cyan
    Start-Process $listing
}

Write-Host ''
Write-Host '  Orden: crear producto → subir paquete → pegar listado → enviar' -ForegroundColor Yellow
Write-Host '  Política de privacidad: https://github.com/RoutineMiku/apkstart/blob/main/docs/privacy.md' -ForegroundColor DarkGray
Write-Host ''
