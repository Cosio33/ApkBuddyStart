# Glosario del puerto

Términos del dominio de ApkBuddyStart y su nombre en el puerto Rust. Se amplía con cada unidad.

| Original (JS) | Significado | Rust |
| --- | --- | --- |
| `backend` / `base` | Origen del entorno Android (adb + ventana + ciclo de vida) | `backend`, módulo `backends-rs` |
| `builtin` | Única base admitida: emulador Android + QEMU incluidos | `ONLY`, `&str = "builtin"` |
| `REGISTRY` | Lista de clases de base disponibles | `CAPS`, `describe_backends()` (lista inmutable) |
| `CAPS` | Conjunto de capacidades de una base | `CAPS: [&str; 7]` |
| `byId(id)` | Busca una base por id; `null` si no existe | `has_backend`, `backend_id` |
| `describe()` | Descripción serializable para la interfaz | `describe_backends()` |
| `autoPick()` | Elección automática (siempre `builtin`) | `auto_pick_backend()` |
| `ONLY` | Id fijo al que se fuerza la creación | `only_backend()` |
| `caps` (getter) | Capacidades de la instancia, en orden | `backend_caps()` |
| `embedCapable` | La base puede incrustar la ventana de imagen | campo `embedCapable` en JSON |
| `settings.engine.mode` | Ajuste heredado que se ignora deliberadamente | no se replica: no afecta al id devuelto |
| `runtime` | Proceso que gestiona emulador, imágenes y adb | fuera de esta unidad |
| `apk` / `pkgname` | Paquete Android y su nombre validado | fuera de esta unidad |
