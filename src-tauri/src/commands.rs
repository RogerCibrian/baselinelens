use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::async_runtime;
use tauri::ipc::Channel;

use crate::audit::generator;
use crate::audit::merge::ScanCollector;
use crate::audit::model::{Scan, ScanContext, ScanRecord};
use crate::audit::runner::{self, AuditEvent};
use crate::audit::AUDIT_SCRIPT_VERSION;
use crate::parser;
use crate::parser::model::Baseline;
use crate::parser::{ParserProgress, PARSER_VERSION};
use crate::storage::model::{AppState, UserState};
use crate::storage::persist::ScanLoadErrors;
use crate::storage::{paths, persist};

/// Wraps a cached `Baseline` with a staleness flag so the frontend can
/// surface a re-parse prompt without making a second IPC round-trip.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedBaseline {
    pub(crate) baseline: Baseline,
    /// True when the cached baseline was produced by a different parser
    /// version than the one currently running.
    pub(crate) is_stale: bool,
}

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

/// IPC return shape for `load_scan_context`. Combines the loaded
/// scan-related state with per-sub-file load errors so the frontend can
/// degrade per-surface (empty state for a missing latest scan, inline
/// notice on the trend chart for a broken summaries file, etc.) rather
/// than going dark on a single bad file.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanContextLoad {
    pub(crate) context: ScanContext,
    pub(crate) errors: ScanLoadErrors,
}

/// Returns the dashboard's scan-related state for a baseline: the
/// most-recent full `Scan`, the per-rec change log, and the
/// per-scan summary history. Each sub-file is loaded independently;
/// failures land in `errors` instead of taking down the whole load.
#[tauri::command]
#[specta::specta]
pub(crate) fn load_scan_context(baseline_sha: String) -> Result<ScanContextLoad, String> {
    let (context, errors) =
        persist::load_scan_context(&baseline_sha).map_err(|err| err.to_string())?;
    Ok(ScanContextLoad { context, errors })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_cached_baseline(sha: String) -> Result<Option<CachedBaseline>, String> {
    let baseline = persist::load_cached_baseline(&sha).map_err(|err| err.to_string())?;
    Ok(baseline.map(|baseline| {
        let is_stale = baseline.source.parser_version != PARSER_VERSION;
        CachedBaseline { baseline, is_stale }
    }))
}

/// Runs the audit pipeline against the device this dashboard is on:
/// generates (or reuses) a cached `audit.ps1` from `baseline`, spawns
/// `powershell.exe` to execute it, and streams each `ScanRecord` over
/// `on_record` as it lands. Returns the assembled `Scan` once the script
/// finishes, after persisting it to disk.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_scan(
    baseline: Baseline,
    on_record: Channel<ScanRecord>,
) -> Result<Scan, String> {
    let baseline_sha = baseline.source.pdf_sha256.clone();
    // Persist the baseline to its cache path so the PS script can read
    // the same JSON the rest of the app already trusts as the source of
    // truth. Re-saving is cheap and protects against the case where the
    // in-memory baseline is ahead of disk (e.g. a save-cached-baseline
    // failure earlier in the session).
    persist::save_cached_baseline(&baseline).map_err(|err| err.to_string())?;
    let baseline_path = paths::baseline_cache_path(&baseline_sha)
        .map_err(|err| err.to_string())?;
    let scan = async_runtime::spawn_blocking(move || -> Result<Scan, String> {
        let script_path = generator::ensure_script().map_err(|err| err.to_string())?;
        let mut collector = ScanCollector::new(
            baseline_sha,
            PARSER_VERSION.to_string(),
            AUDIT_SCRIPT_VERSION.to_string(),
        );
        runner::run(&script_path, &baseline_path, |event| match event {
            AuditEvent::Device(device) => collector.set_device(device),
            AuditEvent::Result(record) => {
                // Forward to the UI before storing; channel send is
                // best-effort, but a closed channel just means the user
                // closed the window — keep collecting either way.
                let _ = on_record.send(record.clone());
                collector.record(record);
            }
        })
        .map_err(|err| err.to_string())?;
        Ok(collector.finish(None))
    })
    .await
    .map_err(|err| format!("scan task panicked: {err}"))??;

    persist::save_scan_with_diff(&scan).map_err(|err| err.to_string())?;
    Ok(scan)
}
