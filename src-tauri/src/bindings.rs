//! Single source of truth for the typed Tauri command surface.
//!
//! [`make_builder`] returns a `tauri_specta::Builder` that `lib::run`
//! wires into `tauri::Builder::invoke_handler` AND (in debug builds)
//! uses to regenerate `src/bindings.ts`. Listing commands in one place
//! means the runtime handler and the TS bindings can never drift.

use tauri_specta::{Builder, collect_commands};

/// Builds the Specta command/type collector for this app.
pub(crate) fn make_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::commands::get_device_info,
            crate::commands::parse_baseline,
            crate::commands::load_app_state,
            crate::commands::save_app_state,
            crate::commands::load_user_state,
            crate::commands::save_user_state,
            crate::commands::load_cached_baseline,
            crate::commands::load_scan_context,
            crate::commands::reset_latest_scan,
            crate::commands::reset_summaries,
            crate::commands::reset_changes,
            crate::commands::clear_baseline_data,
            crate::commands::remove_baseline,
            crate::commands::start_scan,
            crate::commands::cancel_scan,
            crate::commands::app_version,
            crate::commands::open_data_dir,
            crate::commands::write_export,
        ])
        .typ::<crate::commands::CachedBaseline>()
        .typ::<crate::commands::ScanContextLoad>()
        .typ::<crate::parser::model::Baseline>()
        .typ::<crate::parser::ParserProgress>()
        .typ::<crate::audit::model::Scan>()
        .typ::<crate::audit::model::ScanRecord>()
        .typ::<crate::audit::model::ScanContext>()
        .typ::<crate::audit::model::ScanSummary>()
        .typ::<crate::audit::model::ChangeEvent>()
        .typ::<crate::audit::model::CheckDetail>()
        .typ::<crate::storage::model::UserState>()
        .typ::<crate::storage::model::AppState>()
        .typ::<crate::storage::model::Preferences>()
        .typ::<crate::storage::model::Theme>()
        .typ::<crate::storage::model::TimeFormat>()
        .typ::<crate::storage::model::Density>()
}
