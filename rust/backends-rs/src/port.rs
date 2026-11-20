//! Puerto a Rust del registro de bases de ApkBuddyStart (`src/core/backends/`),
//! expuesto mediante `rust/backends-api.mjs`.
//!
//! El original tiene una única base, `builtin`, fijada desde la versión 0.5.6. No hay sondeo
//! de emuladores de terceros: `autoPick` siempre devuelve `builtin` y `create` ignora el id
//! forzado. Esta simplicidad es intencionada y se replica aquí sin «mejoras».

#![forbid(unsafe_code)]

use serde_json::{Value, json};

/// Id de la única base registrada.
const ONLY: &str = "builtin";

/// Etiqueta y resumen que la interfaz muestra para la base incluida.
/// Se copian literalmente de `src/core/backends/builtin.js` para mantener paridad de texto
/// (incluido el punto seguido inmediatamente de «El primer arranque» del original).
const LABEL: &str = "Entorno integrado (Android Emulator + QEMU)";
const SUMMARY: &str = concat!(
    "Cero dependencias de terceros: apkstart descarga y gestiona él mismo la imagen de Android 14; ",
    "las aplicaciones ARM usan la capa de traducción incluida en la imagen.",
    "El primer arranque tarda unos 25 segundos; después, la instantánea quickboot lo reduce a segundos.",
);

/// Capacidades de `BuiltinBackend`, en el orden del `Set` devuelto por su getter `caps`.
const CAPS: [&str; 7] = [
    "provision",
    "snapshot",
    "resizeData",
    "resetData",
    "rotatePanel",
    "priority",
    "shutdown",
];

/** Equivale a `byId(id) !== null`: solo reconoce la cadena exacta `builtin`. */
pub fn has_backend(id: Value) -> Result<Value, String> {
    Ok(json!(id.as_str() == Some(ONLY)))
}

/** Equivale a `byId(id)?.id ?? null`; cualquier otra entrada da `null`. */
pub fn backend_id(id: Value) -> Result<Value, String> {
    if id.as_str() == Some(ONLY) {
        Ok(json!(ONLY))
    } else {
        Ok(Value::Null)
    }
}

/** Descripción serializable de todas las bases, en orden de registro. */
pub fn describe_backends() -> Result<Value, String> {
    Ok(json!([{
        "id": ONLY,
        "label": LABEL,
        "summary": SUMMARY,
        "embedCapable": true,
    }]))
}

/** Elección automática: siempre la base incluida, sin sondeo. */
pub async fn auto_pick_backend() -> Result<Value, String> {
    Ok(json!({ "id": ONLY, "reason": "builtin-only" }))
}

/** Constante `ONLY` del registro. */
pub fn only_backend() -> Result<Value, String> {
    Ok(json!(ONLY))
}

/** Claves de capacidad de la base, en orden, o `null` si el id no existe. */
pub fn backend_caps(id: Value) -> Result<Value, String> {
    if id.as_str() != Some(ONLY) {
        return Ok(Value::Null);
    }
    Ok(json!(CAPS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_solo_la_base_incluida() {
        assert_eq!(has_backend(json!("builtin")).unwrap(), json!(true));
        assert_eq!(has_backend(json!("BUILTIN")).unwrap(), json!(false));
        assert_eq!(has_backend(json!(null)).unwrap(), json!(false));
    }

    #[test]
    fn id_y_capacidades() {
        assert_eq!(backend_id(json!("builtin")).unwrap(), json!("builtin"));
        assert_eq!(backend_id(json!("x")).unwrap(), Value::Null);
        let caps = backend_caps(json!("builtin")).unwrap();
        assert_eq!(caps.as_array().map(Vec::len), Some(CAPS.len()));
        assert_eq!(backend_caps(json!("x")).unwrap(), Value::Null);
    }

    #[test]
    fn descripcion_y_eleccion() {
        let d = describe_backends().unwrap();
        assert_eq!(d[0]["id"], json!("builtin"));
        assert_eq!(d[0]["embedCapable"], json!(true));
        assert_eq!(only_backend().unwrap(), json!("builtin"));
    }
}
