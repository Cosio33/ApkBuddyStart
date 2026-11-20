# ADR-001: Objetivo y forma del puerto

Status: accepted (2026-11-20)

Context: ApkBuddyStart es una app Electron de escritorio (~20.915 líneas) cuyo núcleo
`src/core/` está bloqueado para un porte directo por código dinámico. El usuario pidió una rama
en Rust que compile en GitHub, con alcance de app completa a Rust por fases.

Decision: `rust/` contiene el puerto. La app Electron actual se conserva sin cambios como
referencia y sigue siendo la que se entrega. El puerto avanza una unidad por sesión; cada unidad
debe pasar `gate` antes de considerarse terminada. No se hace *lift* (eliminación del original)
hasta que el índice de retroceso sea cero.

Consequences: la rama `rust-port` es exploratoria y no cambia el comportamiento del producto
mientras haya unidades sin portar. Cada sesión continúa desde `MAP.md` y `HANDOFF.md`.

# ADR-002: Primera unidad y adaptador ESM

Status: accepted (2026-11-20)

Context: `rust-anything analyze` no detecta la API CommonJS (`module.exports = {...}`) de este
proyecto: las 9 unidades salen con `bridgeable: 0`. Sin embargo los módulos cargan bien en Node.

Decision: se añade `rust/backends-api.mjs`, un adaptador ESM delgado que delega en
`src/core/backends/` y expone seis funciones puras (`hasBackend`, `backendId`, `describeBackends`,
`autoPickBackend`, `onlyBackend`, `backendCaps`). Se excluye `create()` porque devuelve una
instancia con estado y dependencias de Electron, no comparable por valor. El crate es
`rust/backends-rs` con puente napi-rs.

Consequences: el analizador ve una unidad `rust/` con `bridgeable: 6` y readiness 99. El
adaptador no altera la lógica original; es solo la superficie funcional que el puente necesita.
El patrón se repetirá para otras unidades CommonJS.

# ADR-003: Puente napi-rs y CI en Windows

Status: accepted (2026-11-20)

Context: el usuario eligió napi-rs sobre wasm-bindgen. Un módulo `.node` es binario nativo por
sistema operativo; la app es Windows-first.

Decision: `.github/workflows/rust-port.yml` corre en `windows-latest`, instala rust-anything
1.5.1 desde el asset `x86_64-pc-windows-msvc.zip`, configura Node 22 y Rust stable, y ejecuta
`record` (solo si no hay `cases.jsonl`), `build`, `diff`, `bench` y `gate` para cada crate del
matrix.

Consequences: el `.node` producido carga en el Windows del usuario. El workflow se dispara con
push/PR que toque `rust/**` o el propio workflow, y también manualmente.

# ADR-004: Umbral de equivalencia

Status: accepted (2026-11-20)

Context: la API portada devuelve booleanos, cadenas, listas y objetos pequeños; no hay cálculo
numérico sensible.

Decision: paridad estricta (sin tolerancia de floats), comparando JSON completo: claves, orden
de capacidades y texto literal. `cases.jsonl` se versiona en el repositorio.

Consequences: `diff` debe dar 50/50; cualquier diferencia se corrige en el puerto, nunca en la
grabación.

# ADR-005: Criterio de velocidad

Status: accepted (2026-11-20)

Context: `bench` mide 0.02x de media: cruzar el puente cuesta más que el trabajo de estas
funciones pequeñas.

Decision: no activar la unidad en la app por rendimiento. Se mantiene como primera pieza de
demostración del método y se integrará cuando el puerto incluya también sus llamadores (wave
posterior), de modo que una sola llamada haga más trabajo.

Consequences: el informe de cada checkpoint debe incluir el veredicto de `bench`. El objetivo
del puerto es la migración, no una ganancia de velocidad inmediata.
