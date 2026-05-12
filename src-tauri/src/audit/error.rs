//! Audit-related error types.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum AuditError {
    #[error("failed to read or write {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to spawn powershell.exe")]
    Spawn(#[source] std::io::Error),

    #[error(
        "Admin rights weren't granted. The audit needs elevation to read local security policy \
         and audit-log configuration."
    )]
    ElevationDenied,

    #[error("powershell.exe exited with status {status}{}", format_stderr(.stderr))]
    NonZeroExit {
        status: i32,
        /// Stderr captured from the audit child. Folded into the
        /// Display output so the surfaced error message has at least
        /// some shape rather than just an exit code.
        stderr: Option<String>,
    },

    #[error("failed to parse NDJSON line: {line}")]
    Ndjson {
        line: String,
        #[source]
        source: serde_json::Error,
    },
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
