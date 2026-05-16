//! PDF text extraction.

#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::Path;

use lopdf::Document;
use pdf_extract::PlainTextOutput;

use crate::error::ParseError;

/// Extracts the textual content of `bytes` as a single UTF-8 string,
/// invoking `on_page` after each page is processed so a caller can
/// render a determinate progress bar. Arguments are `(page_done,
/// total_pages)`, both 1-based at the call site.
///
/// Output is the raw extractor output, page-text concatenated in
/// reading order. Normalization (dewrapping, stripping page furniture,
/// slicing the table-of-contents) is the responsibility of
/// `parser::structure`.
///
/// CIS benchmarks ship unencrypted, so we skip pdf-extract's optional
/// no-password decryption attempt. Encrypted PDFs surface as a
/// `PdfExtract` error from the per-page render.
pub(crate) fn extract_with_progress(
    bytes: &[u8],
    mut on_page: impl FnMut(u32, u32),
) -> Result<String, ParseError> {
    let doc = Document::load_mem(bytes).map_err(pdf_extract::OutputError::PdfError)?;
    let total = doc.get_pages().len() as u32;
    let mut out = String::new();
    for page_num in 1..=total {
        let mut page_text = String::new();
        {
            let mut writer = PlainTextOutput::new(&mut page_text);
            pdf_extract::output_doc_page(&doc, &mut writer, page_num)?;
        }
        out.push_str(&page_text);
        on_page(page_num, total);
    }
    Ok(out)
}

/// No-progress path wrapper used by the parser unit tests that just
/// need a `String` of extracted text from a PDF on disk.
#[cfg(test)]
pub(crate) fn extract(path: &Path) -> Result<String, ParseError> {
    let bytes = fs::read(path).map_err(|source| ParseError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    extract_with_progress(&bytes, |_, _| {})
}
