use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::async_runtime;
use tauri::ipc::Channel;

use crate::parser;
use crate::parser::model::Baseline;
use crate::parser::ParserProgress;
use crate::storage::model::{AppState, UserState};
use crate::storage::persist;

#[derive(Debug, Serialize, Deserialize, Type)]
pub(crate) struct Hello {
    pub(crate) msg: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn hello() -> Hello {
    Hello {
        msg: "world".into(),
    }
}

/// Parses the CIS benchmark PDF at `path` and returns a fully-populated
/// `Baseline` for the frontend to render.
///
/// Runs the (CPU-heavy) parse on the blocking-thread pool so the Tauri
/// runtime stays free to serve UI events. Streams `ParserProgress` events
/// over `on_progress` as each pipeline stage starts.
#[tauri::command]
#[specta::specta]
pub(crate) async fn parse_baseline(
    path: String,
    on_progress: Channel<ParserProgress>,
) -> Result<Baseline, String> {
    let baseline = async_runtime::spawn_blocking(move || {
        parser::parse_with_progress(&PathBuf::from(path), |stage| {
            // Channel send fails only if the frontend has hung up; ignoring
            // it just means we keep parsing without the UI listening.
            let _ = on_progress.send(stage);
        })
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("parse task panicked: {err}"))??;

    // Best-effort cache: a failure here just means the next launch has to
    // re-parse the PDF. Don't fail the user-visible parse.
    if let Err(err) = persist::save_cached_baseline(&baseline) {
        eprintln!("failed to cache baseline: {err}");
    }
    let app_state = AppState {
        active_baseline_sha: Some(baseline.source.pdf_sha256.clone()),
    };
    if let Err(err) = persist::save_app_state(&app_state) {
        eprintln!("failed to update app_state: {err}");
    }

    Ok(baseline)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_app_state() -> Result<Option<AppState>, String> {
    persist::load_app_state().map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_app_state(state: AppState) -> Result<(), String> {
    persist::save_app_state(&state).map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_user_state(baseline_sha: String) -> Result<Option<UserState>, String> {
    persist::load_user_state(&baseline_sha).map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_user_state(state: UserState) -> Result<(), String> {
    persist::save_user_state(&state).map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_cached_baseline(sha: String) -> Result<Option<Baseline>, String> {
    persist::load_cached_baseline(&sha).map_err(|err| err.to_string())
}
