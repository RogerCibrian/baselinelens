//! Parser-related error types.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum ParseError {
    #[error("failed to read PDF at {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to extract text from PDF")]
    PdfExtract(#[from] pdf_extract::OutputError),

    #[error("could not locate the Recommendations chapter in the PDF body")]
    BodyNotFound,
}
