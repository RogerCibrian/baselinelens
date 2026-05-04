//! Runtime data types produced by an audit run.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub baseline_sha256: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub device: DeviceInfo,
    pub results: HashMap<String, ScanResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub os_build: String,
    pub managed_by: Management,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Management {
    pub intune: bool,
    pub group_policy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub status: Status,
    pub current_value: Option<String>,
    pub error: Option<String>,
    pub measured_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum Status {
    Pass,
    Fail,
    Manual,
    Error,
}
