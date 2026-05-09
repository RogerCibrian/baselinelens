//! Shared registry-path extraction with line-wrap dewrap.
//!
//! Walks an audit body and returns every `HKLM\` / `HKU\` path it can stitch
//! together. Both the Registry and PolicyManager variants use this; they then
//! interpret the resulting paths differently (scope detection vs. WinningProvider
//! lookup).

#[derive(Debug, Clone)]
pub(super) struct JoinedPath {
    /// The path component (everything before the last `:`).
    pub(super) path: String,
    /// The value name (everything after the last `:`).
    pub(super) value_name: String,
}

/// Walks `body` line-by-line and stitches wrapped registry paths back into
/// single logical entries. Mid-token wraps (`…HardenedPaths:\\*\NE` +
/// `TLOGON`) join with no separator; logical-space wraps (`HKU\[USER ` +
/// `SID]\…`) join with a single space — disambiguated by whether the
/// previous line had any trailing whitespace.
pub(super) fn extract_all(body: &str) -> Vec<JoinedPath> {
    let lines: Vec<&str> = body.lines().collect();
    let mut paths = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let line = raw.trim_end();
        if !starts_with_hive(line) {
            i += 1;
            continue;
        }

        let mut joined = String::from(line.trim_start());
        let mut prev_had_trailing_space = had_trailing_whitespace(raw);
        i += 1;
        while i < lines.len() {
            let next_raw = lines[i];
            let next = next_raw.trim_end();
            let next_content = next.trim_start();
            // Continuations are short tokens (`TLOGON`, `oveLock_WinningProvider`,
            // `SID]\...`) or path fragments with at most one literal space
            // inside a placeholder (`eClasses:<numeric value>`). Anything with
            // multiple whitespace runs is narrative text and must not be glued
            // onto the registry path.
            let whitespace_count = next_content
                .chars()
                .filter(|c| c.is_whitespace())
                .count();
            if next_content.is_empty()
                || starts_with_hive(next_content)
                || whitespace_count > 1
            {
                break;
            }
            if prev_had_trailing_space {
                joined.push(' ');
            }
            joined.push_str(next_content);
            prev_had_trailing_space = had_trailing_whitespace(next_raw);
            i += 1;
        }

        if let Some(colon_idx) = joined.rfind(':') {
            let (path_part, rest) = joined.split_at(colon_idx);
            let value_name = rest[1..].trim().to_string();
            let path = path_part.trim().to_string();
            if !path.is_empty() && !value_name.is_empty() {
                paths.push(JoinedPath { path, value_name });
            }
        }
    }
    paths
}

fn starts_with_hive(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("HKLM\\") || trimmed.starts_with("HKU\\")
}

fn had_trailing_whitespace(raw: &str) -> bool {
    raw.len() != raw.trim_end().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_single_path() {
        let body = "HKLM\\SOFTWARE\\Foo\\Bar:Baz\n";
        let paths = extract_all(body);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, "HKLM\\SOFTWARE\\Foo\\Bar");
        assert_eq!(paths[0].value_name, "Baz");
    }

    #[test]
    fn extracts_two_consecutive_keys() {
        let body = "\
HKLM\\SOFTWARE\\A:One
HKLM\\SOFTWARE\\B:Two
";
        let paths = extract_all(body);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value_name, "One");
        assert_eq!(paths[1].value_name, "Two");
    }

    #[test]
    fn dewraps_mid_token_continuation() {
        // Mimics 4.6.11.1: ":\\*\\NE" wrapped to "TLOGON" with no trailing space.
        let body = "\
HKLM\\SOFTWARE\\Policies\\Foo\\HardenedPaths:\\\\*\\NE
TLOGON
HKLM\\SOFTWARE\\Policies\\Foo\\HardenedPaths:\\\\*\\SY
SVOL
";
        let paths = extract_all(body);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value_name, "\\\\*\\NETLOGON");
        assert_eq!(paths[1].value_name, "\\\\*\\SYSVOL");
    }

    #[test]
    fn dewraps_logical_space_wrap() {
        // Mimics 4.11.5.2: "HKU\[USER " (trailing space) wrapped to "SID]\..."
        let body = "HKU\\[USER \nSID]\\Software\\Foo:Bar\n";
        let paths = extract_all(body);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, "HKU\\[USER SID]\\Software\\Foo");
        assert_eq!(paths[0].value_name, "Bar");
    }

    #[test]
    fn does_not_glue_narrative_text_after_path() {
        // Mimics PolicyManager: narrative text between two HKLM paths must not be
        // gobbled into the first path's continuation.
        let body = "\
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\AboveLock:AllowCortanaAb
oveLock_WinningProvider
2.  Navigate to the following registry location and confirm the value is set to 0.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\Providers\\{GUID}\\Default\\Device\\AboveLock:AllowCortanaAboveLock
";
        let paths = extract_all(body);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value_name, "AllowCortanaAboveLock_WinningProvider");
        assert_eq!(paths[1].value_name, "AllowCortanaAboveLock");
    }
}
