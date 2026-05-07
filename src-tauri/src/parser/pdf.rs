//! PDF text extraction.

use std::fs;
use std::path::Path;

use crate::error::ParseError;

/// Extracts the textual content of the PDF at `path` as a single UTF-8 string.
///
/// Output is the raw extractor output: line-wrapped roughly as the PDF was
/// laid out, with trailing spaces and page-footer artifacts intact.
/// Normalization (dewrapping wrapped tokens, stripping page furniture, slicing
/// the table-of-contents) is the responsibility of `parser::structure`.
pub(crate) fn extract(path: &Path) -> Result<String, ParseError> {
    let bytes = fs::read(path).map_err(|source| ParseError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let text = pdf_extract::extract_text_from_mem(&bytes)?;
    Ok(text)
}
