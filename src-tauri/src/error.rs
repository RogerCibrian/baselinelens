//! Parser-related error types.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum ParseError {
    #[error("Failed to read PDF at {path}.")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to extract text from PDF.")]
    PdfExtract(#[from] pdf_extract::OutputError),

    #[error(
        "Could not render PDF page {page} of {total}; the file may be \
         corrupted or contain an unsupported page."
    )]
    PdfPage {
        page: u32,
        total: u32,
        #[source]
        source: pdf_extract::OutputError,
    },

    #[error(
        "The PDF is too large to parse ({} MB; the limit is {} MB). Check that this \
         is the benchmark PDF.",
        .bytes / 1_048_576,
        .max / 1_048_576
    )]
    TooLarge { bytes: u64, max: u64 },

    #[error(
        "The PDF has {pages} pages, more than the {max}-page limit. Check that this \
         is the benchmark PDF."
    )]
    TooManyPages { pages: u32, max: u32 },

    #[error("Could not locate the Recommendations chapter in the PDF body.")]
    BodyNotFound,
}
