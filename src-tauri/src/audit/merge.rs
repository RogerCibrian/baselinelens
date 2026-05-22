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
    parser_version: u32,
    audit_script_version: u32,
    started_at: DateTime<Utc>,
    device: Option<DeviceInfo>,
    results: HashMap<String, ScanResult>,
}

impl ScanCollector {
    pub(crate) fn new(
        baseline_sha256: String,
        parser_version: u32,
        audit_script_version: u32,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::model::Status;

    fn record(id: &str, status: Status, current: Option<&str>) -> ScanRecord {
        ScanRecord {
            id: id.to_string(),
            status,
            measured_at: Utc::now(),
            current_value: current.map(String::from),
            expected: None,
            checks: Vec::new(),
            error: None,
        }
    }

    fn collector() -> ScanCollector {
        ScanCollector::new("sha".to_string(), 1, 1)
    }

    #[test]
    fn record_keeps_latest_when_id_repeats() {
        let mut collector = collector();
        collector.record(record("1.1", Status::Fail, Some("old")));
        collector.record(record("1.1", Status::Pass, Some("new")));
        let scan = collector.finish(None);
        assert_eq!(scan.results.len(), 1);
        let result = &scan.results["1.1"];
        assert_eq!(result.status, Status::Pass);
        assert_eq!(result.current_value.as_deref(), Some("new"));
    }

    #[test]
    fn finish_stamps_finished_at_and_carries_error() {
        let mut collector = collector();
        collector.record(record("1.1", Status::Pass, None));
        let scan = collector.finish(Some("scan aborted".to_string()));
        assert!(scan.finished_at.is_some());
        assert_eq!(scan.error.as_deref(), Some("scan aborted"));
    }

    #[test]
    fn finish_falls_back_to_unknown_device_when_unset() {
        let scan = collector().finish(None);
        assert_eq!(scan.device.hostname, "unknown");
        assert!(!scan.device.managed_by.intune);
        assert!(!scan.device.managed_by.group_policy);
    }

    #[test]
    fn finish_uses_the_device_that_was_set() {
        let mut collector = collector();
        collector.set_device(DeviceInfo {
            hostname: "HOST-1".to_string(),
            os_name: "Windows 11".to_string(),
            os_version: "10.0".to_string(),
            os_build: "22631".to_string(),
            managed_by: Management {
                intune: true,
                group_policy: false,
            },
        });
        let scan = collector.finish(None);
        assert_eq!(scan.device.hostname, "HOST-1");
        assert!(scan.device.managed_by.intune);
    }
}
