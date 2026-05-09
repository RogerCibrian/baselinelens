//! Load and save helpers for `AppState`, `UserState`, and the cached
//! `Baseline`. Each artifact is serialized to JSON; missing files are
//! reported as `Ok(None)` rather than an error so callers can distinguish
//! "first run" from a real I/O failure.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::parser::model::Baseline;
use crate::storage::error::StorageError;
use crate::storage::model::{AppState, UserState};
use crate::storage::paths;

/// Reads a JSON file into `T`. Returns `Ok(None)` if the file is missing
/// (typically a first-run case) and `Err(...)` for any other I/O or parse
/// failure.
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, StorageError> {
    let raw = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(StorageError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|source| StorageError::Json {
            path: path.to_path_buf(),
            source,
        })
}

/// Writes `value` as pretty-printed JSON to `path`, creating any missing
/// parent directories along the way.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| StorageError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|source| StorageError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    fs::write(path, body).map_err(|source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn load_app_state() -> Result<Option<AppState>, StorageError> {
    read_json(&paths::app_state_path()?)
}

pub(crate) fn save_app_state(state: &AppState) -> Result<(), StorageError> {
    write_json(&paths::app_state_path()?, state)
}

pub(crate) fn load_user_state(baseline_sha: &str) -> Result<Option<UserState>, StorageError> {
    read_json(&paths::user_state_path(baseline_sha)?)
}

pub(crate) fn save_user_state(state: &UserState) -> Result<(), StorageError> {
    write_json(&paths::user_state_path(&state.baseline_sha256)?, state)
}

pub(crate) fn load_cached_baseline(sha: &str) -> Result<Option<Baseline>, StorageError> {
    read_json(&paths::baseline_cache_path(sha)?)
}

pub(crate) fn save_cached_baseline(baseline: &Baseline) -> Result<(), StorageError> {
    write_json(
        &paths::baseline_cache_path(&baseline.source.pdf_sha256)?,
        baseline,
    )
}
