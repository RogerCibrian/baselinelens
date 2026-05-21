mod audit;
mod bindings;
mod commands;
mod error;
mod host;
mod parser;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    let specta_builder = bindings::make_builder();

    // Debug builds regenerate `src/bindings.ts` on every launch so the
    // TS surface always tracks the Rust commands. Release builds skip
    // the I/O entirely.
    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts"),
        )
        .expect("failed to regenerate src/bindings.ts in debug build");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ScanControl::default())
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
}
