use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::async_runtime;
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::audit::generator;
use crate::audit::merge::ScanCollector;
use crate::audit::model::{DeviceInfo, Scan, ScanContext, ScanRecord};
use crate::audit::runner::{self, AuditEvent};
use crate::audit::AUDIT_SCRIPT_VERSION;
use crate::host;
use crate::parser;
use crate::parser::model::Baseline;
use crate::parser::{ParserProgress, PARSER_VERSION};
use crate::storage::error::StorageError;
use crate::storage::model::{AppState, UserState};
use crate::storage::persist::ScanLoadErrors;
use crate::storage::{paths, persist};

/// Tauri-managed handle for cancelling the in-flight scan. Holds the
/// path of the active scan's cooperative-cancel sentinel (see
/// `runner::run`); `None` when no scan is running. The UI prevents
/// concurrent scans, so a single slot is enough.
#[derive(Default)]
pub(crate) struct ScanControl {
    cancel_path: Mutex<Option<PathBuf>>,
}

/// Builds a per-run sentinel path under the OS temp dir. Process id +
/// millisecond timestamp keep back-to-back runs from colliding.
fn cancel_sentinel_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("baselinelens_cancel_{pid}_{stamp}.flag"))
}

/// Retracts a finished run's cancel handle. Removes the on-disk sentinel
/// unconditionally (best-effort — an undeletable file is a unique temp
/// name no future run reads) and clears the in-memory slot *only* if it
/// still points at `path`. The conditional clear means a subsequent
/// scan that already published its own path can't be clobbered by a
/// late-finishing prior run wiping the slot.
fn clear_cancel_sentinel(scan_control: &ScanControl, path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    let mut guard = scan_control
        .cancel_path
        .lock()
        .expect("scan-control mutex is never held across a panic");
    if guard.as_deref() == Some(path.as_path()) {
        *guard = None;
    }
}

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

/// Reads device identity and management state from the local machine
/// for the onboarding "Will scan" strip. Runs the same
/// `device-info.ps1` that the audit pipeline dot-sources, so the
/// pre-scan strip and the post-scan top bar agree on what they show.
///
/// Wrapped in `spawn_blocking` because the PowerShell spawn blocks the
/// thread — the Tauri runtime stays free to serve other IPC during the
/// few-hundred-millisecond startup.
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_device_info() -> Result<DeviceInfo, String> {
    async_runtime::spawn_blocking(host::read_device_info)
        .await
        .map_err(|err| format!("device-info task panicked: {err}"))?
        .map_err(|err| err.to_string())
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
    // Read existing app state so unrelated user preferences (theme, etc.)
    // survive a baseline switch. A missing or unreadable file degrades to
    // a default — at worst the user re-picks their theme once.
    let mut app_state = match persist::load_app_state() {
        Ok(Some(state)) => state,
        Ok(None) => AppState::default(),
        Err(err) => {
            eprintln!("failed to read app_state before update: {err}");
            AppState::default()
        }
    };
    app_state.active_baseline_sha = Some(baseline.source.pdf_sha256.clone());
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

/// Deletes the most-recent full `Scan` file for `baseline_sha`. Used
/// by the recovery flow when the file is unreadable or the user wants
/// to clear it manually from settings. Missing file is treated as
/// success so the call is idempotent.
#[tauri::command]
#[specta::specta]
pub(crate) fn reset_latest_scan(baseline_sha: String) -> Result<(), String> {
    persist::reset_latest_scan(&baseline_sha).map_err(|err| err.to_string())
}

/// Deletes the trend-chart summary history for `baseline_sha`. The
/// next scan starts a fresh history.
#[tauri::command]
#[specta::specta]
pub(crate) fn reset_summaries(baseline_sha: String) -> Result<(), String> {
    persist::reset_summaries(&baseline_sha).map_err(|err| err.to_string())
}

/// Deletes the per-rec change log for `baseline_sha`. The next scan
/// that flips a rec records the first event under the fresh log.
#[tauri::command]
#[specta::specta]
pub(crate) fn reset_changes(baseline_sha: String) -> Result<(), String> {
    persist::reset_changes(&baseline_sha).map_err(|err| err.to_string())
}

/// Clears all scans, history, and annotations for `baseline_sha`,
/// keeping the parsed baseline loaded.
#[tauri::command]
#[specta::specta]
pub(crate) fn clear_baseline_data(baseline_sha: String) -> Result<(), String> {
    persist::clear_baseline_data(&baseline_sha).map_err(|err| err.to_string())
}

/// Removes `baseline_sha` entirely — its data, its parsed cache, and
/// its active-baseline pointer — so the app returns to onboarding.
#[tauri::command]
#[specta::specta]
pub(crate) fn remove_baseline(baseline_sha: String) -> Result<(), String> {
    persist::remove_baseline(&baseline_sha).map_err(|err| err.to_string())
}

/// Application version string (from `Cargo.toml`) for the settings
/// readout.
#[tauri::command]
#[specta::specta]
pub(crate) fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Opens the appdata directory in the OS file manager. Creates it
/// first so a fresh install with no scans yet still opens cleanly.
#[tauri::command]
#[specta::specta]
pub(crate) fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = paths::data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

/// Writes pre-rendered export `contents` to `dest_path`. The CSV/JSON
/// body is composed on the frontend, where effective status,
/// exceptions, notes, and the human-readable strings already exist and
/// match the console one-to-one; this stays a thin, format-agnostic
/// file write so there's no second copy of that logic in Rust.
#[tauri::command]
#[specta::specta]
pub(crate) fn write_export(dest_path: String, contents: String) -> Result<(), String> {
    std::fs::write(&dest_path, contents).map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_cached_baseline(sha: String) -> Result<Option<CachedBaseline>, String> {
    let baseline = match persist::load_cached_baseline(&sha) {
        Ok(value) => value,
        // A cache written by an incompatible schema can't deserialize.
        // Report it as absent so the app falls back to onboarding /
        // re-parse rather than surfacing a raw serde error.
        Err(StorageError::Json { path, source }) => {
            eprintln!("discarding unreadable cached baseline at {path:?}: {source}");
            None
        }
        Err(err) => return Err(err.to_string()),
    };
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
    scan_control: State<'_, ScanControl>,
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

    let cancel_path = cancel_sentinel_path();
    // Drop any stale sentinel from a prior run that died before cleanup,
    // then publish this run's path so `cancel_scan` can reach it.
    let _ = std::fs::remove_file(&cancel_path);
    *scan_control
        .cancel_path
        .lock()
        .expect("scan-control mutex is never held across a panic") = Some(cancel_path.clone());

    let run_cancel_path = cancel_path.clone();
    let scan_result = async_runtime::spawn_blocking(move || -> Result<Scan, String> {
        let script_path = generator::ensure_script().map_err(|err| err.to_string())?;
        let mut collector = ScanCollector::new(
            baseline_sha,
            PARSER_VERSION.to_string(),
            AUDIT_SCRIPT_VERSION.to_string(),
        );
        runner::run(
            &script_path,
            &baseline_path,
            &run_cancel_path,
            |event| match event {
                AuditEvent::Device(device) => collector.set_device(device),
                AuditEvent::Result(record) => {
                    // Forward to the UI before storing; channel send is
                    // best-effort, but a closed channel just means the user
                    // closed the window — keep collecting either way.
                    let _ = on_record.send(record.clone());
                    collector.record(record);
                }
            },
        )
        .map_err(|err| err.to_string())?;
        Ok(collector.finish(None))
    })
    .await;

    // Run resolved (success, error, cancel, or panic) — retract the
    // cancel handle and clear the sentinel so a later click can't target
    // a dead run. Runs on every exit path below since it precedes the
    // `?` that would short-circuit on a failed/panicked task.
    clear_cancel_sentinel(&scan_control, &cancel_path);

    let scan = scan_result.map_err(|err| format!("scan task panicked: {err}"))??;

    // Load the saved exceptions so the trend summary credits closed-by-
    // paperwork recs the same way the level cards do. Missing or
    // unreadable user state degrades to "no exceptions" — the scan
    // succeeded, an exception-count blip is a much smaller failure mode
    // than failing the user-visible scan over an annotation read.
    let exceptions = match persist::load_user_state(&scan.baseline_sha256) {
        Ok(Some(state)) => state.exceptions,
        Ok(None) => Default::default(),
        Err(err) => {
            eprintln!("failed to load user state for scan summary: {err}");
            Default::default()
        }
    };
    persist::save_scan_with_diff(&scan, &exceptions).map_err(|err| err.to_string())?;
    Ok(scan)
}

/// Requests cancellation of the in-flight scan by creating the active
/// run's cooperative-cancel sentinel. The audit script stops at its
/// next recommendation boundary and the run resolves as cancelled
/// without persisting. A no-op when no scan is running.
#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_scan(scan_control: State<'_, ScanControl>) -> Result<(), String> {
    let guard = scan_control
        .cancel_path
        .lock()
        .expect("scan-control mutex is never held across a panic");
    if let Some(path) = guard.as_ref() {
        std::fs::write(path, b"")
            .map_err(|err| format!("failed to signal cancellation: {err}"))?;
    }
    Ok(())
}
