//! Resolves the appdata directory and the on-disk locations for each
//! persisted artifact.

use std::path::PathBuf;

use directories::ProjectDirs;

use crate::storage::error::StorageError;

/// Returns the platform-appropriate appdata root for BaselineLens. The
/// qualifier/organization/application triplet matches `com.baselinelens.app`
/// (the bundle identifier in `tauri.conf.json`).
fn project_dirs() -> Result<ProjectDirs, StorageError> {
    ProjectDirs::from("com", "baselinelens", "app").ok_or(StorageError::NoDataDir)
}

/// Confirms `sha` is a bare SHA-256 hex digest before it's interpolated
/// into a filename or path segment. The value reaches us as an IPC
/// argument, so this rejects path separators, `..`, drive letters, and
/// anything else that could escape the data directory — a baseline id is
/// always 64 hex characters (`Sha256::digest` output), never a path.
fn validate_sha(sha: &str) -> Result<(), StorageError> {
    if sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(StorageError::InvalidBaselineSha)
    }
}

/// Root data directory. On macOS:
/// `~/Library/Application Support/com.baselinelens.app/`. On Windows:
/// `%APPDATA%\baselinelens\app\data\`.
pub(crate) fn data_dir() -> Result<PathBuf, StorageError> {
    Ok(project_dirs()?.data_dir().to_path_buf())
}

/// Path to the cross-baseline application state file.
pub(crate) fn app_state_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("app_state.json"))
}

/// Path to the per-baseline annotations (exceptions + notes) file.
pub(crate) fn user_state_path(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    validate_sha(baseline_sha)?;
    Ok(data_dir()?
        .join("user_states")
        .join(format!("{baseline_sha}.json")))
}

/// Path to the cached parsed `Baseline` for a given PDF SHA.
pub(crate) fn baseline_cache_path(sha: &str) -> Result<PathBuf, StorageError> {
    validate_sha(sha)?;
    Ok(data_dir()?.join("baselines").join(format!("{sha}.json")))
}

/// Path to the cached `audit.ps1` for a given audit-script schema
/// version. The script body is the same for every baseline (it reads
/// baseline JSON at runtime), so the version is the only thing that
/// could vary the on-disk file — bumping it produces a fresh cache
/// entry automatically.
pub(crate) fn audit_script_path(audit_script_version: u32) -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join(format!("audit_v{audit_script_version}.ps1")))
}

/// Path to the cached `device-info.ps1`. Sits next to `audit.ps1` so
/// the audit script can dot-source it via `$PSScriptRoot`, and so the
/// onboarding `get_device_info` command can invoke it directly.
pub(crate) fn device_info_script_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("device-info.ps1"))
}

/// Path to the cached `audit-registry.ps1` helper. Sits next to
/// `audit.ps1` so it resolves through `$PSScriptRoot` when dot-sourced.
pub(crate) fn audit_registry_script_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("audit-registry.ps1"))
}

/// Path to the cached `audit-security-policy.ps1` helper. Sits next to
/// `audit.ps1` so it resolves through `$PSScriptRoot` when dot-sourced.
pub(crate) fn audit_security_policy_script_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("audit-security-policy.ps1"))
}

/// Path to the cached `audit-system-read.ps1` helper, staged alongside
/// `audit.ps1` so the bootstrap can verify and dot-source it.
pub(crate) fn audit_system_read_script_path() -> Result<PathBuf, StorageError> {
    Ok(data_dir()?.join("audit-system-read.ps1"))
}

/// Directory holding the scan-related files for one baseline. The
/// `latest`/`changes`/`summaries` paths all build on this, so validating
/// here covers them too.
pub(crate) fn scans_dir_for_baseline(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    validate_sha(baseline_sha)?;
    Ok(data_dir()?.join("scans").join(baseline_sha))
}

/// Path to the most recent full `Scan` for a baseline. Overwritten on
/// each completed scan; the prior content (if any) feeds change-event
/// recording before being replaced.
pub(crate) fn latest_scan_path(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    Ok(scans_dir_for_baseline(baseline_sha)?.join("latest.json"))
}

/// Path to the per-baseline change log — JSONL of `ChangeEvent`s,
/// append-only.
pub(crate) fn changes_path(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    Ok(scans_dir_for_baseline(baseline_sha)?.join("changes.jsonl"))
}

/// Path to the per-baseline scan-summary file — a JSON array of
/// `ScanSummary` records, rewritten on each scan.
pub(crate) fn summaries_path(baseline_sha: &str) -> Result<PathBuf, StorageError> {
    Ok(scans_dir_for_baseline(baseline_sha)?.join("summaries.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_real_digest() {
        let sha = "a".repeat(64);
        assert!(validate_sha(&sha).is_ok());
    }

    #[test]
    fn rejects_traversal_and_malformed_ids() {
        for bad in [
            "",
            "short",
            &"a".repeat(63),
            &"a".repeat(65),
            r"..\..\..\windows\system32\config",
            "../../etc/passwd",
            "abc/def",
            &format!("{}{}", "a".repeat(62), ".."),
            &format!("{}{}", "g".repeat(64), ""), // 'g' isn't hex
        ] {
            assert!(
                validate_sha(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }
}
