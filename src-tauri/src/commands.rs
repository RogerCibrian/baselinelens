use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::async_runtime;
use tauri::ipc::Channel;

use crate::parser;
use crate::parser::model::Baseline;
use crate::parser::ParserProgress;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct Hello {
    pub msg: String,
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
    async_runtime::spawn_blocking(move || {
        parser::parse_with_progress(&PathBuf::from(path), |stage| {
            // Channel send fails only if the frontend has hung up; ignoring
            // it just means we keep parsing without the UI listening.
            let _ = on_progress.send(stage);
        })
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("parse task panicked: {err}"))?
}
