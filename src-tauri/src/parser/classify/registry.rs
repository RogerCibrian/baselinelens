//! Registry variant: extracts one or more registry checks and their shared
//! expected value from an audit body.

use crate::parser::model::{
    AuditProcedure, ExpectedValue, RegistryCheck, RegistryScope, Value,
};

/// Returns a `Registry` `AuditProcedure` if `body` matches a recognized
/// shape; returns `None` so the dispatcher falls back to `Manual` for
/// anything the parser can't make sense of (currently: per-key differing
/// values).
pub(super) fn try_parse(body: &str) -> Option<AuditProcedure> {
    let paths = extract_paths(body);
    if paths.is_empty() {
        return None;
    }
    let expected = parse_expected(body)?;
    let checks = paths
        .into_iter()
        .map(
            |ExtractedPath {
                 scope,
                 path,
                 value_name,
             }| RegistryCheck {
                path,
                value_name,
                expected: expected.clone(),
                scope,
            },
        )
        .collect();
    Some(AuditProcedure::Registry { checks })
}

struct ExtractedPath {
    scope: RegistryScope,
    path: String,
    value_name: String,
}

/// Walks `body` line-by-line and stitches wrapped registry paths back into
/// single logical entries. Mid-token wraps (`…HardenedPaths:\\*\NE` +
/// `TLOGON`) join with no separator; logical-space wraps (`HKU\[USER ` +
/// `SID]\…`) join with a single space — disambiguated by whether the
/// previous line had any trailing whitespace.
fn extract_paths(body: &str) -> Vec<ExtractedPath> {
    let lines: Vec<&str> = body.lines().collect();
    let mut paths = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let line = raw.trim_end();
        let Some(scope) = scope_prefix(line) else {
            i += 1;
            continue;
        };

        // Accumulate continuation lines for wrapped registry paths.
        // Trailing whitespace on the previous line tells us whether the
        // wrap broke at a real space (preserve it) or mid-token (no space).
        let mut joined = String::from(line.trim_start());
        let mut prev_had_trailing_space = had_trailing_whitespace(raw);
        i += 1;
        while i < lines.len() {
            let next_raw = lines[i];
            let next = next_raw.trim_end();
            if next.trim().is_empty() || scope_prefix(next).is_some() {
                break;
            }
            if prev_had_trailing_space {
                joined.push(' ');
            }
            joined.push_str(next.trim_start());
            prev_had_trailing_space = had_trailing_whitespace(next_raw);
            i += 1;
        }

        if let Some(colon_idx) = joined.rfind(':') {
            let (path_part, rest) = joined.split_at(colon_idx);
            let value_name = rest[1..].trim().to_string();
            let path = path_part.trim().to_string();
            if !path.is_empty() && !value_name.is_empty() {
                paths.push(ExtractedPath {
                    scope,
                    path,
                    value_name,
                });
            }
        }
    }
    paths
}

fn had_trailing_whitespace(raw: &str) -> bool {
    raw.len() != raw.trim_end().len()
}

fn scope_prefix(line: &str) -> Option<RegistryScope> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("HKLM\\") {
        // HKLM = HKEY_LOCAL_MACHINE: settings apply machine-wide.
        Some(RegistryScope::Machine)
    } else if trimmed.starts_with("HKU\\") {
        // HKU = HKEY_USERS: scoped to a specific SID. The CIS PDF writes
        // these as `HKU\[USER SID]\...`, meaning "the currently-logged-in
        // user." Other Windows hives (HKCU, HKCR, HKCC) don't appear in
        // this benchmark.
        Some(RegistryScope::CurrentUser)
    } else {
        None
    }
}

/// Extracts the expected registry value from the audit prose. Patterns are
/// tried in priority order: `Absent` → `AbsentOr(Equals(Dword))` → `REG_SZ`
/// (GUID-list as `ContainsAll`, otherwise `Equals(Str)`) → `REG_DWORD`
/// constraint (delegated to `parse_dword_constraint`). Returns `None` if no
/// pattern matches.
fn parse_expected(body: &str) -> Option<ExpectedValue> {
    let normalized = normalize_whitespace(body);

    if normalized.contains("registry location with the key not existing") {
        return Some(ExpectedValue::Absent);
    }
    if normalized.contains("registry value does not exist")
        && !normalized.contains("or when it exists")
    {
        return Some(ExpectedValue::Absent);
    }

    if let Some(after) =
        find_after(&normalized, "does not exist, or when it exists with a value of ")
    {
        if let Some(value) = parse_dword(after) {
            return Some(ExpectedValue::AbsentOr {
                inner: Box::new(ExpectedValue::Equals { value }),
            });
        }
    }

    if let Some(after) = find_after(&normalized, "REG_SZ value of ") {
        let snippet = capture_until_period(after).trim();
        if !snippet.is_empty() && !contains_per_key_split(snippet) {
            if let Some(guids) = parse_guid_list(snippet) {
                return Some(ExpectedValue::ContainsAll { substrings: guids });
            }
            return Some(ExpectedValue::Equals {
                value: Value::Str {
                    value: snippet.to_string(),
                },
            });
        }
    }

    if let Some(after) = find_after(&normalized, "REG_DWORD value of ") {
        let snippet = capture_until_period(after);
        if contains_per_key_split(snippet) {
            return None;
        }
        return parse_dword_constraint(snippet);
    }

    None
}

/// Parses the snippet that follows `REG_DWORD value of ` in the audit prose.
/// Recognized shapes (in priority order):
/// - `N or less but not M` (with optional comma) → `All([AtMost(N), NotEquals(M)])`
/// - `N or higher` → `AtLeast(N)`
/// - `N or less` → `AtMost(N)`
/// - `N or M [or …]` → `OneOf([Dword(N), Dword(M), …])`
/// - `N` → `Equals(Dword(N))`
fn parse_dword_constraint(snippet: &str) -> Option<ExpectedValue> {
    let stripped = strip_parentheticals(snippet);
    let cleaned = stripped.trim();

    // "N or less but not M" / "N or less, but not M" → All([AtMost(N), NotEquals(M)])
    // The trailing space is omitted in the no-comma form so that the PDF
    // extraction quirk "but not0" still matches; parse_dword handles the
    // leading whitespace on the excluded part.
    let all_split = cleaned
        .split_once(" or less but not")
        .or_else(|| cleaned.split_once(" or less, but not"));
    if let Some((upper_part, excluded_part)) = all_split {
        let upper_bound = parse_int(upper_part)?;
        let excluded = parse_dword(excluded_part)?;
        return Some(ExpectedValue::All {
            values: vec![
                ExpectedValue::AtMost { value: upper_bound },
                ExpectedValue::NotEquals { value: excluded },
            ],
        });
    }

    // "N or higher" → AtLeast(N)
    if let Some(bound_text) = cleaned.strip_suffix(" or higher") {
        let lower_bound = parse_int(bound_text)?;
        return Some(ExpectedValue::AtLeast { value: lower_bound });
    }

    // "N or less" → AtMost(N)
    if let Some(bound_text) = cleaned.strip_suffix(" or less") {
        let upper_bound = parse_int(bound_text)?;
        return Some(ExpectedValue::AtMost { value: upper_bound });
    }

    // "N" → Equals(Dword(N));  "N or M [or …]" → OneOf(...)
    let parts: Vec<&str> = cleaned.split(" or ").map(str::trim).collect();
    if parts.len() == 1 {
        let value = parse_dword(parts[0])?;
        return Some(ExpectedValue::Equals { value });
    }
    let values: Option<Vec<Value>> =
        parts.iter().map(|part| parse_dword(part)).collect();
    Some(ExpectedValue::OneOf { values: values? })
}

fn parse_int(text: &str) -> Option<i64> {
    let stripped = strip_parentheticals(text.trim());
    let cleaned = stripped.trim();
    let digits: String = cleaned
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn parse_dword(text: &str) -> Option<Value> {
    let stripped = strip_parentheticals(text.trim());
    let cleaned = stripped.trim();
    let digits: String = cleaned
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let dword_value: u32 = digits.parse().ok()?;
    Some(Value::Dword { value: dword_value })
}

fn strip_parentheticals(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut depth: usize = 0;
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => stripped.push(c),
            _ => {}
        }
    }
    stripped
}

/// Detects the per-key-different DWORD pattern (e.g. `1 (Disabled) and
/// 0 (DoReport)`), which v1 deliberately bails on so the dispatcher emits
/// a `Manual` rather than fabricating a single shared expected value.
fn contains_per_key_split(text: &str) -> bool {
    text.contains(") and ")
}

/// Parses a comma-separated list of GUIDs (with optional Oxford "and") into
/// the substrings vector for `ContainsAll`. Returns `None` when the snippet
/// isn't a list of well-formed GUIDs — caller falls back to `Equals(Str)`.
fn parse_guid_list(snippet: &str) -> Option<Vec<String>> {
    // Mid-GUID line wraps insert spaces after hyphens (e.g. `{xxxx-...-yyyy- ZZZZ}`);
    // collapse them so each GUID becomes contiguous before the comma split.
    let dewrapped = snippet.replace("- ", "-");

    // Normalize Oxford "and" + plain "and" into commas so a single split-on-','
    // yields one entry per GUID.
    let normalized = dewrapped
        .replace(", and ", ", ")
        .replace(" and ", ", ");

    let parts: Vec<String> = normalized
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();

    if parts.len() >= 2 && parts.iter().all(|part| is_guid(part)) {
        Some(parts)
    } else {
        None
    }
}

fn is_guid(text: &str) -> bool {
    let trimmed = text.trim();
    let Some(inner) = trimmed
        .strip_prefix('{')
        .and_then(|stripped| stripped.strip_suffix('}'))
    else {
        return false;
    };
    if inner.len() != 36 {
        return false;
    }
    inner.chars().enumerate().all(|(idx, c)| match idx {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    })
}

fn normalize_whitespace(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut prev_was_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !prev_was_space {
                normalized.push(' ');
                prev_was_space = true;
            }
        } else {
            normalized.push(c);
            prev_was_space = false;
        }
    }
    normalized
}

fn find_after<'a>(haystack: &'a str, needle: &str) -> Option<&'a str> {
    haystack
        .find(needle)
        .map(|idx| &haystack[idx + needle.len()..])
}

fn capture_until_period(text: &str) -> &str {
    text.find('.').map(|idx| &text[..idx]).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_single_key() {
        let body = "REG_DWORD value of 0.\n\nHKLM\\SOFTWARE\\Foo\\Bar:Baz\n";
        let paths = extract_paths(body);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].scope, RegistryScope::Machine);
        assert_eq!(paths[0].path, "HKLM\\SOFTWARE\\Foo\\Bar");
        assert_eq!(paths[0].value_name, "Baz");
    }

    #[test]
    fn extracts_two_keys_consecutive() {
        let body = "\
HKLM\\SOFTWARE\\Foo:One
HKLM\\SOFTWARE\\Bar:Two
";
        let paths = extract_paths(body);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value_name, "One");
        assert_eq!(paths[1].value_name, "Two");
    }

    #[test]
    fn dewraps_mid_token_continuation() {
        // Mimics 4.6.11.1: ":\\*\\NE" wrapped to "TLOGON" with no trailing
        // space on the wrapped line — must join with no separator.
        let body = "\
HKLM\\SOFTWARE\\Policies\\Foo\\HardenedPaths:\\\\*\\NE
TLOGON
HKLM\\SOFTWARE\\Policies\\Foo\\HardenedPaths:\\\\*\\SY
SVOL
";
        let paths = extract_paths(body);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value_name, "\\\\*\\NETLOGON");
        assert_eq!(paths[1].value_name, "\\\\*\\SYSVOL");
    }

    #[test]
    fn dewraps_path_preserving_logical_space() {
        // Mimics 4.11.5.2: "HKU\[USER " (trailing space) wrapped to "SID]\..."
        // — must join with a single space.
        let body = "HKU\\[USER \nSID]\\Software\\Foo:Bar\n";
        let paths = extract_paths(body);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, "HKU\\[USER SID]\\Software\\Foo");
        assert_eq!(paths[0].value_name, "Bar");
    }

    #[test]
    fn detects_hku_scope() {
        let body = "HKU\\[USER SID]\\Software\\Foo:Bar\n";
        let paths = extract_paths(body);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].scope, RegistryScope::CurrentUser);
    }

    #[test]
    fn parses_dword_equals() {
        let body = "...REG_DWORD value of 0.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::Equals {
                value: Value::Dword { value: 0 }
            })
        );
    }

    #[test]
    fn parses_dword_oneof() {
        let body = "...REG_DWORD value of 0 or 1.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::OneOf {
                values: vec![Value::Dword { value: 0 }, Value::Dword { value: 1 }],
            })
        );
    }

    #[test]
    fn parses_dword_at_least() {
        let body = "...REG_DWORD value of 5 or higher.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::AtLeast { value: 5 })
        );
    }

    #[test]
    fn parses_dword_at_most() {
        let body = "...REG_DWORD value of 100 or less.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::AtMost { value: 100 })
        );
    }

    #[test]
    fn parses_dword_all_atmost_and_notequals() {
        let body = "...REG_DWORD value of 900000 or less but not 0.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 900000 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            })
        );
    }

    #[test]
    fn parses_dword_all_atmost_and_notequals_with_comma() {
        let body = "...REG_DWORD value of 900000 or less, but not 0.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 900000 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            })
        );
    }

    #[test]
    fn parses_dword_all_with_lost_space_quirk() {
        // PDF extraction sometimes produces "but not0" with no space at the
        // wrap boundary. The matcher must tolerate it.
        let body = "...REG_DWORD value of 900000 or less but not0.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 900000 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            })
        );
    }

    #[test]
    fn detects_well_formed_guid() {
        assert!(is_guid("{d48179be-ec20-11d1-b6b8-00c04fa372a7}"));
        assert!(is_guid("{7ebefbc0-3200-11d2-b4c2-00a0C9697d07}")); // mixed case
        assert!(!is_guid("d48179be-ec20-11d1-b6b8-00c04fa372a7")); // no braces
        assert!(!is_guid("{d48179be-ec20-11d1-b6b8}")); // wrong length
        assert!(!is_guid("{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}")); // non-hex
        assert!(!is_guid(""));
    }

    #[test]
    fn parses_reg_sz_guid_list_as_containsall() {
        let body = "...REG_SZ value of {d48179be-ec20-11d1-b6b8-00c04fa372a7}, \
                    {7ebefbc0-3200-11d2-b4c2-00a0C9697d07}, \
                    and {c06ff265-ae09-48f0-812c-16753d7cba83}.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::ContainsAll {
                substrings: vec![
                    "{d48179be-ec20-11d1-b6b8-00c04fa372a7}".to_string(),
                    "{7ebefbc0-3200-11d2-b4c2-00a0C9697d07}".to_string(),
                    "{c06ff265-ae09-48f0-812c-16753d7cba83}".to_string(),
                ],
            })
        );
    }

    #[test]
    fn parses_wrapped_guid_list_dewraps_each_guid() {
        // Mimics 4.10.9.1.3: PDF column wraps insert a space after hyphens
        // inside individual GUIDs.
        let body = "...REG_SZ value of {7ebefbc0-3200-11d2-b4c2- 00a0C9697d07}, \
                    {c06ff265-ae09- 48f0-812c-16753d7cba83}, \
                    and {6bdd1fc1- 810f-11d0-bec7-08002be2092f}.\n";
        match parse_expected(body) {
            Some(ExpectedValue::ContainsAll { substrings }) => {
                assert_eq!(substrings.len(), 3);
                assert_eq!(substrings[0], "{7ebefbc0-3200-11d2-b4c2-00a0C9697d07}");
                assert_eq!(substrings[1], "{c06ff265-ae09-48f0-812c-16753d7cba83}");
                assert_eq!(substrings[2], "{6bdd1fc1-810f-11d0-bec7-08002be2092f}");
            }
            other => panic!("expected ContainsAll, got {other:?}"),
        }
    }

    #[test]
    fn parses_sz_equals() {
        let body = "...REG_SZ value of MyExpectedString.\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::Equals {
                value: Value::Str {
                    value: "MyExpectedString".to_string()
                },
            })
        );
    }

    #[test]
    fn parses_absent_key_not_existing() {
        let body = "...registry location with the key not existing.\n";
        assert_eq!(parse_expected(body), Some(ExpectedValue::Absent));
    }

    #[test]
    fn parses_absent_or_dword() {
        let body = "...registry value does not exist, or when it exists with a value of 0:\n";
        assert_eq!(
            parse_expected(body),
            Some(ExpectedValue::AbsentOr {
                inner: Box::new(ExpectedValue::Equals {
                    value: Value::Dword { value: 0 }
                }),
            })
        );
    }

    #[test]
    fn bails_on_per_key_different_dwords() {
        let body = "...REG_DWORD value of 1 (Disabled) and 0 (DoReport).\n";
        assert_eq!(parse_expected(body), None);
    }

    #[test]
    fn try_parse_returns_none_with_no_paths() {
        let body = "Some prose with REG_DWORD value of 0 but no path.\n";
        assert!(try_parse(body).is_none());
    }

    #[test]
    fn try_parse_emits_one_check_per_path_with_shared_expected() {
        let body = "\
REG_DWORD value of 1.
HKLM\\SOFTWARE\\A:X
HKLM\\SOFTWARE\\B:Y
";
        let procedure = try_parse(body).expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(checks.len(), 2);
                assert_eq!(
                    checks[0].expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 1 }
                    }
                );
                assert_eq!(checks[0].expected, checks[1].expected);
            }
            _ => panic!("expected Registry variant"),
        }
    }
}
