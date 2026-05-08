//! PDF text → ordered list of raw recommendations with labeled body sections.
//!
//! Per-variant audit-procedure parsing (Registry, PolicyManager, etc.) lives
//! in `classify`. This module's job is purely structural: skip the table of
//! contents, find each recommendation's heading, and slice its body into the
//! standard labeled sections (Description, Audit, Remediation, …).

use crate::error::ParseError;
use crate::parser::model::{Assessment, Level};

#[derive(Debug, Clone)]
pub(crate) struct RawRecommendation {
    pub id: String,
    pub level: Level,
    pub assessment: Assessment,
    pub title: String,
    pub sections: BodySections,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BodySections {
    pub profile_applicability: Option<String>,
    pub description: Option<String>,
    pub rationale: Option<String>,
    pub impact: Option<String>,
    pub audit: Option<String>,
    pub remediation: Option<String>,
    pub default_value: Option<String>,
    pub references: Option<String>,
}

/// Slices the extracted PDF text into one `RawRecommendation` per heading.
///
/// Skips the table of contents (everything before the `Recommendations`
/// chapter heading), then for each rec heading captures the labeled body
/// sections (`Description:`, `Audit:`, `Remediation:`, …) as raw strings.
/// Per-variant audit-procedure parsing is `classify`'s job, not this one.
pub(crate) fn slice(text: &str) -> Result<Vec<RawRecommendation>, ParseError> {
    // Lines are kept as-extracted (no `trim_end`) so that downstream consumers
    // can use the trailing-space signal to detect logical-space line wraps
    // (e.g. `HKU\[USER \nSID]\...` vs mid-token wraps like `\\*\NE\nTLOGON`).
    let lines: Vec<&str> = text.lines().collect();

    let body_start = lines
        .iter()
        .position(|line| line.trim() == "Recommendations")
        .ok_or(ParseError::BodyNotFound)?
        + 1;
    let body = &lines[body_start..];

    let headings = locate_headings(body);

    let mut recs = Vec::with_capacity(headings.len());
    for (i, h) in headings.iter().enumerate() {
        let body_end = headings
            .get(i + 1)
            .map(|next| next.start)
            .unwrap_or(body.len());

        let title = read_title(&body[h.start..h.body_start]);
        let sections = split_sections(&body[h.body_start..body_end]);

        recs.push(RawRecommendation {
            id: h.id.clone(),
            level: h.level,
            assessment: h.assessment,
            title,
            sections,
        });
    }
    Ok(recs)
}

#[derive(Debug)]
struct Heading {
    /// Index into `body` of the heading's first line.
    start: usize,
    /// Index into `body` of the first body line (one past the heading's last line).
    body_start: usize,
    id: String,
    level: Level,
    assessment: Assessment,
}

/// Walks `body` and returns the position and metadata of every recommendation
/// heading. A heading starts on a line matching `<id> (L1|L2|BL) <title>` and
/// ends on the line containing the trailing `(Automated)` or `(Manual)` token,
/// which may be the same line or up to a few lines later when the title wraps.
fn locate_headings(body: &[&str]) -> Vec<Heading> {
    let mut headings = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if let Some((id, level)) = parse_heading_start(body[i]) {
            // Heading text wraps over up to a few lines, terminated by an
            // "(Automated)" or "(Manual)" suffix on the final line.
            let scan_end = body.len().min(i + 6);
            for scan_idx in i..scan_end {
                if let Some(assessment) = trailing_assessment(body[scan_idx]) {
                    headings.push(Heading {
                        start: i,
                        body_start: scan_idx + 1,
                        id,
                        level,
                        assessment,
                    });
                    i = scan_idx + 1;
                    break;
                }
            }
            // If we fell out without finding a terminator, fall through.
        }
        i += 1;
    }
    headings
}

fn parse_heading_start(line: &str) -> Option<(String, Level)> {
    let mut parts = line.splitn(3, ' ');
    let id = parts.next()?;
    let level_token = parts.next()?;
    parts.next()?; // there must be a title fragment after the level

    if !is_section_id(id) {
        return None;
    }
    let level = parse_level(level_token)?;
    Some((id.to_string(), level))
}

fn is_section_id(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn parse_level(token: &str) -> Option<Level> {
    match token {
        "(L1)" => Some(Level::L1),
        "(L2)" => Some(Level::L2),
        "(BL)" => Some(Level::BL),
        _ => None,
    }
}

fn trailing_assessment(line: &str) -> Option<Assessment> {
    let trimmed = line.trim_end();
    if trimmed.ends_with("(Automated)") {
        Some(Assessment::Automated)
    } else if trimmed.ends_with("(Manual)") {
        Some(Assessment::Manual)
    } else {
        None
    }
}

/// Reconstructs the rec title from one-or-more wrapped heading lines, dropping
/// the leading `<id> (L?)` tokens and the trailing `(Automated)` / `(Manual)`
/// terminator.
fn read_title(heading_lines: &[&str]) -> String {
    if heading_lines.is_empty() {
        return String::new();
    }
    let mut parts = heading_lines[0].splitn(3, ' ');
    parts.next(); // id
    parts.next(); // level
    let first_after_level = parts.next().unwrap_or("");

    let mut title = first_after_level.to_string();
    for &line in &heading_lines[1..] {
        title.push(' ');
        title.push_str(line.trim());
    }

    let trimmed = title.trim_end();
    let without_assessment = trimmed
        .strip_suffix("(Automated)")
        .or_else(|| trimmed.strip_suffix("(Manual)"))
        .unwrap_or(trimmed);
    // Collapse runs of whitespace introduced by mid-heading PDF wraps
    // (e.g. `is  set to` / `is set  to`) into single spaces.
    without_assessment
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Splits a single recommendation's body lines into the standard labeled
/// sections (Description, Rationale, Impact, Audit, …). Lines that fall under
/// `CIS Controls:` or any unrecognized label are discarded.
fn split_sections(body: &[&str]) -> BodySections {
    let mut sections = BodySections::default();
    let mut current_label: Option<&'static str> = None;
    let mut pending_lines: Vec<&str> = Vec::new();

    for line in body {
        if let Some(label) = section_label(line) {
            commit(current_label, &pending_lines, &mut sections);
            current_label = Some(label);
            pending_lines.clear();
        } else {
            pending_lines.push(line);
        }
    }
    commit(current_label, &pending_lines, &mut sections);
    sections
}

/// Writes the accumulated `lines` into the `BodySections` field for `label`.
/// Skips when `label` is `None` (no labeled section seen yet) or when the
/// content is empty after filtering blanks and page footers.
fn commit(label: Option<&'static str>, lines: &[&str], sections: &mut BodySections) {
    let Some(label) = label else { return };
    // Preserve each line's trailing whitespace — `classify::registry` uses it
    // to detect logical-space wraps. Filter out lines that are blank/whitespace-
    // only and page footers.
    let content = lines
        .iter()
        .copied()
        .filter(|line| !line.trim().is_empty() && !is_page_footer(line))
        .collect::<Vec<_>>()
        .join("\n");
    if content.is_empty() {
        return;
    }
    let slot = match label {
        "Profile Applicability" => &mut sections.profile_applicability,
        "Description" => &mut sections.description,
        "Rationale" => &mut sections.rationale,
        "Impact" => &mut sections.impact,
        "Audit" => &mut sections.audit,
        "Remediation" => &mut sections.remediation,
        "Default Value" => &mut sections.default_value,
        "References" => &mut sections.references,
        _ => return, // CIS Controls and any other label: discarded.
    };
    *slot = Some(content);
}

fn section_label(line: &str) -> Option<&'static str> {
    match line.trim() {
        "Profile Applicability:" => Some("Profile Applicability"),
        "Description:" => Some("Description"),
        "Rationale:" => Some("Rationale"),
        "Impact:" => Some("Impact"),
        "Audit:" => Some("Audit"),
        "Remediation:" => Some("Remediation"),
        "Default Value:" => Some("Default Value"),
        "References:" => Some("References"),
        "CIS Controls:" => Some("CIS Controls"),
        _ => None,
    }
}

fn is_page_footer(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("Page ")
        && trimmed.len() > 5
        && trimmed[5..].chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_id() {
        assert!(is_section_id("4.6.11.1"));
        assert!(is_section_id("1.1"));
        assert!(!is_section_id("4"));
        assert!(!is_section_id("4."));
        assert!(!is_section_id("4.x"));
        assert!(!is_section_id(""));
    }

    #[test]
    fn parses_level_tokens() {
        assert_eq!(parse_level("(L1)"), Some(Level::L1));
        assert_eq!(parse_level("(L2)"), Some(Level::L2));
        assert_eq!(parse_level("(BL)"), Some(Level::BL));
        assert_eq!(parse_level("(L3)"), None);
        assert_eq!(parse_level("L1"), None);
    }

    #[test]
    fn detects_assessment_terminator() {
        assert_eq!(
            trailing_assessment("foo (Automated)"),
            Some(Assessment::Automated)
        );
        assert_eq!(
            trailing_assessment("foo (Manual)  "),
            Some(Assessment::Manual)
        );
        assert_eq!(trailing_assessment("foo (something else)"), None);
    }

    #[test]
    fn page_footer_recognized() {
        assert!(is_page_footer("Page 35"));
        assert!(is_page_footer("  Page 1162  "));
        assert!(!is_page_footer("Page A"));
        assert!(!is_page_footer("Page "));
        assert!(!is_page_footer("Description:"));
    }

    #[test]
    #[ignore = "requires dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf on disk"]
    fn slices_real_pdf_into_457_recommendations() {
        let pdf = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
        let text = crate::parser::pdf::extract(&pdf).expect("PDF extraction");
        let recs = slice(&text).expect("slicing");

        assert_eq!(recs.len(), 457);

        let first = &recs[0];
        assert_eq!(first.id, "1.1");
        assert_eq!(first.level, Level::L1);
        assert_eq!(first.assessment, Assessment::Automated);
        assert!(first.title.contains("Cortana"), "title was {:?}", first.title);
        assert!(first.sections.description.is_some());
        assert!(first.sections.audit.is_some());
        assert!(first.sections.remediation.is_some());

        let last = recs.last().expect("at least one rec");
        assert_eq!(last.id, "105.6");
    }

    #[test]
    fn slices_a_minimal_recommendation() {
        let text = "\
Front matter to skip
Recommendations
1.1 (L1) Ensure 'Test' is set to 'Block'
(Automated)

Profile Applicability:

• Level 1 (L1)

Description:

A short description.

Audit:

HKLM\\SOFTWARE\\Foo:Bar

Remediation:

Set the thing.
";
        let recs = slice(text).expect("body should be found");
        assert_eq!(recs.len(), 1);
        let rec = &recs[0];
        assert_eq!(rec.id, "1.1");
        assert_eq!(rec.level, Level::L1);
        assert_eq!(rec.assessment, Assessment::Automated);
        assert_eq!(rec.title, "Ensure 'Test' is set to 'Block'");
        assert_eq!(
            rec.sections.description.as_deref(),
            Some("A short description.")
        );
        assert_eq!(
            rec.sections.audit.as_deref(),
            Some("HKLM\\SOFTWARE\\Foo:Bar")
        );
        assert_eq!(
            rec.sections.remediation.as_deref(),
            Some("Set the thing.")
        );
    }
}