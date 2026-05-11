//! Resolves the appdata directory and the on-disk locations for each
//! persisted artifact.

use std::path::PathBuf;

use directories::ProjectDirs;

use crate::storage::error::StorageError;

/// Returns the platform-appropriate appdata root for BaselineLens. The
/// qualifier/organization/application triplet matches `com.baselinelens.app`
/// (the bundle identifier in `tauri.conf.json`).
fn project_dirs() -> Result<ProjectDirs, StorageError> {
    ProjectDirs::from("com", "baselinelens", "app").ok_or(StorageError::NoDataDir)
}

/// Root data directory. On macOS:
/// `~/Library/Application Support/com.baselinelens.app/`. On Windows:
/// `%APPDATA%\baselinelens\app\data\`.
pub(crate) fn data_dir() -> Result<PathBuf, StorageError> {
    Ok(project_dirs()?.data_dir().to_path_buf())
}

/// Path to the cross-baseline application state file.
pub(crate) fn app_state_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("app_state.json"))
}

/// Path to the per-baseline annotations (exceptions + notes) file.
pub(crate) fn user_state_path(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    Ok(data_dir()?
        .join("user_states")
        .join(format!("{baseline_sha}.json")))
}

/// Path to the cached parsed `Baseline` for a given PDF SHA.
pub(crate) fn baseline_cache_path(sha: &str) -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("baselines").join(format!("{sha}.json")))
}

/// Path to the cached `audit.ps1` for a given audit-script schema
/// version. The script body is the same for every baseline (it reads
/// baseline JSON at runtime), so the version is the only thing that
/// could vary the on-disk file — bumping it produces a fresh cache
/// entry automatically.
pub(crate) fn audit_script_path(audit_script_version: &str) -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join(format!("audit_v{audit_script_version}.ps1")))
}

/// Path to a scan record for a given baseline SHA and scan-start timestamp.
/// The timestamp doubles as the scan id so we can keep history forever
/// (until/unless retention becomes a concern).
pub(crate) fn scan_path(baseline_sha: &str, scan_id: &str) -> Result<PathBuf, StorageError> {
    Ok(scans_dir_for_baseline(baseline_sha)?.join(format!("{scan_id}.json")))
}

/// Directory holding every saved `Scan` for a given baseline.
pub(crate) fn scans_dir_for_baseline(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("scans").join(baseline_sha))
}
