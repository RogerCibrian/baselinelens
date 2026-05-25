//! Audit-related error types.

use std::path::PathBuf;

use thiserror::Error;

use crate::storage::error::StorageError;

#[derive(Debug, Error)]
pub(crate) enum AuditError {
    #[error("Failed to read or write {path}.")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Propagated from the storage layer when resolving paths or
    /// reading/writing baselines fails. Held as the original
    /// `StorageError` so the path and source chain survive — its
    /// `Display` is already user-readable and surfaces unchanged through
    /// `#[error(transparent)]`.
    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error("Failed to spawn powershell.exe.")]
    Spawn(#[source] std::io::Error),

    #[error(
        "Admin rights weren't granted. The audit needs elevation to read local security policy \
         and audit-log configuration."
    )]
    ElevationDenied,

    #[error("PowerShell exited with status {status}{}", format_stderr(.stderr))]
    NonZeroExit {
        status: i32,
        /// Stderr captured from the audit child. Folded into the
        /// Display output so the surfaced error message has at least
        /// some shape rather than just an exit code.
        stderr: Option<String>,
    },

    #[error("Failed to parse NDJSON line: {line}")]
    Ndjson {
        line: String,
        #[source]
        source: serde_json::Error,
    },

    /// The audit script reported a fatal condition and stopped before
    /// finishing — emitted as a `{"type":"fatal",...}` NDJSON line. The
    /// integrity-check failure (a staged script whose bytes no longer
    /// match what the binary wrote) lands here, as does a baseline that
    /// fails to load inside the elevated child. Carries the script's own
    /// message so the cause survives the boundary that otherwise drops
    /// the elevated child's stderr.
    #[error("The audit could not complete: {message}")]
    ScriptFatal { message: String },

    #[error(
        "The scan ran with admin rights but produced no results. The elevated \
         process may have been blocked by security software or system policy, \
         or failed to start. Try scanning again."
    )]
    NoOutput,

    #[error(
        "The scan timed out. PowerShell did not finish within {} minutes and was stopped.",
        .secs / 60
    )]
    Timeout { secs: u64 },

    #[error("Scan cancelled.")]
    Cancelled,
}

/// Helper for the `NonZeroExit` Display impl. Renders `: <text>` when
/// stderr was non-empty so the user-facing string carries some clue,
/// or an empty string otherwise so we don't dangle a colon.
fn format_stderr(stderr: &Option<String>) -> String {
    match stderr.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => format!(": {text}"),
        _ => String::new(),
    }
}
