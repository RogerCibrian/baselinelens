//! Collects streamed `ScanRecord`s into a `Scan`. Each record is keyed
//! by its rec id; if the same id arrives twice the later record wins
//! (the script is generated to emit each id exactly once, so this is
//! defensive rather than expected). The device info arrives separately,
//! once, via `set_device` before `finish` is called.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::audit::model::{DeviceInfo, Management, Scan, ScanRecord, ScanResult};

pub(crate) struct ScanCollector {
    baseline_sha256: String,
    parser_version: String,
    audit_script_version: String,
    started_at: DateTime<Utc>,
    device: Option<DeviceInfo>,
    results: HashMap<String, ScanResult>,
}

impl ScanCollector {
    pub(crate) fn new(
        baseline_sha256: String,
        parser_version: String,
        audit_script_version: String,
    ) -> Self {
        Self {
            baseline_sha256,
            parser_version,
            audit_script_version,
            started_at: Utc::now(),
            device: None,
            results: HashMap::new(),
        }
    }

    pub(crate) fn set_device(&mut self, device: DeviceInfo) {
        self.device = Some(device);
    }

    pub(crate) fn record(&mut self, record: ScanRecord) {
        self.results.insert(
            record.id,
            ScanResult {
                status: record.status,
                current_value: record.current_value,
                expected: record.expected,
                checks: record.checks,
                error: record.error,
                measured_at: record.measured_at,
            },
        );
    }

    pub(crate) fn finish(self, error: Option<String>) -> Scan {
        Scan {
            baseline_sha256: self.baseline_sha256,
            started_at: self.started_at,
            finished_at: Some(Utc::now()),
            device: self.device.unwrap_or_else(unknown_device),
            results: self.results,
            error,
            parser_version: self.parser_version,
            audit_script_version: self.audit_script_version,
        }
    }
}

/// Fallback DeviceInfo used when the audit script crashes before its
/// device line lands. Surfaces in the UI so the user can tell the
/// device-detection step failed rather than seeing fabricated values.
fn unknown_device() -> DeviceInfo {
    DeviceInfo {
        hostname: "unknown".into(),
        os_name: "unknown".into(),
        os_version: String::new(),
        os_build: String::new(),
        managed_by: Management {
            intune: false,
            group_policy: false,
        },
    }
}
