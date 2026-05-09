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
    pub(crate) error: Option<String>,
    pub(crate) measured_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub(crate) enum Status {
    Pass,
    Fail,
    Manual,
    Error,
}
