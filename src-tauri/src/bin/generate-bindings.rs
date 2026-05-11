//! Regenerates `src/bindings.ts` from the Rust command and type metadata.
//! Run after editing any `#[tauri::command]` / `#[derive(specta::Type)]`
//! item to keep the frontend's typed wrapper in sync.
//!
//! Usage from the repo root:
//!
//! ```text
//! cargo run --manifest-path src-tauri/Cargo.toml --bin generate-bindings
//! ```

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_path = manifest_dir.join("..").join("src").join("bindings.ts");
    baselinelens_lib::bindings::export_to(&out_path)?;
    println!("wrote {}", out_path.display());
    Ok(())
}
