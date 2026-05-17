//! Parser pipeline orchestrator.
//!
//! Reads a CIS benchmark PDF, extracts text, slices into raw recommendations,
//! classifies each one's audit procedure, and assembles a complete `Baseline`
//! with source metadata (SHA-256, parser version, parsed-at timestamp).

pub(crate) mod categories;
pub(crate) mod classify;
pub(crate) mod model;
pub(crate) mod pdf;
pub(crate) mod structure;

use std::path::Path;

use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;

use crate::error::ParseError;
use crate::parser::model::{
    Baseline, BaselineSource, Category, Recommendation, Reference, Remediation,
};

/// Version of the parser-output schema. Bumped whenever extraction logic
/// or the `Baseline` shape changes in a way that should invalidate older
/// cached output. The frontend compares this against a cached baseline's
/// `parser_version` and surfaces a re-parse prompt on mismatch.
pub(crate) const PARSER_VERSION: &str = "3";

/// Stages emitted by `parse_with_progress` so the UI can render a status
/// label and progress bar. `ExtractingText` and `Classifying` carry
/// `(done, total)` so the bar can move continuously through the slow
/// phases; the other stages are instantaneous.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "stage", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ParserProgress {
    ReadingFile,
    ComputingChecksum,
    ExtractingText { done: u32, total: u32 },
    SlicingRecommendations,
    Classifying { done: u32, total: u32 },
    Complete,
}

/// Parses the PDF at `path` into a fully-populated `Baseline`, invoking
/// `on_progress` at each pipeline stage so a caller (typically the Tauri
/// command) can stream progress updates to the UI.
pub(crate) fn parse_with_progress(
    path: &Path,
    mut on_progress: impl FnMut(ParserProgress),
) -> Result<Baseline, ParseError> {
    on_progress(ParserProgress::ReadingFile);
    let bytes = std::fs::read(path).map_err(|source| ParseError::Io {
        path: path.to_path_buf(),
        source,
    })?;

    on_progress(ParserProgress::ComputingChecksum);
    let pdf_sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let pdf_filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();

    // Emit the first ExtractingText event at 0/0 so the UI swaps to
    // the progress-bar phase immediately; the per-page callback then
    // refines `total` as soon as lopdf has parsed the document.
    on_progress(ParserProgress::ExtractingText { done: 0, total: 0 });
    let text = pdf::extract_with_progress(&bytes, |done, total| {
        on_progress(ParserProgress::ExtractingText { done, total });
    })?;
    let (benchmark_name, benchmark_version) = extract_benchmark_metadata(&text);

    on_progress(ParserProgress::SlicingRecommendations);
    let raw_recs = structure::slice(&text)?;

    let total = raw_recs.len() as u32;
    on_progress(ParserProgress::Classifying { done: 0, total });
    let recommendations: Vec<Recommendation> = raw_recs
        .into_iter()
        .enumerate()
        .map(|(idx, raw)| {
            let rec = build_recommendation(raw);
            let done = (idx as u32) + 1;
            // Coalesce per-rec updates so we send roughly 18 events instead
            // of 457 (the channel can keep up either way; this just keeps
            // event traffic reasonable).
            if done.is_multiple_of(25) || done == total {
                on_progress(ParserProgress::Classifying { done, total });
            }
            rec
        })
        .collect();
    let categories = derive_categories(&recommendations, &text);

    let source = BaselineSource {
        benchmark_name,
        benchmark_version,
        pdf_filename,
        pdf_sha256,
        parsed_at: Utc::now(),
        parser_version: PARSER_VERSION.to_string(),
    };

    on_progress(ParserProgress::Complete);
    Ok(Baseline {
        source,
        categories,
        recommendations,
    })
}

/// Reads the benchmark name and version from the PDF's first-page header.
/// The header has this shape:
///
/// ```text
/// CIS Microsoft Intune for
/// Windows 11 Benchmark
/// v4.0.0 - 04-25-2025
/// Terms of Use
/// ```
///
/// Name lines wrap, the version line starts with `v<digit>`, and `Terms of
/// Use` always follows. Returns empty strings if either can't be found —
/// callers should treat that as a parse anomaly worth logging.
fn extract_benchmark_metadata(text: &str) -> (String, String) {
    let mut name_parts: Vec<String> = Vec::new();
    let mut version = String::new();

    for line in text.lines().take(50) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "Terms of Use" {
            break;
        }
        if let Some(parsed_version) = parse_version_token(trimmed) {
            version = parsed_version;
            break;
        }
        name_parts.push(trimmed.to_string());
    }

    let name = name_parts.join(" ");
    (name, version)
}

/// Returns the leading `v<digits>(.<digits>)+` token from `line`, or `None`
/// if the line doesn't start with that pattern.
fn parse_version_token(line: &str) -> Option<String> {
    let mut chars = line.chars();
    if chars.next() != Some('v') {
        return None;
    }
    if !chars.next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        return None;
    }
    let token: String = line
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    Some(token)
}

fn build_recommendation(raw: structure::RawRecommendation) -> Recommendation {
    let audit = classify::audit_procedure(&raw);
    let category_number = derive_category_number(&raw.id);
    let remediation = raw
        .sections
        .remediation
        .as_ref()
        .map(|description| Remediation {
            description: description.clone(),
            settings_catalog_path: extract_settings_catalog_path(description),
            default_value: raw.sections.default_value.clone(),
        });
    let references = parse_references(raw.sections.references.as_deref());

    Recommendation {
        id: raw.id,
        level: raw.level,
        bitlocker: raw.bitlocker,
        category_number,
        title: raw.title,
        description: raw.sections.description.unwrap_or_default(),
        rationale: raw.sections.rationale,
        impact: raw.sections.impact,
        assessment: raw.assessment,
        audit,
        remediation,
        references,
    }
}

/// Returns everything before the last `.` in `id`. For `4.6.11.1` returns
/// `4.6.11`; for top-level ids without a `.` returns an empty string.
fn derive_category_number(id: &str) -> String {
    id.rsplit_once('.')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_default()
}

/// Pulls the Settings Catalog path out of the remediation text. The path
/// follows a "set the following Settings Catalog path …:" line and is the
/// next non-empty line that contains a `\` separator.
fn extract_settings_catalog_path(remediation: &str) -> Option<String> {
    let mut found_intro = false;
    for line in remediation.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !found_intro {
            if trimmed.contains("Settings Catalog path") {
                found_intro = true;
            }
            continue;
        }
        if trimmed.contains('\\') {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Parses the References section into structured entries. Each numbered
/// item (`1. …`, `2. …`) becomes either `Reference::Url` (when it starts
/// with `http`) or `Reference::Note`.
fn parse_references(text: Option<&str>) -> Vec<Reference> {
    let Some(text) = text else { return Vec::new() };
    let mut refs = Vec::new();
    let mut current: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some((number, rest)) = trimmed.split_once(". ")
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
        {
            if let Some(prev) = current.take() {
                refs.push(make_reference(&prev));
            }
            current = Some(rest.to_string());
            continue;
        }

        if let Some(buf) = current.as_mut() {
            buf.push_str(trimmed);
        }
    }

    if let Some(last) = current {
        refs.push(make_reference(&last));
    }
    refs
}

fn make_reference(text: &str) -> Reference {
    let trimmed = text.trim().trim_end_matches(|c: char| c.is_whitespace());
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Reference::Url {
            url: trimmed.to_string(),
        }
    } else {
        Reference::Note {
            text: trimmed.to_string(),
        }
    }
}

/// Builds the `Vec<Category>` from the recommendations' IDs and the raw
/// PDF text. Each category's `name` is its full hierarchical path joined
/// with " - ", assembled by walking the parent chain and looking up each
/// ancestor's local heading. Levels without a matching heading in the PDF
/// are skipped silently.
fn derive_categories(recs: &[Recommendation], text: &str) -> Vec<Category> {
    use std::collections::{BTreeSet, HashSet};

    let mut numbers: BTreeSet<String> = BTreeSet::new();
    for rec in recs {
        let parts: Vec<&str> = rec.category_number.split('.').collect();
        for cutoff in 1..=parts.len() {
            let prefix = parts[..cutoff].join(".");
            if !prefix.is_empty() {
                numbers.insert(prefix);
            }
        }
    }

    let valid_numbers: HashSet<String> = numbers.iter().cloned().collect();
    let local_names = categories::extract_local_names(text, &valid_numbers);

    numbers
        .into_iter()
        .map(|number| {
            let parent = number
                .rsplit_once('.')
                .map(|(prefix, _)| prefix.to_string());
            let name = categories::build_full_path(&number, &local_names);
            Category {
                number,
                name,
                parent,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::model::AuditProcedure;

    #[test]
    fn extracts_benchmark_metadata_from_header() {
        let text = "  CIS Microsoft Intune for\n  Windows 11 Benchmark\nv4.0.0 - 04-25-2025\nTerms of Use\nPlease see…";
        let (name, version) = extract_benchmark_metadata(text);
        assert_eq!(name, "CIS Microsoft Intune for Windows 11 Benchmark");
        assert_eq!(version, "v4.0.0");
    }

    #[test]
    fn returns_empty_strings_when_metadata_missing() {
        let text = "No header at all\nJust some text\n";
        let (name, version) = extract_benchmark_metadata(text);
        assert_eq!(name, "No header at all Just some text");
        assert_eq!(version, "");
    }

    #[test]
    fn parses_version_token() {
        assert_eq!(parse_version_token("v4.0.0"), Some("v4.0.0".to_string()));
        assert_eq!(
            parse_version_token("v4.0.0 - 04-25-2025"),
            Some("v4.0.0".to_string())
        );
        assert_eq!(parse_version_token("v2.1"), Some("v2.1".to_string()));
        assert_eq!(parse_version_token("Version 4.0.0"), None);
        assert_eq!(parse_version_token("v"), None);
        assert_eq!(parse_version_token("vX.Y"), None);
    }

    #[test]
    fn derives_category_number_from_id() {
        assert_eq!(derive_category_number("4.6.11.1"), "4.6.11");
        assert_eq!(derive_category_number("1.1"), "1");
        assert_eq!(derive_category_number("5"), "");
    }

    #[test]
    fn parses_references_into_url_and_note_kinds() {
        let text = "\
1.  https://learn.microsoft.com/en-us/foo
2.  Minimum OS CSP: Windows 10, Version 1607 and later
3.  GRID: MS-00000510
";
        let refs = parse_references(Some(text));
        assert_eq!(refs.len(), 3);
        match &refs[0] {
            Reference::Url { url } => assert_eq!(url, "https://learn.microsoft.com/en-us/foo"),
            _ => panic!("expected URL"),
        }
        match &refs[1] {
            Reference::Note { text } => {
                assert_eq!(text, "Minimum OS CSP: Windows 10, Version 1607 and later")
            }
            _ => panic!("expected Note"),
        }
    }

    #[test]
    fn extracts_settings_catalog_path_from_remediation() {
        let remediation = "\
To establish the recommended configuration via configuration profiles, set the following
Settings Catalog path to Disabled:
Above Lock\\Allow Cortana Above Lock
";
        assert_eq!(
            extract_settings_catalog_path(remediation).as_deref(),
            Some("Above Lock\\Allow Cortana Above Lock")
        );
    }

    #[test]
    #[ignore = "diagnostic — dumps parsed categories; drive with BASELINELENS_TEST_PDF"]
    fn inspect_categories() {
        let pdf_path = std::env::var("BASELINELENS_TEST_PDF")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf")
            });
        let baseline =
            parse_with_progress(&pdf_path, |_| {}).expect("parse should succeed");
        let mut cats: Vec<_> = baseline.categories.iter().collect();
        cats.sort_by(|a, b| a.number.cmp(&b.number));
        for cat in cats {
            let suspect = cat.name.is_empty()
                || cat.name.ends_with('.')
                || cat
                    .name
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_lowercase())
                    .unwrap_or(false);
            eprintln!(
                "{}[{}] {:?}",
                if suspect { ">>SUSPECT " } else { "" },
                cat.number,
                cat.name
            );
        }
    }

    #[test]
    #[ignore = "requires dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf on disk"]
    fn parses_real_pdf_into_complete_baseline() {
        let pdf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
        let baseline =
            parse_with_progress(&pdf_path, |_| {}).expect("parse should succeed");

        assert_eq!(baseline.recommendations.len(), 457);
        assert_eq!(
            baseline.source.benchmark_name,
            "CIS Microsoft Intune for Windows 11 Benchmark"
        );
        assert_eq!(baseline.source.benchmark_version, "v4.0.0");
        assert_eq!(baseline.source.pdf_sha256.len(), 64);
        assert!(!baseline.source.pdf_filename.is_empty());

        // Every rec must have an audit procedure (no Manual fallbacks).
        for rec in &baseline.recommendations {
            assert!(
                !matches!(rec.audit, AuditProcedure::Manual { .. }),
                "rec {} fell back to Manual: {:?}",
                rec.id,
                rec.audit
            );
        }

        // Categories should cover every rec's category_number.
        let category_numbers: std::collections::HashSet<&str> = baseline
            .categories
            .iter()
            .map(|c| c.number.as_str())
            .collect();
        for rec in &baseline.recommendations {
            if !rec.category_number.is_empty() {
                assert!(
                    category_numbers.contains(rec.category_number.as_str()),
                    "category {} missing from baseline.categories",
                    rec.category_number
                );
            }
        }

        // Every category should have a non-empty name (extracted from the
        // PDF body), and nested categories should produce a hierarchical
        // path joined with " - ". Names should also be free of TOC
        // leader-dots, which would indicate the parser captured a TOC
        // entry instead of the real body heading.
        for cat in &baseline.categories {
            assert!(
                !cat.name.is_empty(),
                "category {} has empty name",
                cat.number
            );
            assert!(
                !cat.name.contains("..."),
                "category {} captured TOC leader dots: {:?}",
                cat.number,
                cat.name
            );
            let depth = cat.number.matches('.').count();
            if depth >= 1 {
                assert!(
                    cat.name.contains(" - "),
                    "nested category {} should join ancestor names with ' - ', got {:?}",
                    cat.number,
                    cat.name
                );
            }
        }
    }
}
