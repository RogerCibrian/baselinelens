//! Durable user state, persisted across scans and re-imports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserState {
    pub baseline_sha256: String,
    pub exceptions: HashMap<String, Exception>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Exception {
    pub reason: String,
    pub granted_at: DateTime<Utc>,
    pub granted_by: Option<String>,
}
