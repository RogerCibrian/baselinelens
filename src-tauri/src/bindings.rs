//! Generates `src/bindings.ts` from the Rust commands and types annotated
//! with `#[specta::specta]` / `#[derive(specta::Type)]`.
//!
//! Lives as a `pub fn` (rather than a `#[test]`) because the test-harness
//! startup path interacts badly with `tauri::Wry` on Windows and crashes
//! with `STATUS_ENTRYPOINT_NOT_FOUND` (upstream tauri-apps/tauri#13419,
//! #14580). Invoked via the `generate-bindings` bin target.

use std::path::Path;

use specta_typescript::Typescript;
use tauri_specta::{Builder, collect_commands};

/// Renders the typed-binding module for `commands::*` to `out_path`,
/// overwriting any existing file.
pub fn export_to(out_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::commands::hello,
            crate::commands::parse_baseline,
            crate::commands::load_app_state,
            crate::commands::save_app_state,
            crate::commands::load_user_state,
            crate::commands::save_user_state,
            crate::commands::load_cached_baseline,
            crate::commands::load_most_recent_scan,
            crate::commands::start_scan,
        ])
        .typ::<crate::commands::CachedBaseline>()
        .typ::<crate::parser::model::Baseline>()
        .typ::<crate::parser::ParserProgress>()
        .typ::<crate::audit::model::Scan>()
        .typ::<crate::audit::model::ScanRecord>()
        .typ::<crate::audit::model::CheckDetail>()
        .typ::<crate::storage::model::UserState>()
        .typ::<crate::storage::model::AppState>();

    builder.export(Typescript::default(), out_path)?;
    Ok(())
}
