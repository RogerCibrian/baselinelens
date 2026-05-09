//! Extracts category section names from the PDF body and assembles them
//! into hierarchical full paths.

use std::collections::{HashMap, HashSet};

/// Returns the local name for each entry in `valid_numbers` whose heading
/// appears in `text`.
///
/// Skips everything before the standalone `Recommendations` chapter
/// heading so the table of contents (with its leader dots and page
/// numbers) doesn't get captured as the name. Within the body, the first
/// matching occurrence wins so later prose references like "see section
/// 4.6.11..." don't overwrite the real heading.
pub(crate) fn extract_local_names(
    text: &str,
    valid_numbers: &HashSet<String>,
) -> HashMap<String, String> {
    let mut in_body = false;
    let mut names: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        if !in_body {
            if line.trim() == "Recommendations" {
                in_body = true;
            }
            continue;
        }
        if let Some((number, name)) = parse_heading(line)
            && valid_numbers.contains(&number)
        {
            names.entry(number).or_insert(name);
        }
    }
    names
}

/// Joins `number`'s ancestor names into a " - "-separated path. Levels
/// without a known local name are skipped — the path stays useful even
/// when the parser only found names for some ancestors.
pub(crate) fn build_full_path(
    number: &str,
    local_names: &HashMap<String, String>,
) -> String {
    let parts: Vec<&str> = number.split('.').collect();
    let mut segments: Vec<String> = Vec::new();
    for cutoff in 1..=parts.len() {
        let prefix = parts[..cutoff].join(".");
        if let Some(local) = local_names.get(&prefix) {
            segments.push(local.clone());
        }
    }
    segments.join(" - ")
}

fn parse_heading(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let (number, rest) = trimmed.split_once(' ')?;
    if number.is_empty() {
        return None;
    }
    let parts: Vec<&str> = number.split('.').collect();
    if !parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let after = rest.trim_start();
    if after.starts_with("(L1)") || after.starts_with("(L2)") || after.starts_with("(BL)") {
        return None;
    }
    let name = after.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((number.to_string(), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_set(numbers: &[&str]) -> HashSet<String> {
        numbers.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn extracts_top_level_and_nested_names() {
        let text = "\
Recommendations

1 Synthetic Top

This section contains recommendations for the synthetic top.

4 Synthetic Mid

4.1 Synthetic Sub

4.1.3 Synthetic Leaf
";
        let valid = valid_set(&["1", "4", "4.1", "4.1.3"]);
        let names = extract_local_names(text, &valid);
        assert_eq!(names.get("1"), Some(&"Synthetic Top".to_string()));
        assert_eq!(names.get("4"), Some(&"Synthetic Mid".to_string()));
        assert_eq!(names.get("4.1"), Some(&"Synthetic Sub".to_string()));
        assert_eq!(names.get("4.1.3"), Some(&"Synthetic Leaf".to_string()));
    }

    #[test]
    fn rejects_rec_headings_with_level_marker() {
        let text = "\
Recommendations

1.1 (L1) Ensure 'Foo' is set to 'Block'
1.1 Real Section Heading
";
        let valid = valid_set(&["1.1"]);
        let names = extract_local_names(text, &valid);
        assert_eq!(names.get("1.1"), Some(&"Real Section Heading".to_string()));
    }

    #[test]
    fn ignores_numbers_not_in_valid_set() {
        let text = "\
Recommendations

2012 R2; some unrelated body prose with a leading year.
1.  Step one of remediation
";
        let valid = valid_set(&["1", "2"]);
        let names = extract_local_names(text, &valid);
        assert!(names.is_empty());
    }

    #[test]
    fn first_occurrence_wins() {
        let text = "\
Recommendations

4.6.11 First Heading

later body prose mentioning 4.6.11 Different Name
";
        let valid = valid_set(&["4.6.11"]);
        let names = extract_local_names(text, &valid);
        assert_eq!(names.get("4.6.11"), Some(&"First Heading".to_string()));
    }

    #[test]
    fn rejects_trailing_dot_in_numbered_list() {
        // "1." is a numbered-list marker, not a category number.
        let text = "Recommendations\n1. Step one of remediation\n";
        let valid = valid_set(&["1"]);
        let names = extract_local_names(text, &valid);
        assert!(names.is_empty());
    }

    #[test]
    fn skips_table_of_contents_with_leader_dots() {
        // Lines before the "Recommendations" chapter heading look like
        // TOC entries with dot leaders and page numbers. The body
        // heading after the chapter should be the one captured.
        let text = "\
1 Synthetic Top ............................................. 34
4.1.3 Synthetic Leaf ........................................ 37

Recommendations

1 Synthetic Top

4.1.3 Synthetic Leaf
";
        let valid = valid_set(&["1", "4.1.3"]);
        let names = extract_local_names(text, &valid);
        assert_eq!(names.get("1"), Some(&"Synthetic Top".to_string()));
        assert_eq!(names.get("4.1.3"), Some(&"Synthetic Leaf".to_string()));
    }

    #[test]
    fn returns_empty_when_recommendations_marker_missing() {
        let text = "1 Synthetic Top\n4.1.3 Synthetic Leaf\n";
        let valid = valid_set(&["1", "4.1.3"]);
        let names = extract_local_names(text, &valid);
        assert!(names.is_empty());
    }

    #[test]
    fn build_full_path_walks_parent_chain() {
        let mut local: HashMap<String, String> = HashMap::new();
        local.insert("4".into(), "Synthetic Mid".into());
        local.insert("4.1".into(), "Synthetic Sub".into());
        local.insert("4.1.3".into(), "Synthetic Leaf".into());

        assert_eq!(
            build_full_path("4.1.3", &local),
            "Synthetic Mid - Synthetic Sub - Synthetic Leaf"
        );
        assert_eq!(build_full_path("4", &local), "Synthetic Mid");
        assert_eq!(
            build_full_path("4.1", &local),
            "Synthetic Mid - Synthetic Sub"
        );
    }

    #[test]
    fn build_full_path_skips_missing_intermediate_names() {
        let mut local: HashMap<String, String> = HashMap::new();
        local.insert("4".into(), "Synthetic Mid".into());
        local.insert("4.1.3".into(), "Synthetic Leaf".into());

        assert_eq!(
            build_full_path("4.1.3", &local),
            "Synthetic Mid - Synthetic Leaf"
        );
    }

    #[test]
    fn build_full_path_returns_empty_when_nothing_known() {
        let local: HashMap<String, String> = HashMap::new();
        assert_eq!(build_full_path("4.1.3", &local), "");
    }
}
