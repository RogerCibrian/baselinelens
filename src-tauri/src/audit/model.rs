//! Runtime data types produced by an audit run.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scan {
    pub(crate) baseline_sha256: String,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
    pub(crate) device: DeviceInfo,
    pub(crate) results: HashMap<String, ScanResult>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceInfo {
    pub(crate) hostname: String,
    pub(crate) os_name: String,
    pub(crate) os_version: String,
    pub(crate) os_build: String,
    pub(crate) managed_by: Management,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Management {
    pub(crate) intune: bool,
    pub(crate) group_policy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    pub(crate) status: Status,
    pub(crate) current_value: Option<String>,
    /// Human-readable description of what the check expected, formatted
    /// by the PS script. Surfaced alongside `current_value` in the UI so
    /// users can see "wanted X, got Y" without opening the baseline JSON.
    pub(crate) expected: Option<String>,
    /// Per-check structured breakdown: one entry per `RegistryCheck` for
    /// Registry recs, or a single conceptual row for the other variants.
    /// The drawer renders this as a Path / Value / Expected / Found table.
    pub(crate) checks: Option<Vec<CheckDetail>>,
    pub(crate) error: Option<String>,
    pub(crate) measured_at: DateTime<Utc>,
}

/// One row in the per-rec check breakdown. Mirrors the `checks` array
/// shape emitted by `ps/audit.ps1`. `actual` is `None` when the value
/// was absent at scan time. `pass` is `None` for `Manual` recs where
/// there's no automated verdict.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckDetail {
    pub(crate) path: String,
    pub(crate) value_name: String,
    pub(crate) expected: String,
    pub(crate) actual: Option<String>,
    pub(crate) pass: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub(crate) enum Status {
    Pass,
    Fail,
    Manual,
    Error,
}

/// One line from the audit script's NDJSON stdout. Parsed by the runner
/// and forwarded to merge + frontend before being collapsed into a
/// `ScanResult` keyed by `id`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanRecord {
    pub(crate) id: String,
    pub(crate) status: Status,
    pub(crate) measured_at: DateTime<Utc>,
    pub(crate) current_value: Option<String>,
    pub(crate) expected: Option<String>,
    pub(crate) checks: Option<Vec<CheckDetail>>,
    pub(crate) error: Option<String>,
}
