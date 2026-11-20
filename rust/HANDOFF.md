# Handoff — puerto a Rust de ApkBuddyStart

Actualizado: 2026-11-20. Sesión: rama `rust-port` desde `branding/full-spanish`.

## Dónde estamos

- Primera unidad terminada: `rust/backends-rs` (6 funciones del registro de bases), mediante
  `rust/backends-api.mjs`.
- Gate: pass (fmt, clippy, cargo test, unsafe, tamaño, API, 50/50 casos).
- Diff: 50/50. Bench: 0.02x — **no enviar esta unidad por velocidad** (ADR-005).
- Fallback: 100 % (toda la app sigue en JS; el crate Rust aún no está cableado a la app).
- CI: `.github/workflows/rust-port.yml` compila y verifica en `windows-latest`.

## Cómo continuar

1. Cargar la skill `rust-anything` y leer `rust/MAP.md`, `rust/DECISIONS.md` y este archivo.
2. Elegir la siguiente unidad del mapa (recomendado: `src/splash-preload.js`, 13 líneas).
3. Si es CommonJS, añadir un adaptador ESM en `rust/` como se hizo en ADR-002.
4. `rust-anything bridge . <unidad> --kind napi` → `record` → escribir `src/port.rs` →
   `build` → `diff` → `gate` → `bench`.
5. Añadir el crate al matrix del workflow y hacer push; verificar el run en GitHub Actions.
6. Actualizar `MAP.md` y este handoff con gate/diff/bench y el nuevo fallback.

## Bloqueos conocidos

- `src/core/` y `tools/` tienen código dinámico: investigar con un subagente antes de portar.
- `src/ui/` se conserva en la web (Tauri queda para después del *lift*).
- Ningún crate está cableado todavía a la app; no hay interruptor de kill switch hasta `app wire`.

## Enlaces

- Decisiones: `rust/DECISIONS.md`
- Glosario: `rust/GLOSSARY.md`
- Mapa: `rust/MAP.md`
- Workflow: `.github/workflows/rust-port.yml`
