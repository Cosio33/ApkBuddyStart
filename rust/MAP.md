# Mapa del puerto a Rust — ApkBuddyStart

Objetivo: migrar ApkBuddyStart a una app Rust autónoma, manteniendo la app Electron actual como
referencia hasta el *lift* final. Este mapa se actualiza en cada sesión; apunta a los otros
archivos, no los copia.

- Decisiones: `rust/DECISIONS.md` (ADR-001..005)
- Glosario: `rust/GLOSSARY.md`
- Estado para la próxima sesión: `rust/HANDOFF.md`
- Workflow de CI: `.github/workflows/rust-port.yml`
- Análisis del original: generar con `rust-anything analyze . --whole-app --lang ts`

## Estado de unidades

| Unidad | Ola | Estado | Gate | Diff | Bench | Notas |
| --- | ---: | --- | --- | --- | --- | --- |
| `rust/` → `backends-rs` (6 funciones) | 0 | done (2026-11-20) | pass | 50/50 | 0.02x, no enviar por velocidad | Requiere `rust/backends-api.mjs` (ADR-002) |
| `src/splash-preload.js` | 0 | open | — | — | — | 13 líneas, readiness 100 |
| `src/preload.js` | 0 | open | — | — | — | 146 líneas, readiness 96 |
| `src/core/backends/` | 0 | referencia | — | — | — | Portado vía adaptador; clases no comparables |
| `src/core/` (14k líneas) | 0 | blocked | — | — | — | Código dinámico; investigar antes de portar |
| `src/ui/` | 0 | keep | — | — | — | UI web; mover a Tauri solo tras el *lift* |
| `scripts/` | 1 | open | — | — | — | 412 líneas, readiness 60 |
| `src/main.js` | 1 | open | — | — | — | 2741 líneas, asíncrono y dependencias de Electron |
| `tools/` | 1 | blocked | — | — | — | Código dinámico |
| `tools/embed-probe/index.js` | 2 | open | — | — | — | 28 líneas, readiness 91 |

## Fuera de alcance por ahora

- Sustituir Electron/Tauri: la UI web sigue en la app original hasta que el retroceso sea cero.
- Reescribir la lógica de emulación/QEMU y el registro de Windows: requieren investigación de
  crates (ver `rust/research/` cuando se creen).
- Cambiar formatos en disco, claves de registro o rutas de la app: se mantienen por compatibilidad.

## Próximo checkpoint

Tras la segunda unidad (se recomienda `src/splash-preload.js` o `src/preload.js`, las más
pequeñas y listas), reportar gate/diff/bench y actualizar este mapa y `HANDOFF.md`.
