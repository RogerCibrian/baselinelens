mod audit;
mod commands;
mod error;
mod parser;
mod storage;

#[cfg(test)]
mod bindings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::parse_baseline,
            commands::load_app_state,
            commands::save_app_state,
            commands::load_user_state,
            commands::save_user_state,
            commands::load_cached_baseline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
