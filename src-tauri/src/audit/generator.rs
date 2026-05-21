//! Ensures the static `audit.ps1` and its sibling `device-info.ps1` are
//! on disk and returns the audit-script path. The audit body is the same
//! for every baseline — it reads the baseline JSON at runtime and
//! dispatches per recommendation — so there's no per-baseline rendering
//! step. Versioning the audit filename means a script edit naturally
//! invalidates the cache without each call having to compare contents.
//!
//! `device-info.ps1` lives next to the audit script (so the audit
//! script can dot-source it via `$PSScriptRoot`) and is also the
//! standalone entry point for the onboarding `get_device_info` command.

use std::fs;
use std::path::{Path, PathBuf};

use crate::audit::AUDIT_SCRIPT_VERSION;
use crate::audit::error::AuditError;
use crate::storage::paths;

/// Static audit-script content, baked into the binary so the runtime
/// doesn't have to discover a `ps/` directory on disk.
const AUDIT_SCRIPT: &str = include_str!("../../ps/audit.ps1");

/// Static device-info script content. Same baking rationale as the
/// audit script.
const DEVICE_INFO_SCRIPT: &str = include_str!("../../ps/device-info.ps1");

/// Writes both `audit.ps1` and `device-info.ps1` to disk and returns
/// the audit-script path. Overwrites unconditionally on every call —
/// the embedded scripts are a few kilobytes, the writes are
/// microseconds, and "always current" is worth more than the saved I/O.
pub(crate) fn ensure_script() -> Result<PathBuf, AuditError> {
    ensure_device_info_script()?;
    let path = paths::audit_script_path(AUDIT_SCRIPT_VERSION)?;
    write_script(&path, AUDIT_SCRIPT)?;
    Ok(path)
}

/// Writes `device-info.ps1` to disk and returns its path. Used by the
/// onboarding `get_device_info` command (which needs the script
/// standalone) and by `ensure_script` (which co-locates it next to
/// `audit.ps1` so dot-sourcing works).
pub(crate) fn ensure_device_info_script() -> Result<PathBuf, AuditError> {
    let path = paths::device_info_script_path()?;
    write_script(&path, DEVICE_INFO_SCRIPT)?;
    Ok(path)
}

fn write_script(path: &Path, body: &str) -> Result<(), AuditError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| AuditError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, body).map_err(|source| AuditError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::model::{
        AuditPolicyMode, AuditProcedure, ExpectedValue, MatchMode, PolicyScope, RegistryCheck,
        Value,
    };
    use serde_json::Value as JsonValue;

    /// Reads the on-disk `audit.ps1`. Tests cover whether its dispatch
    /// `switch` statements match the Rust enum variants — going through
    /// the source file rather than the in-binary `include_str!` so a
    /// rename to the file path is also caught.
    fn read_audit_script() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("ps")
            .join("audit.ps1");
        fs::read_to_string(&path).expect("ps/audit.ps1 should be readable from the source tree")
    }

    /// Extracts the `"type"` tag from `value`'s JSON form. Used to derive
    /// the PowerShell dispatch label for a variant directly from serde's
    /// output, so the test sees exactly what the wire format produces.
    fn serde_tag<T: serde::Serialize>(value: &T) -> String {
        let json = serde_json::to_value(value).expect("variant should serialize");
        match &json {
            JsonValue::Object(map) => map
                .get("type")
                .and_then(|v| v.as_str())
                .expect("variant should carry a `type` tag")
                .to_string(),
            other => panic!("variant should serialize to an object, got {other}"),
        }
    }

    fn assert_ps_has_case(ps: &str, tag: &str, context: &str) {
        // PowerShell `switch` cases are single-quoted string literals.
        // Looking for the exact `'<Tag>'` form keeps the search precise
        // — substring-anywhere would false-positive on comments.
        let needle = format!("'{tag}'");
        assert!(
            ps.contains(&needle),
            "ps/audit.ps1 has no dispatch case for {context} variant `{tag}`"
        );
    }

    #[test]
    fn ps_dispatch_handles_every_audit_procedure_variant() {
        let samples = audit_procedure_samples();
        let ps = read_audit_script();
        for sample in &samples {
            let tag = serde_tag(sample);
            assert_ps_has_case(&ps, &tag, "AuditProcedure");
        }
    }

    #[test]
    fn ps_dispatch_handles_every_expected_value_variant() {
        let samples = expected_value_samples();
        let ps = read_audit_script();
        for sample in &samples {
            let tag = serde_tag(sample);
            assert_ps_has_case(&ps, &tag, "ExpectedValue");
        }
    }

    #[test]
    fn ps_dispatch_handles_every_value_variant() {
        let samples = value_samples();
        let ps = read_audit_script();
        for sample in &samples {
            let tag = serde_tag(sample);
            assert_ps_has_case(&ps, &tag, "Value");
        }
    }

    // ----------------------------------------------------------------------
    // Variant samples
    //
    // One sample per variant of each enum. The `_force_exhaustive_*`
    // functions below are dead code at runtime but have to pattern-match
    // every variant — adding a new variant breaks compilation there
    // until you add a sample below as well. Manual discipline catches the
    // pairing; if the discipline slips, the test silently loses
    // coverage for the new variant rather than failing loudly. Worth
    // revisiting if a variant ever ships unhandled.
    // ----------------------------------------------------------------------

    fn audit_procedure_samples() -> Vec<AuditProcedure> {
        vec![
            AuditProcedure::Registry { checks: vec![] },
            AuditProcedure::PolicyManager {
                scope: PolicyScope::Device,
                area: String::new(),
                setting: String::new(),
                expected: ExpectedValue::Absent,
            },
            AuditProcedure::UserRightsAssignment {
                right_name: String::new(),
                expected: vec![],
                matching: MatchMode::Exact,
            },
            AuditProcedure::Secedit {
                setting: String::new(),
                expected: ExpectedValue::Absent,
            },
            AuditProcedure::AuditPolicy {
                subcategory_guid: String::new(),
                expected: AuditPolicyMode::Success,
                matching: MatchMode::Exact,
            },
            AuditProcedure::Manual {
                description: String::new(),
            },
        ]
    }

    #[allow(dead_code)]
    fn _force_exhaustive_audit_procedure(v: AuditProcedure) {
        match v {
            AuditProcedure::Registry { .. }
            | AuditProcedure::PolicyManager { .. }
            | AuditProcedure::UserRightsAssignment { .. }
            | AuditProcedure::Secedit { .. }
            | AuditProcedure::AuditPolicy { .. }
            | AuditProcedure::Manual { .. } => {}
        }
    }

    fn expected_value_samples() -> Vec<ExpectedValue> {
        vec![
            ExpectedValue::Equals {
                value: Value::Dword { value: 0 },
            },
            ExpectedValue::NotEquals {
                value: Value::Dword { value: 0 },
            },
            ExpectedValue::AtLeast { value: 0 },
            ExpectedValue::AtMost { value: 0 },
            ExpectedValue::OneOf {
                values: vec![Value::Dword { value: 0 }],
            },
            ExpectedValue::Contains {
                substring: String::new(),
            },
            ExpectedValue::ContainsAll { substrings: vec![] },
            ExpectedValue::Absent,
            ExpectedValue::AbsentOr {
                inner: Box::new(ExpectedValue::Absent),
            },
            ExpectedValue::All { values: vec![] },
            ExpectedValue::Any { values: vec![] },
        ]
    }

    #[allow(dead_code)]
    fn _force_exhaustive_expected_value(v: ExpectedValue) {
        match v {
            ExpectedValue::Equals { .. }
            | ExpectedValue::NotEquals { .. }
            | ExpectedValue::AtLeast { .. }
            | ExpectedValue::AtMost { .. }
            | ExpectedValue::OneOf { .. }
            | ExpectedValue::Contains { .. }
            | ExpectedValue::ContainsAll { .. }
            | ExpectedValue::Absent
            | ExpectedValue::AbsentOr { .. }
            | ExpectedValue::All { .. }
            | ExpectedValue::Any { .. } => {}
        }
    }

    fn value_samples() -> Vec<Value> {
        vec![
            Value::Dword { value: 0 },
            Value::QDword { value: 0 },
            Value::Str {
                value: String::new(),
            },
            Value::MultiStr { values: vec![] },
            Value::Binary { bytes: vec![] },
        ]
    }

    #[allow(dead_code)]
    fn _force_exhaustive_value(v: Value) {
        match v {
            Value::Dword { .. }
            | Value::QDword { .. }
            | Value::Str { .. }
            | Value::MultiStr { .. }
            | Value::Binary { .. } => {}
        }
    }

    // Avoids unused-import warnings for the `RegistryCheck` type — it's
    // referenced only via the `AuditProcedure::Registry` variant which
    // takes `Vec<RegistryCheck>`, so the type is visible in `samples` but
    // not actually constructed.
    #[allow(dead_code)]
    fn _registry_check_anchor(_: RegistryCheck) {}
}
