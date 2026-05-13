//! Load and save helpers for `AppState`, `UserState`, and the cached
//! `Baseline`. Each artifact is serialized to JSON; missing files are
//! reported as `Ok(None)` rather than an error so callers can distinguish
//! "first run" from a real I/O failure.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use specta::Type;

use crate::audit::model::{ChangeEvent, Scan, ScanContext, ScanSummary};
use crate::parser::model::Baseline;
use crate::storage::error::StorageError;
use crate::storage::model::{AppState, Exception, UserState};
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

/// Per-sub-file load outcome for `load_scan_context`. Each field is
/// `None` when the corresponding file loaded clean (or didn't exist) and
/// `Some(message)` when it failed — the frontend uses this to render
/// per-surface failure notices instead of one global banner.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanLoadErrors {
    pub(crate) latest: Option<String>,
    pub(crate) changes: Option<String>,
    pub(crate) summaries: Option<String>,
}

/// Persists a finished `Scan` and updates the surrounding bookkeeping:
/// appends a `ScanSummary` to the trend-chart history (counting
/// exceptions as exception, not fail), then writes `ChangeEvent`s to
/// the change log. The events vary by prior state:
///
/// - No prior scan on disk — writes a first-observation event
///   (`from_status: None`) for every rec in the new scan so per-rec
///   "Failing for" / "Passing for" durations have a stable anchor.
/// - Prior scan with matching parser/script versions — writes one
///   event per rec whose status differs from the prior.
/// - Prior scan with version skew — skips event writing so methodology
///   updates don't masquerade as device regressions in the change log.
pub(crate) fn save_scan_with_diff(
    scan: &Scan,
    exceptions: &HashMap<String, Exception>,
) -> Result<(), StorageError> {
    let baseline_sha = scan.baseline_sha256.as_str();
    // Tolerate a parse failure on the existing latest — we're about to
    // overwrite it anyway. Logging keeps the developer-visible breadcrumb;
    // skipping the diff is the honest call when prior state is unknown.
    let prior_latest = match read_json::<Scan>(&paths::latest_scan_path(baseline_sha)?) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("ignoring unreadable prior latest scan: {err}");
            None
        }
    };

    let events = match prior_latest.as_ref() {
        None => first_observation_events(scan),
        Some(prior)
            if prior.parser_version == scan.parser_version
                && prior.audit_script_version == scan.audit_script_version =>
        {
            diff_to_change_events(prior, scan)
        }
        Some(_) => Vec::new(),
    };
    if !events.is_empty() {
        append_change_events(baseline_sha, &events)?;
    }

    let exception_ids: HashSet<&str> = exceptions.keys().map(String::as_str).collect();
    append_summary(baseline_sha, &ScanSummary::from_scan(scan, &exception_ids))?;
    write_json_atomic(&paths::latest_scan_path(baseline_sha)?, scan)?;
    Ok(())
}

/// Loads the dashboard's scan-related state for a baseline. Each
/// sub-file is loaded independently — a parse failure on one returns
/// the error in `errors` while letting the others succeed, so the
/// dashboard can degrade per-surface (empty state for `latest`, inline
/// notice on the trend chart for `summaries`, etc.) instead of going
/// dark on a single bad file.
pub(crate) fn load_scan_context(
    baseline_sha: &str,
) -> Result<(ScanContext, ScanLoadErrors), StorageError> {
    let mut errors = ScanLoadErrors::default();

    let latest = match read_json::<Scan>(&paths::latest_scan_path(baseline_sha)?) {
        Ok(value) => value,
        Err(err) => {
            errors.latest = Some(err.to_string());
            None
        }
    };

    let changes = match read_change_events(baseline_sha) {
        Ok(value) => value,
        Err(err) => {
            errors.changes = Some(err.to_string());
            Vec::new()
        }
    };

    let summaries = match read_json::<Vec<ScanSummary>>(&paths::summaries_path(baseline_sha)?) {
        Ok(value) => value.unwrap_or_default(),
        Err(err) => {
            errors.summaries = Some(err.to_string());
            Vec::new()
        }
    };

    Ok((
        ScanContext {
            latest,
            changes,
            summaries,
        },
        errors,
    ))
}

/// Emits a `ChangeEvent` per rec in `scan` with `from_status: None`,
/// stamping each one with the scan's start time. Used the very first
/// time a baseline is scanned so per-rec "Failing for" / "Passing for"
/// durations downstream have an anchor from the start, rather than
/// waiting for an eventual status flip to record one.
fn first_observation_events(scan: &Scan) -> Vec<ChangeEvent> {
    scan.results
        .iter()
        .map(|(rec_id, result)| ChangeEvent {
            rec_id: rec_id.clone(),
            from_status: None,
            to_status: result.status,
            observed_at: scan.started_at,
            parser_version: scan.parser_version.clone(),
            audit_script_version: scan.audit_script_version.clone(),
        })
        .collect()
}

/// Compares two scans rec-by-rec and emits a `ChangeEvent` for each id
/// whose status differs (including ids that are present in one scan but
/// not the other — first observation or an id the new scan no longer
/// covers).
fn diff_to_change_events(prior: &Scan, current: &Scan) -> Vec<ChangeEvent> {
    let mut events = Vec::new();
    for (rec_id, current_result) in &current.results {
        let prior_status = prior.results.get(rec_id).map(|r| r.status);
        if prior_status != Some(current_result.status) {
            events.push(ChangeEvent {
                rec_id: rec_id.clone(),
                from_status: prior_status,
                to_status: current_result.status,
                observed_at: current.started_at,
                parser_version: current.parser_version.clone(),
                audit_script_version: current.audit_script_version.clone(),
            });
        }
    }
    events
}

/// Appends one or more `ChangeEvent`s to the per-baseline JSONL file.
/// Each event is written as a single line so a partial write at most
/// truncates the trailing event rather than corrupting earlier history.
fn append_change_events(
    baseline_sha: &str,
    events: &[ChangeEvent],
) -> Result<(), StorageError> {
    let path = paths::changes_path(baseline_sha)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| StorageError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|source| StorageError::Io {
            path: path.clone(),
            source,
        })?;
    for event in events {
        let line = serde_json::to_string(event).map_err(|source| StorageError::Json {
            path: path.clone(),
            source,
        })?;
        writeln!(file, "{line}").map_err(|source| StorageError::Io {
            path: path.clone(),
            source,
        })?;
    }
    Ok(())
}

/// Reads the per-baseline JSONL change log into memory in file order.
/// A blank line is skipped; any malformed line bubbles as a `Json`
/// error so the load surface (and the user) sees the problem instead of
/// silently dropping events.
fn read_change_events(baseline_sha: &str) -> Result<Vec<ChangeEvent>, StorageError> {
    let path = paths::changes_path(baseline_sha)?;
    let raw = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(StorageError::Io {
                path: path.clone(),
                source,
            });
        }
    };
    let mut events = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: ChangeEvent =
            serde_json::from_str(trimmed).map_err(|source| StorageError::Json {
                path: path.clone(),
                source,
            })?;
        events.push(event);
    }
    Ok(events)
}

/// Appends a single `ScanSummary` to the per-baseline summaries array.
/// Reads the existing array (or starts an empty one), pushes, and
/// rewrites atomically. The file stays a JSON array (not JSONL) so the
/// frontend can deserialize it in one shot for the trend chart.
fn append_summary(baseline_sha: &str, summary: &ScanSummary) -> Result<(), StorageError> {
    let path = paths::summaries_path(baseline_sha)?;
    let mut existing: Vec<ScanSummary> = read_json(&path)?.unwrap_or_default();
    existing.push(summary.clone());
    write_json_atomic(&path, &existing)
}

/// Removes `path` if it exists. A missing file is reported as `Ok(())`
/// so callers can use this as an idempotent "reset" primitive without
/// special-casing the first-call path.
fn remove_if_exists(path: &Path) -> Result<(), StorageError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(StorageError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Deletes the most-recent full `Scan` for a baseline. Used by the
/// in-app recovery flow when `latest.json` can't be deserialized.
pub(crate) fn reset_latest_scan(baseline_sha: &str) -> Result<(), StorageError> {
    remove_if_exists(&paths::latest_scan_path(baseline_sha)?)
}

/// Deletes the trend-chart summary history for a baseline. The next
/// scan starts a fresh history.
pub(crate) fn reset_summaries(baseline_sha: &str) -> Result<(), StorageError> {
    remove_if_exists(&paths::summaries_path(baseline_sha)?)
}

/// Deletes the per-rec change log for a baseline. The next scan that
/// flips a rec records the first event under the fresh log.
pub(crate) fn reset_changes(baseline_sha: &str) -> Result<(), StorageError> {
    remove_if_exists(&paths::changes_path(baseline_sha)?)
}

/// Writes `value` to `path` via a same-directory tempfile + rename so
/// a crash mid-write can't leave a partially-written file in place.
/// `fs::rename` is atomic on the same filesystem on both Windows and
/// Unix, and replaces the destination if it exists.
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
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
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|source| StorageError::Io {
        path: tmp.clone(),
        source,
    })?;
    fs::rename(&tmp, path).map_err(|source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

