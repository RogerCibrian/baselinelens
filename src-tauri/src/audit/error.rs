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

    #[error("powershell.exe exited with status {status}")]
    NonZeroExit { status: i32 },

    #[error("failed to parse NDJSON line: {line}")]
    Ndjson {
        line: String,
        #[source]
        source: serde_json::Error,
    },
}
