//! Generates `src/bindings.ts` from the Rust commands and types annotated with
//! `#[specta::specta]` / `#[derive(specta::Type)]`. Lives inside the lib (under
//! `#[cfg(test)]`) so it can see `pub(crate)` items.

use specta_typescript::Typescript;
use tauri_specta::{Builder, collect_commands};

#[test]
fn generate_typescript_bindings() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::commands::hello,
            crate::commands::parse_baseline
        ])
        .typ::<crate::parser::model::Baseline>()
        .typ::<crate::audit::model::Scan>()
        .typ::<crate::storage::UserState>();

    builder
        .export(Typescript::default(), "../src/bindings.ts")
        .expect("failed to export TypeScript bindings");
}
