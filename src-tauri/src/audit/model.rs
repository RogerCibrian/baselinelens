//! Runtime data types produced by an audit run.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scan {
    pub(crate) baseline_sha256: String,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
    pub(crate) device: DeviceInfo,
    pub(crate) results: HashMap<String, ScanResult>,
    pub(crate) error: Option<String>,
    /// Snapshot of `PARSER_VERSION` at scan time. Lets the UI detect when
    /// a saved scan was produced under a different parser/script schema
    /// before drawing cross-scan comparisons (deltas, trend chart).
    pub(crate) parser_version: String,
    /// Snapshot of `AUDIT_SCRIPT_VERSION` at scan time. Same intent as
    /// `parser_version` — captures the schema half that the audit script
    /// owns (status enum, check shape, NDJSON contract).
    pub(crate) audit_script_version: String,
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

/// One status flip detected at scan time. Appended to `changes.jsonl`
/// whenever a rec's status differs from its prior recorded value.
/// `from_status` is `None` for the first observation of a rec (no prior
/// value to compare against). The frontend reads the most recent event
/// per rec to drive persistent delta indicators — the flag stays
/// "regressed" or "improved" until another event for the same rec
/// supersedes it, regardless of how many no-op rescans happen between.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangeEvent {
    pub(crate) rec_id: String,
    pub(crate) from_status: Option<Status>,
    pub(crate) to_status: Status,
    pub(crate) observed_at: DateTime<Utc>,
    pub(crate) parser_version: String,
    pub(crate) audit_script_version: String,
}

/// Lightweight per-scan record for the trend chart and headline
/// math. Kept separate from full `Scan` files so we can show months of
/// history without growing storage materially — counts mean the same
/// thing across schema versions, so old summaries stay readable even
/// when the underlying scan format evolves.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanSummary {
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
    pub(crate) pass: u32,
    pub(crate) fail: u32,
    pub(crate) manual: u32,
    pub(crate) error: u32,
    /// Count of Fail results that carry a matching entry in the user's
    /// exception list at scan time. Held separately from `fail` so the
    /// trend math can exclude accepted exceptions from the In-scope
    /// rate, matching the level cards.
    pub(crate) exception: u32,
    pub(crate) parser_version: String,
    pub(crate) audit_script_version: String,
}

/// Bundles the scan-related state for a baseline as the dashboard
/// needs it. `latest` drives current-scan rendering; `changes` powers
/// per-rec delta indicators with persistence (a flag stays until the
/// rec actually flips again, not just until the next no-op rescan);
/// `summaries` feeds the trend chart and headline math.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanContext {
    pub(crate) latest: Option<Scan>,
    pub(crate) changes: Vec<ChangeEvent>,
    pub(crate) summaries: Vec<ScanSummary>,
}

impl ScanSummary {
    /// Derives a summary from a full `Scan` by tallying its results.
    /// A Fail whose `rec_id` appears in `exception_ids` is counted toward
    /// `exception` instead of `fail`. A Manual whose `rec_id` appears in
    /// `attested_pass` / `attested_fail` is counted as `pass` / `fail`
    /// instead of `manual`. Both mirror the frontend's `effectiveStatus`
    /// so trend math matches what the level cards show.
    pub(crate) fn from_scan(
        scan: &Scan,
        exception_ids: &HashSet<&str>,
        attested_pass: &HashSet<&str>,
        attested_fail: &HashSet<&str>,
    ) -> Self {
        let mut pass = 0u32;
        let mut fail = 0u32;
        let mut manual = 0u32;
        let mut error = 0u32;
        let mut exception = 0u32;
        for (rec_id, result) in &scan.results {
            match result.status {
                Status::Pass => pass += 1,
                Status::Fail => {
                    if exception_ids.contains(rec_id.as_str()) {
                        exception += 1;
                    } else {
                        fail += 1;
                    }
                }
                Status::Manual => {
                    if attested_pass.contains(rec_id.as_str()) {
                        pass += 1;
                    } else if attested_fail.contains(rec_id.as_str()) {
                        fail += 1;
                    } else {
                        manual += 1;
                    }
                }
                Status::Error => error += 1,
            }
        }
        Self {
            started_at: scan.started_at,
            finished_at: scan.finished_at,
            pass,
            fail,
            manual,
            error,
            exception,
            parser_version: scan.parser_version.clone(),
            audit_script_version: scan.audit_script_version.clone(),
        }
    }
}
