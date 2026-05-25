//! PDF text extraction.

#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::Path;

use lopdf::Document;
use pdf_extract::PlainTextOutput;

use crate::error::ParseError;

/// Upper bound on the page count we'll walk. A small file can still
/// declare a huge page tree; this caps the per-page loop so a malformed
/// or non-benchmark document fails fast instead of grinding. Real CIS
/// benchmark PDFs run to a few hundred pages, so the ceiling is generous.
const MAX_PDF_PAGES: u32 = 5000;

/// Returns an error when `total` exceeds [`MAX_PDF_PAGES`].
fn ensure_within_page_limit(total: u32) -> Result<(), ParseError> {
    if total > MAX_PDF_PAGES {
        return Err(ParseError::TooManyPages {
            pages: total,
            max: MAX_PDF_PAGES,
        });
    }
    Ok(())
}

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
/// no-password decryption attempt. A page that fails to render (an
/// encrypted or malformed page) aborts with a `PdfPage` error naming
/// the page, rather than silently dropping its recommendations.
pub(crate) fn extract_with_progress(
    bytes: &[u8],
    mut on_page: impl FnMut(u32, u32),
) -> Result<String, ParseError> {
    let doc = Document::load_mem(bytes).map_err(pdf_extract::OutputError::PdfError)?;
    let total = doc.get_pages().len() as u32;
    ensure_within_page_limit(total)?;
    let mut out = String::new();
    for page_num in 1..=total {
        let mut page_text = String::new();
        {
            let mut writer = PlainTextOutput::new(&mut page_text);
            // Abort on a page that won't render rather than silently
            // dropping its recommendations — a partial baseline the
            // user trusts as complete is worse than a clear failure.
            // The error names the page so it's actionable.
            pdf_extract::output_doc_page(&doc, &mut writer, page_num).map_err(|source| {
                ParseError::PdfPage {
                    page: page_num,
                    total,
                    source,
                }
            })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_limit_accepts_up_to_the_cap_and_rejects_past_it() {
        assert!(ensure_within_page_limit(MAX_PDF_PAGES).is_ok());
        match ensure_within_page_limit(MAX_PDF_PAGES + 1) {
            Err(ParseError::TooManyPages { pages, max }) => {
                assert_eq!(pages, MAX_PDF_PAGES + 1);
                assert_eq!(max, MAX_PDF_PAGES);
            }
            other => panic!("expected TooManyPages, got {other:?}"),
        }
    }
}
