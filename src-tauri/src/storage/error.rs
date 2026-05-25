//! Storage-related error types.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum StorageError {
    #[error("Could not resolve the appdata directory for this platform.")]
    NoDataDir,

    #[error("Invalid baseline identifier.")]
    InvalidBaselineSha,

    #[error("Failed to read or write {path}.")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to (de)serialize JSON at {path}.")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}
