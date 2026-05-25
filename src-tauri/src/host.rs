//! Standalone device-info reader for the onboarding "Will scan" strip.
//! Invokes the same `device-info.ps1` that `audit.ps1` dot-sources
//! during a scan, parses its single-line JSON output, and returns a
//! `DeviceInfo`. Independent from the audit pipeline so the strip can
//! render before any scan has run.

use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

use thiserror::Error;

use crate::audit::error::AuditError;
use crate::audit::generator;
use crate::audit::model::DeviceInfo;

#[derive(Debug, Error)]
pub(crate) enum HostError {
    #[error("failed to prepare device-info script: {0}")]
    EnsureScript(#[from] AuditError),
    #[error("failed to spawn powershell: {0}")]
    Spawn(#[source] io::Error),
    #[error("device-info script exited {status}: {stderr}")]
    NonZeroExit { status: i32, stderr: String },
    #[error("device-info script returned empty output")]
    EmptyOutput,
    #[error("could not parse device-info JSON: {line}")]
    Parse {
        line: String,
        #[source]
        source: serde_json::Error,
    },
}

/// Reads device identity and management state from the local machine.
/// Blocks until PowerShell exits, so callers in async contexts should
/// run this on a blocking-thread pool.
pub(crate) fn read_device_info() -> Result<DeviceInfo, HostError> {
    let script = generator::ensure_device_info_script()?;
    spawn_and_parse(&script)
}

fn spawn_and_parse(script: &Path) -> Result<DeviceInfo, HostError> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-Emit")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(HostError::Spawn)?;

    if !output.status.success() {
        return Err(HostError::NonZeroExit {
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(HostError::EmptyOutput);
    }

    // The device-info script emits the same JSON shape `DeviceInfo`
    // deserializes from in the audit pipeline (minus the `type`
    // discriminator that's an NDJSON concern only), so direct
    // deserialization works without translation.
    serde_json::from_str(trimmed).map_err(|source| HostError::Parse {
        line: trimmed.to_string(),
        source,
    })
}
