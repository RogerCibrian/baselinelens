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
