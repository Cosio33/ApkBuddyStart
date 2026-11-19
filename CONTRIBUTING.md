# Guía de contribución

Bienvenido a enviar Issues y Pull Requests. El principio de este proyecto es **carcasa (shell) sin dependencias y comportamiento predecible**, así que lee primero las siguientes convenciones.

## Entorno de desarrollo

- Windows 10/11 x64
- Node.js ≥ 20
- `npm install && npm start`

## Autocomprobación antes de confirmar (commit)

```powershell
npm test          # pruebas unitarias puras de Node + pruebas de la cadena del motor (sin red, sin máquina virtual)
```

Cuando hagas cambios en la interfaz, se recomienda ejecutar de nuevo una captura de humo (smoke) para confirmar que el diseño no se ha roto:

```powershell
electron . --smoke test\shot.png
```

## Convenciones de código

- **La carcasa (shell) no incorpora dependencias de ejecución de terceros**. Los analizadores de ZIP / AXML / ARSC / PNG / ICO bajo `src/core/` están escritos a mano; al añadir funciones, prioriza primero si «se puede implementar con los módulos integrados de Node», evitando arrastrar una librería grande para una pequeña función.
- La capa de renderizado es HTML/CSS/JS nativo; no se usa ningún framework frontend.
- Toda la interacción con el lado de Android se realiza a través de `src/core/adb.js`; no concatenes comandos adb directamente en distintos lugares.
- La comunicación entre el proceso principal y el proceso de renderizado se realiza únicamente mediante los canales de la lista blanca expuestos por `preload.js`, manteniendo `contextIsolation` activado.
- Los comentarios y el texto de la UI usan español; los identificadores usan inglés.

## Convenciones de pruebas

- Cuando no se pueda obtener un APK real, las pruebas omitirán automáticamente la parte de análisis de APK; para cubrir esa parte, configura una variable de entorno que apunte a cualquier APK:

```powershell
$env:APKSTART_TEST_APK="C:\path\to\any.apk"; npm test
```

- No accedas a Internet en las pruebas. Para pruebas que requieran comportamiento de red, inicia un servicio `http` local (consulta `test/engine-test.js`).

## Mensajes de confirmación (commit)

Usa el estilo Conventional Commits, por ejemplo:

```
feat(engine): admite importar discos qcow2 desde una ruta personalizada
fix(axml): corrige el desplazamiento de la base de la tabla de atributos
docs: añade instrucciones para habilitar WHPX
```

## Aspectos legales y límites

- Este proyecto no distribuye ninguna imagen de sistema Android, binario de QEMU ni componentes de Google; el usuario los descarga todos por su cuenta y según lo necesita.
- No incluyas en el repositorio APK comerciales, herramientas de cracking ni ningún contenido que infrinja los derechos de autor de terceros.
