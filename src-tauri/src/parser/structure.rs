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
    pub(crate) id: String,
    pub(crate) level: Level,
    pub(crate) bitlocker: bool,
    pub(crate) assessment: Assessment,
    pub(crate) title: String,
    pub(crate) sections: BodySections,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BodySections {
    pub(crate) profile_applicability: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) rationale: Option<String>,
    pub(crate) impact: Option<String>,
    pub(crate) audit: Option<String>,
    pub(crate) remediation: Option<String>,
    pub(crate) default_value: Option<String>,
    pub(crate) references: Option<String>,
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
    for (i, heading) in headings.iter().enumerate() {
        let body_end = headings
            .get(i + 1)
            .map(|next| next.start)
            .unwrap_or(body.len());

        let title = read_title(&body[heading.start..heading.body_start]);
        let sections = split_sections(&body[heading.body_start..body_end]);

        recs.push(RawRecommendation {
            id: heading.id.clone(),
            level: heading.level,
            bitlocker: heading.bitlocker,
            assessment: heading.assessment,
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
    bitlocker: bool,
    assessment: Assessment,
}

/// Walks `body` and returns the position and metadata of every recommendation
/// heading. A heading starts on a line whose first token is a dotted-numeric
/// id, carries an `(Automated)`/`(Manual)` terminator on the id line or a
/// contiguous wrap line, and is followed by a Profile Applicability section
/// with a resolvable level.
fn locate_headings(body: &[&str]) -> Vec<Heading> {
    let mut headings = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if let Some(id) = parse_heading_start(body[i]) {
            // The title may wrap over contiguous lines, terminated by an
            // `(Automated)`/`(Manual)` suffix. The scan stops at the first
            // blank line, bounding the terminator search to the heading.
            let scan_end = body.len().min(i + 6);
            let mut found = None;
            for (offset, &line) in body[i..scan_end].iter().enumerate() {
                if line.trim().is_empty() {
                    break;
                }
                if let Some(assessment) = trailing_assessment(line) {
                    found = Some((i + offset, assessment));
                    break;
                }
            }
            // A heading is confirmed by a following Profile Applicability
            // section with a resolvable level.
            if let Some((scan_idx, assessment)) = found
                && let Some((level, bitlocker)) = read_profile(body, scan_idx)
            {
                headings.push(Heading {
                    start: i,
                    body_start: scan_idx + 1,
                    id,
                    level,
                    bitlocker,
                    assessment,
                });
                i = scan_idx + 1;
            }
        }
        i += 1;
    }
    headings
}

/// Detects the start of a recommendation heading: a line whose first
/// space-delimited token is a dotted-numeric section id followed by at
/// least one more token. The level is read from the Profile Applicability
/// section.
fn parse_heading_start(line: &str) -> Option<String> {
    let mut parts = line.split(' ').filter(|part| !part.is_empty());
    let id = parts.next()?;
    parts.next()?; // a token must follow the id
    if !is_section_id(id) {
        return None;
    }
    Some(id.to_string())
}

/// Reads the recommendation's level and BitLocker tag from the Profile
/// Applicability section that follows the heading terminator at
/// `terminator_idx`. The level is the lowest base tier present across the
/// bullets (`L1 < L2`), ignoring any `+ BitLocker` suffix; a block whose
/// only tier is BitLocker resolves to `Level::BL`. `bitlocker` is true
/// when any bullet carries a `(BL)` token.
///
/// Returns `None` when no Profile Applicability section follows or no
/// tier token is present, which the caller treats as a non-heading.
fn read_profile(body: &[&str], terminator_idx: usize) -> Option<(Level, bool)> {
    let scan_end = body.len().min(terminator_idx + 1 + 6);
    let label_idx =
        (terminator_idx + 1..scan_end).find(|&j| body[j].trim() == "Profile Applicability:")?;

    let mut has_l1 = false;
    let mut has_l2 = false;
    let mut has_bl = false;
    for &line in body[label_idx + 1..].iter() {
        if section_label(line).is_some() {
            break;
        }
        if line.contains("(L1)") {
            has_l1 = true;
        }
        if line.contains("(L2)") {
            has_l2 = true;
        }
        if line.contains("(BL)") {
            has_bl = true;
        }
    }

    let level = if has_l1 {
        Level::L1
    } else if has_l2 {
        Level::L2
    } else if has_bl {
        Level::BL
    } else {
        return None;
    };
    Some((level, has_bl))
}

/// True when every `.`-separated segment of `text` is a non-empty run
/// of ASCII digits (e.g. `1`, `2.3`, `18.9.4.1`). Shared by the
/// heading detector here and the category-heading parser so the
/// dotted-id grammar is defined once.
pub(super) fn is_dotted_numeric(text: &str) -> bool {
    !text.is_empty()
        && text
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// A section id is a dotted-numeric token with at least two segments
/// (a bare `4` is a chapter number, not a recommendation id).
fn is_section_id(text: &str) -> bool {
    text.contains('.') && is_dotted_numeric(text)
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

/// Reconstructs the rec title from one-or-more wrapped heading lines,
/// dropping the leading id, an optional `(L?)` level token, and the
/// trailing `(Automated)` / `(Manual)` terminator.
fn read_title(heading_lines: &[&str]) -> String {
    if heading_lines.is_empty() {
        return String::new();
    }
    let after_id = heading_lines[0]
        .split_once(' ')
        .map(|(_, rest)| rest.trim_start())
        .unwrap_or("");
    let title_start = match after_id.split_once(' ') {
        Some((maybe_level, rest)) if parse_level(maybe_level).is_some() => rest,
        _ => after_id,
    };

    let mut title = title_start.to_string();
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
        assert!(
            first.title.contains("Cortana"),
            "title was {:?}",
            first.title
        );
        assert!(first.sections.description.is_some());
        assert!(first.sections.audit.is_some());
        assert!(first.sections.remediation.is_some());

        let last = recs.last().expect("at least one rec");
        assert_eq!(last.id, "105.6");
    }

    #[test]
    #[ignore = "diagnostic — inspects why slicing produces few/zero recs; \
                drive with BASELINELENS_TEST_PDF"]
    fn inspect_slicing() {
        let pdf = std::env::var("BASELINELENS_TEST_PDF").expect("set BASELINELENS_TEST_PDF");
        let text = crate::parser::pdf::extract(std::path::Path::new(&pdf)).expect("PDF extraction");
        let lines: Vec<&str> = text.lines().collect();

        let anchor = lines.iter().position(|l| l.trim() == "Recommendations");
        eprintln!("total lines: {}", lines.len());
        eprintln!("exact 'Recommendations' anchor at: {anchor:?}");

        eprintln!("\n-- lines containing 'Recommendation' (first 12) --");
        for (idx, line) in lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.contains("Recommendation"))
            .take(12)
        {
            eprintln!("  [{idx}] {line:?}");
        }

        let body_start = anchor.map(|a| a + 1).unwrap_or(0);
        let body = &lines[body_start..];
        let headings = locate_headings(body);
        eprintln!("\nheadings located: {}", headings.len());
        for h in headings.iter().take(5) {
            eprintln!("  id={} level={:?} at body[{}]", h.id, h.level, h.start);
        }

        eprintln!("\n-- lines with '(Automated)'/'(Manual)' terminator (first 10) --");
        for (idx, line) in lines
            .iter()
            .enumerate()
            .filter(|(_, l)| trailing_assessment(l).is_some())
            .take(10)
        {
            eprintln!("  [{idx}] {line:?}");
        }

        eprintln!("\n-- lines with a '(L1)'/'(L2)'/'(BL)' token (first 10) --");
        for (idx, line) in lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.contains("(L1)") || l.contains("(L2)") || l.contains("(BL)"))
            .take(10)
        {
            eprintln!("  [{idx}] {line:?}");
        }

        eprintln!("\n-- first 60 body lines after anchor --");
        for (offset, line) in body.iter().take(60).enumerate() {
            eprintln!("  b[{offset}] {line:?}");
        }
    }

    #[test]
    #[ignore = "diagnostic — counts Profile Applicability coverage vs rec headings; \
                drive with BASELINELENS_TEST_PDF"]
    fn inspect_profile_applicability_coverage() {
        let pdf = std::env::var("BASELINELENS_TEST_PDF").expect("set BASELINELENS_TEST_PDF");
        let text = crate::parser::pdf::extract(std::path::Path::new(&pdf)).expect("PDF extraction");
        let lines: Vec<&str> = text.lines().collect();

        let anchor = lines
            .iter()
            .position(|l| l.trim() == "Recommendations")
            .map(|a| a + 1)
            .unwrap_or(0);
        let body = &lines[anchor..];

        let profile_markers = body
            .iter()
            .filter(|l| l.trim() == "Profile Applicability:")
            .count();

        // Heading-like lines: start with a dotted-numeric id and carry an
        // (Automated)/(Manual) terminator within 6 lines (title may wrap).
        let mut heading_like = 0usize;
        let mut level_in_heading = 0usize;
        let mut i = 0;
        while i < body.len() {
            let first = body[i].split(' ').next().unwrap_or("");
            if is_section_id(first) {
                let scan_end = body.len().min(i + 6);
                if body[i..scan_end]
                    .iter()
                    .any(|l| trailing_assessment(l).is_some())
                {
                    heading_like += 1;
                    let second = body[i].split(' ').nth(1).unwrap_or("");
                    if parse_level(second).is_some() {
                        level_in_heading += 1;
                    }
                }
            }
            i += 1;
        }

        // Of the Profile Applicability sections, how many have a parseable
        // level bullet in the following few lines?
        let mut profile_with_level = 0usize;
        for (idx, _) in body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == "Profile Applicability:")
        {
            let scan_end = body.len().min(idx + 8);
            if body[idx + 1..scan_end].iter().any(|l| {
                let t = l.trim();
                t.contains("(L1)") || t.contains("(L2)") || t.contains("(BL)")
            }) {
                profile_with_level += 1;
            }
        }

        eprintln!(
            "{} :: profile_markers={profile_markers} \
             heading_like={heading_like} \
             level_in_heading={level_in_heading} \
             profile_with_parseable_level={profile_with_level}",
            std::path::Path::new(&pdf)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
        );
    }

    #[test]
    #[ignore = "diagnostic — dumps recs whose Profile Applicability has 2+ level \
                bullets; drive with BASELINELENS_TEST_PDF"]
    fn inspect_multi_profile_recs() {
        let pdf = std::env::var("BASELINELENS_TEST_PDF").expect("set BASELINELENS_TEST_PDF");
        let text = crate::parser::pdf::extract(std::path::Path::new(&pdf)).expect("PDF extraction");
        let lines: Vec<&str> = text.lines().collect();

        let anchor = lines
            .iter()
            .position(|l| l.trim() == "Recommendations")
            .map(|a| a + 1)
            .unwrap_or(0);
        let body = &lines[anchor..];

        let mut shown = 0usize;
        for (idx, _) in body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == "Profile Applicability:")
        {
            // Collect bullet/level lines until the next section label.
            let mut block: Vec<&str> = Vec::new();
            for &line in body[idx + 1..].iter() {
                if section_label(line).is_some() {
                    break;
                }
                if !line.trim().is_empty() {
                    block.push(line.trim());
                }
                if block.len() > 12 {
                    break;
                }
            }
            let level_bullets = block
                .iter()
                .filter(|l| l.contains("(L1)") || l.contains("(L2)") || l.contains("(BL)"))
                .count();
            if level_bullets < 2 {
                continue;
            }

            // Nearest preceding heading-ish line for context.
            let heading = body[..idx]
                .iter()
                .rev()
                .take(8)
                .find(|l| is_section_id(l.split(' ').next().unwrap_or("")))
                .copied()
                .unwrap_or("<heading not found within 8 lines>");

            let all_have_bl = block
                .iter()
                .filter(|l| l.contains("(L1)") || l.contains("(L2)") || l.contains("(BL)"))
                .all(|l| l.contains("(BL)"));
            if all_have_bl {
                continue; // BitLocker add-on shape.
            }

            eprintln!("\n=== NON-BL MULTI-PROFILE: {} ===", heading.trim());
            for l in &block {
                eprintln!("   {l}");
            }
            shown += 1;
            if shown >= 15 {
                break;
            }
        }
        eprintln!("\n(non-BL multi-profile recs shown: {shown})");
    }

    #[test]
    #[ignore = "diagnostic — counts NG in Profile Applicability; \
                drive with BASELINELENS_TEST_PDF"]
    fn inspect_ng_presence() {
        let pdf = std::env::var("BASELINELENS_TEST_PDF").expect("set BASELINELENS_TEST_PDF");
        let text = crate::parser::pdf::extract(std::path::Path::new(&pdf)).expect("PDF extraction");
        let lines: Vec<&str> = text.lines().collect();
        let anchor = lines
            .iter()
            .position(|l| l.trim() == "Recommendations")
            .map(|a| a + 1)
            .unwrap_or(0);
        let body = &lines[anchor..];

        let mut ng_blocks = 0usize;
        let mut ng_only = 0usize; // every level bullet carries (NG)
        let mut samples: Vec<String> = Vec::new();
        for (idx, _) in body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == "Profile Applicability:")
        {
            let mut block: Vec<&str> = Vec::new();
            for &line in body[idx + 1..].iter() {
                if section_label(line).is_some() {
                    break;
                }
                if !line.trim().is_empty() {
                    block.push(line.trim());
                }
                if block.len() > 12 {
                    break;
                }
            }
            let level_bullets: Vec<&&str> = block
                .iter()
                .filter(|l| {
                    l.contains("(L1)")
                        || l.contains("(L2)")
                        || l.contains("(BL)")
                        || l.contains("(NG)")
                })
                .collect();
            if level_bullets.is_empty() {
                continue;
            }
            if level_bullets.iter().any(|l| l.contains("(NG)")) {
                ng_blocks += 1;
                if level_bullets.iter().all(|l| l.contains("(NG)")) {
                    ng_only += 1;
                }
                if samples.len() < 4 {
                    let heading = body[..idx]
                        .iter()
                        .rev()
                        .take(8)
                        .find(|l| is_section_id(l.split(' ').next().unwrap_or("")))
                        .copied()
                        .unwrap_or("<heading?>");
                    samples.push(format!("{}\n   {}", heading.trim(), block.join("\n   ")));
                }
            }
        }
        eprintln!(
            "{} :: profile_blocks_with_NG={ng_blocks} (all-bullets-NG={ng_only})",
            std::path::Path::new(&pdf)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
        );
        for s in &samples {
            eprintln!("--- {s}");
        }
    }

    #[test]
    #[ignore = "diagnostic — tallies Profile Applicability shape distribution; \
                drive with BASELINELENS_TEST_PDF"]
    fn inspect_profile_shape_distribution() {
        let pdf = std::env::var("BASELINELENS_TEST_PDF").expect("set BASELINELENS_TEST_PDF");
        let text = crate::parser::pdf::extract(std::path::Path::new(&pdf)).expect("PDF extraction");
        let lines: Vec<&str> = text.lines().collect();
        let anchor = lines
            .iter()
            .position(|l| l.trim() == "Recommendations")
            .map(|a| a + 1)
            .unwrap_or(0);
        let body = &lines[anchor..];

        let mut l1_only = 0usize;
        let mut l2_only = 0usize;
        let mut l1_and_l2_no_bl = 0usize;
        let mut bl_with_l1 = 0usize;
        let mut bl_with_l2_no_l1 = 0usize;
        let mut bl_standalone_only = 0usize; // BL present, NO L1 and NO L2 anywhere
        let mut ng_any = 0usize;
        let mut other = 0usize;
        let mut bl_standalone_samples: Vec<String> = Vec::new();

        for (idx, _) in body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == "Profile Applicability:")
        {
            let mut block: Vec<&str> = Vec::new();
            for &line in body[idx + 1..].iter() {
                if section_label(line).is_some() {
                    break;
                }
                if !line.trim().is_empty() {
                    block.push(line.trim());
                }
                if block.len() > 12 {
                    break;
                }
            }
            let joined = block.join(" ");
            let has_l1 = joined.contains("(L1)");
            let has_l2 = joined.contains("(L2)");
            let has_bl = joined.contains("(BL)");
            let has_ng = joined.contains("(NG)");
            if !has_l1 && !has_l2 && !has_bl && !has_ng {
                continue; // not a rec profile block
            }

            if has_ng {
                ng_any += 1;
            } else if has_bl && !has_l1 && !has_l2 {
                bl_standalone_only += 1;
                if bl_standalone_samples.len() < 6 {
                    let heading = body[..idx]
                        .iter()
                        .rev()
                        .take(8)
                        .find(|l| is_section_id(l.split(' ').next().unwrap_or("")))
                        .copied()
                        .unwrap_or("<heading?>");
                    bl_standalone_samples.push(format!("{}  ::  {}", heading.trim(), joined));
                }
            } else if has_bl && has_l1 {
                bl_with_l1 += 1;
            } else if has_bl && has_l2 {
                bl_with_l2_no_l1 += 1;
            } else if has_l1 && has_l2 {
                l1_and_l2_no_bl += 1;
            } else if has_l1 {
                l1_only += 1;
            } else if has_l2 {
                l2_only += 1;
            } else {
                other += 1;
            }
        }

        let name = std::path::Path::new(&pdf)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?");
        eprintln!(
            "===== {name}\n  L1_only={l1_only} L2_only={l2_only} \
             L1&L2_noBL={l1_and_l2_no_bl}\n  \
             BL+L1={bl_with_l1} BL+L2_noL1={bl_with_l2_no_l1} \
             BL_standalone_only={bl_standalone_only}\n  \
             NG_any={ng_any} other={other}"
        );
        for s in &bl_standalone_samples {
            eprintln!("  [BL-standalone] {s}");
        }
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
        assert!(!rec.bitlocker);
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
        assert_eq!(rec.sections.remediation.as_deref(), Some("Set the thing."));
    }

    #[test]
    fn slices_v5_style_heading_without_inline_level() {
        // No inline level token; level lives in Profile Applicability;
        // title wraps across two lines.
        let text = "\
Recommendations
1.1.1 Ensure 'Enforce password history' is set to '24 or more
password(s)' (Automated)

Profile Applicability:

\u{2022}  Level 1 (L1)

Description:

A short description.

Audit:

HKLM\\SOFTWARE\\Foo:Bar
";
        let recs = slice(text).expect("body should be found");
        assert_eq!(recs.len(), 1);
        let rec = &recs[0];
        assert_eq!(rec.id, "1.1.1");
        assert_eq!(rec.level, Level::L1);
        assert!(!rec.bitlocker);
        assert_eq!(rec.assessment, Assessment::Automated);
        assert_eq!(
            rec.title,
            "Ensure 'Enforce password history' is set to '24 or more password(s)'"
        );
    }

    #[test]
    fn multi_bullet_bitlocker_resolves_to_l1_tagged() {
        // BitLocker add-on shape: base level L1, tagged BitLocker.
        let text = "\
Recommendations
18.9.7.1.1 Ensure 'Prevent installation of devices' is set to 'Enabled'
(Automated)

Profile Applicability:

\u{2022}  Level 1 (L1) + BitLocker (BL)
\u{2022}  Level 2 (L2) + BitLocker (BL)
\u{2022}  BitLocker (BL)

Description:

A short description.
";
        let recs = slice(text).expect("body should be found");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].level, Level::L1);
        assert!(recs[0].bitlocker);
    }

    #[test]
    fn intune_standalone_bitlocker_resolves_to_bl_level() {
        let text = "\
Recommendations
4.10.9.1.1 (BL) Ensure 'Prevent installation of devices' is set to 'Enabled'
(Automated)

Profile Applicability:

\u{2022}  BitLocker (BL)

Description:

A short description.
";
        let recs = slice(text).expect("body should be found");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].level, Level::BL);
        assert!(recs[0].bitlocker);
        assert_eq!(
            recs[0].title,
            "Ensure 'Prevent installation of devices' is set to 'Enabled'"
        );
    }

    #[test]
    fn rejects_section_subheader_keeps_only_real_rec() {
        // "1.1 Password Policy" is a section sub-header (numeric-dotted id,
        // but no terminator and no Profile Applicability). Only the real
        // rec that follows must be sliced.
        let text = "\
Recommendations
1 Account Policies

This section contains recommendations for account policies.

1.1 Password Policy

This section contains recommendations for password policy.

1.1.1 Ensure 'Enforce password history' is set to '24 or more
password(s)' (Automated)

Profile Applicability:

\u{2022}  Level 1 (L1)

Description:

A short description.
";
        let recs = slice(text).expect("body should be found");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].id, "1.1.1");
    }
}
