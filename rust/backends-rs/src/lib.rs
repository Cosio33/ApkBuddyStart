//! JS bindings for `rust/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

#[allow(dead_code)]
async fn run_async<T>(f: impl std::future::Future<Output = Result<T, String>>) -> napi::Result<T> {
    use futures::FutureExt as _;
    match std::panic::AssertUnwindSafe(f).catch_unwind().await {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `hasBackend`.
#[napi(js_name = "hasBackend")]
pub fn has_backend(id: String) -> napi::Result<String> {
    run(move || {
        let id = crate::js::from_json(&id)?;
        let out = port::has_backend(id)?;
        crate::js::to_json(&out)
    })
}

/// `backendId`.
#[napi(js_name = "backendId")]
pub fn backend_id(id: String) -> napi::Result<String> {
    run(move || {
        let id = crate::js::from_json(&id)?;
        let out = port::backend_id(id)?;
        crate::js::to_json(&out)
    })
}

/// `describeBackends`.
#[napi(js_name = "describeBackends")]
pub fn describe_backends() -> napi::Result<String> {
    run(move || {
        let out = port::describe_backends()?;
        crate::js::to_json(&out)
    })
}

/// `autoPickBackend`.
#[napi(js_name = "autoPickBackend")]
pub async fn auto_pick_backend() -> napi::Result<String> {
    run_async(async move {
        let out = port::auto_pick_backend().await?;
        crate::js::to_json(&out)
    })
    .await
}

/// `onlyBackend`.
#[napi(js_name = "onlyBackend")]
pub fn only_backend() -> napi::Result<String> {
    run(move || {
        let out = port::only_backend()?;
        crate::js::to_json(&out)
    })
}

/// `backendCaps`.
#[napi(js_name = "backendCaps")]
pub fn backend_caps(id: String) -> napi::Result<String> {
    run(move || {
        let id = crate::js::from_json(&id)?;
        let out = port::backend_caps(id)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

thread_local! {
    static WIRE: std::cell::RefCell<Option<(napi::bindgen_prelude::Uint8Array, napi::bindgen_prelude::Uint8Array)>> =
        const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument and result buffers `index.cjs` writes to and reads from.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(
    input: napi::bindgen_prelude::Uint8Array,
    output: napi::bindgen_prelude::Uint8Array,
) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads `len` argument bytes, runs `f`, and writes its result; a negative return is the size
/// of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(
    len: u32,
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output)) = guard.as_mut() else {
            return Err(napi::Error::from_reason(
                "rust-anything: the wire buffers are not registered",
            ));
        };
        let len = (len as usize).min(input.len());
        let mut w = wire::Writer::default();
        match run(|| f(&mut wire::Reader::new(&input[..len]), &mut w)) {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => return Ok(f64::NAN),
            other => other?,
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        Ok(n as f64)
    })
}

static S_HAS_BACKEND_0: wire::Schema = wire::Schema::Dyn;
static S_HAS_BACKEND_OUT: wire::Schema = wire::Schema::Dyn;

/// `hasBackend` over the binary wire.
#[napi(js_name = "hasBackendWire")]
pub fn has_backend_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let id: serde_json::Value = wire::read_value(r, &S_HAS_BACKEND_0)?;
        let out = &port::has_backend(id)?;
        wire::write_value(w, out, &S_HAS_BACKEND_OUT)?;
        Ok(())
    })
}

static S_BACKEND_ID_0: wire::Schema = wire::Schema::Dyn;
static S_BACKEND_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `backendId` over the binary wire.
#[napi(js_name = "backendIdWire")]
pub fn backend_id_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let id: serde_json::Value = wire::read_value(r, &S_BACKEND_ID_0)?;
        let out = &port::backend_id(id)?;
        wire::write_value(w, out, &S_BACKEND_ID_OUT)?;
        Ok(())
    })
}

static S_DESCRIBE_BACKENDS_OUT: wire::Schema = wire::Schema::Dyn;

/// `describeBackends` over the binary wire.
#[napi(js_name = "describeBackendsWire")]
pub fn describe_backends_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |_r, w| {
        let out = &port::describe_backends()?;
        wire::write_value(w, out, &S_DESCRIBE_BACKENDS_OUT)?;
        Ok(())
    })
}

static S_ONLY_BACKEND_OUT: wire::Schema = wire::Schema::Dyn;

/// `onlyBackend` over the binary wire.
#[napi(js_name = "onlyBackendWire")]
pub fn only_backend_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |_r, w| {
        let out = &port::only_backend()?;
        wire::write_value(w, out, &S_ONLY_BACKEND_OUT)?;
        Ok(())
    })
}

static S_BACKEND_CAPS_0: wire::Schema = wire::Schema::Dyn;
static S_BACKEND_CAPS_OUT: wire::Schema = wire::Schema::Dyn;

/// `backendCaps` over the binary wire.
#[napi(js_name = "backendCapsWire")]
pub fn backend_caps_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let id: serde_json::Value = wire::read_value(r, &S_BACKEND_CAPS_0)?;
        let out = &port::backend_caps(id)?;
        wire::write_value(w, out, &S_BACKEND_CAPS_OUT)?;
        Ok(())
    })
}
