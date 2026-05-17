//! Shared expected-value text parser.
//!
//! Recognizes the audit-text shapes used by both Registry and PolicyManager
//! recommendations and maps them to `ExpectedValue` variants. Returns `None`
//! for shapes the parser doesn't yet understand so the caller can fall back
//! to `Manual`.

use crate::parser::model::{ExpectedValue, Value};

/// Extracts the expected registry value from the audit text. Patterns are
/// tried in priority order: `Absent` → `AbsentOr(Equals(Dword))` → `REG_SZ`
/// (GUID list as `ContainsAll`, otherwise `Equals(Str)`) → `REG_DWORD`
/// constraint → `is set to` constraint (PolicyManager-style).
pub(super) fn parse(body: &str) -> Option<ExpectedValue> {
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
        && let Some(value) = parse_dword(after)
    {
        return Some(ExpectedValue::AbsentOr {
            inner: Box::new(ExpectedValue::Equals { value }),
        });
    }

    // A "value that is blank" / "no value set" phrasing means the value
    // must be present and empty — distinct from the "does not exist"
    // absent vocabulary handled above.
    if normalized.contains("REG_MULTI_SZ value that is blank")
        || (normalized.contains("REG_MULTI_SZ") && normalized.contains("no value in key"))
    {
        return Some(ExpectedValue::Equals {
            value: Value::MultiStr { values: Vec::new() },
        });
    }
    if normalized.contains("REG_SZ that is <blank>")
        || (normalized.contains("REG_SZ") && normalized.contains("no value set"))
    {
        return Some(ExpectedValue::Equals {
            value: Value::Str {
                value: String::new(),
            },
        });
    }

    if let Some(after) = find_after(&normalized, "REG_DWORD value between ") {
        let snippet = capture_until_period(after);
        if let Some((low, high)) = parse_between(snippet) {
            return Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtLeast { value: low },
                    ExpectedValue::AtMost { value: high },
                ],
            });
        }
    }

    if let Some(after) = find_after(&normalized, "REG_MULTI_SZ value of ") {
        let items = split_list(capture_until_period(after));
        if !items.is_empty() {
            return Some(ExpectedValue::Equals {
                value: Value::MultiStr { values: items },
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
        if let Some(constraint) = parse_dword_constraint(snippet) {
            return Some(constraint);
        }
        // A REG_DWORD label on a backslash-bearing comma/and list is a
        // mislabeled REG_MULTI_SZ path list, not a number.
        if snippet.contains('\\') {
            let items = split_list(snippet);
            if !items.is_empty() {
                return Some(ExpectedValue::Equals {
                    value: Value::MultiStr { values: items },
                });
            }
        }
        return None;
    }

    if let Some(after) = find_after(&normalized, "the value contains ") {
        let snippet = capture_until_period(after);
        return parse_contains_constraint(snippet);
    }

    if let Some(after) = find_after(&normalized, "the value is set to ") {
        let snippet = capture_until_period(after).trim();
        // ADMX-XML literal value (e.g. `<enabled/><data id="..." value="..." />`)
        // is stored as a string; the audit script does an exact match.
        if snippet.starts_with('<') {
            return Some(ExpectedValue::Equals {
                value: Value::Str {
                    value: snippet.to_string(),
                },
            });
        }
        return parse_dword_constraint(snippet);
    }

    None
}

/// Interprets a bare value phrase (the quoted target from a rec title,
/// e.g. `24 or more password(s)`, `365 or fewer days, but not 0`,
/// `Enabled`). `Enabled`/`Disabled` map to the secedit `[System Access]`
/// boolean representation (`1`/`0`); a numeric-constraint phrase reuses
/// `parse_dword_constraint`; anything else is an exact string match.
pub(super) fn parse_value_phrase(phrase: &str) -> ExpectedValue {
    let trimmed = phrase.trim();
    match trimmed {
        "Enabled" => {
            return ExpectedValue::Equals {
                value: Value::Dword { value: 1 },
            };
        }
        "Disabled" => {
            return ExpectedValue::Equals {
                value: Value::Dword { value: 0 },
            };
        }
        _ => {}
    }
    if let Some(constraint) = parse_dword_constraint(trimmed) {
        return constraint;
    }
    ExpectedValue::Equals {
        value: Value::Str {
            value: trimmed.to_string(),
        },
    }
}

/// Parses the per-key-different DWORD pattern: `REG_DWORD value of N1 (NameA)
/// and N2 (NameB)`. Returns `(value_name, expected)` pairs that callers can
/// use to assign each registry check its own expected value.
pub(super) fn parse_per_key_dword(body: &str) -> Option<Vec<(String, ExpectedValue)>> {
    let normalized = normalize_whitespace(body);
    let after = find_after(&normalized, "REG_DWORD value of ")?;
    let snippet = capture_until_period(after);
    if !contains_per_key_split(snippet) {
        return None;
    }
    let parts: Vec<&str> = snippet.split(" and ").collect();
    let mut entries = Vec::with_capacity(parts.len());
    for part in parts {
        let trimmed = part.trim();
        let value = parse_dword(trimmed)?;
        let open = trimmed.find('(')?;
        let close_offset = trimmed[open..].find(')')?;
        let name = trimmed[open + 1..open + close_offset].trim().to_string();
        if name.is_empty() {
            return None;
        }
        entries.push((name, ExpectedValue::Equals { value }));
    }
    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

/// Parses the snippet after `the value contains ` (used in ASR rec audit text).
/// Recognized shapes:
/// - `<X>` → `Contains { substring: X }`
/// - `<X> or <Y> [or …]` → `Any { values: [Contains(X), Contains(Y), …] }`
///
/// Parenthetical annotations like `(Block)` / `(Audit)` are stripped, and
/// mid-string PDF wraps inside the substrings are dewrapped (`- ` → `-`).
fn parse_contains_constraint(snippet: &str) -> Option<ExpectedValue> {
    let dewrapped = snippet.replace("- ", "-");
    let stripped = strip_parentheticals(&dewrapped);
    let normalized: String = stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let parts: Vec<String> = normalized
        .split(" or ")
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        return Some(ExpectedValue::Contains {
            substring: parts.into_iter().next()?,
        });
    }
    let values: Vec<ExpectedValue> = parts
        .into_iter()
        .map(|substring| ExpectedValue::Contains { substring })
        .collect();
    Some(ExpectedValue::Any { values })
}

/// Parses the snippet that follows a numeric-value cue (`REG_DWORD value of`
/// or `the value is set to`). Recognized shapes (priority order):
/// - `N (or higher)` / `N (or more)` parenthesized → `AtLeast(N)`
/// - `anything other than N` → `NotEquals(Dword(N))`
/// - `N or fewer/less [<noun>], but not M` → `All([AtMost(N), NotEquals(M)])`
/// - `N or fewer/less [<noun>]` → `AtMost(N)`
/// - `N or higher/more` → `AtLeast(N)`
/// - `N or M [or …]` → `OneOf([Dword(N), Dword(M), …])`
/// - `N` → `Equals(Dword(N))`
fn parse_dword_constraint(snippet: &str) -> Option<ExpectedValue> {
    let trimmed = snippet.trim();

    // Parenthesized "(or higher)" / "(or more)" / "(or greater)" cue must be
    // checked BEFORE strip_parentheticals would discard it along with the parens.
    if trimmed.contains("(or higher)")
        || trimmed.contains("(or more)")
        || trimmed.contains("(or greater)")
    {
        let stripped = strip_parentheticals(trimmed);
        let bound = parse_int(stripped.trim())?;
        return Some(ExpectedValue::AtLeast { value: bound });
    }

    let stripped = strip_parentheticals(trimmed);
    let cleaned = stripped.trim();

    if let Some(rest) = cleaned.strip_prefix("anything other than ") {
        let value = parse_dword(rest)?;
        return Some(ExpectedValue::NotEquals { value });
    }

    if let Some((bound, after)) = find_at_most_cue(cleaned) {
        let suffix = after.trim_start_matches([',', ' ']).trim();
        if let Some(but_idx) = suffix.find("but not") {
            let excluded_str = &suffix[but_idx + "but not".len()..];
            let excluded = parse_dword(excluded_str)?;
            return Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: bound },
                    ExpectedValue::NotEquals { value: excluded },
                ],
            });
        }
        return Some(ExpectedValue::AtMost { value: bound });
    }

    if let Some(bound) = find_at_least_cue(cleaned) {
        return Some(ExpectedValue::AtLeast { value: bound });
    }

    // "N or that the key does not exist" → AbsentOr(Equals(Dword(N)))
    if let Some((bound_part, _)) = cleaned.split_once(" or that the key does not exist") {
        let value = parse_dword(bound_part)?;
        return Some(ExpectedValue::AbsentOr {
            inner: Box::new(ExpectedValue::Equals { value }),
        });
    }

    let parts: Vec<&str> = cleaned.split(" or ").map(str::trim).collect();
    if parts.len() == 1 {
        let value = parse_dword(parts[0])?;
        return Some(ExpectedValue::Equals { value });
    }
    let values: Option<Vec<Value>> =
        parts.iter().map(|part| parse_dword(part)).collect();
    Some(ExpectedValue::OneOf { values: values? })
}

/// Searches for `or fewer` / `or less` anywhere in the snippet. Returns the
/// numeric bound that precedes the cue plus the suffix after it.
/// The lenient anywhere-search (no leading-space requirement) tolerates the
/// PDF extraction quirk where wraps eat the space (`5or fewer ...`).
fn find_at_most_cue(snippet: &str) -> Option<(i64, &str)> {
    for cue in ["or fewer", "or less"] {
        if let Some(idx) = snippet.find(cue) {
            let before = snippet[..idx].trim();
            let after = &snippet[idx + cue.len()..];
            if let Some(bound) = parse_int(before) {
                return Some((bound, after));
            }
        }
    }
    None
}

fn find_at_least_cue(snippet: &str) -> Option<i64> {
    for cue in ["or higher", "or more", "or greater"] {
        if let Some(idx) = snippet.find(cue) {
            let before = snippet[..idx].trim();
            if let Some(bound) = parse_int(before) {
                return Some(bound);
            }
        }
    }
    None
}

fn parse_int(text: &str) -> Option<i64> {
    let stripped = strip_parentheticals(text.trim());
    let cleaned = stripped.trim();
    // Skip leading punctuation like stray backticks ('REG_DWORD value of `0').
    let from_first_digit = cleaned.trim_start_matches(|c: char| !c.is_ascii_digit());
    let digits: String = from_first_digit
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
    let from_first_digit = cleaned.trim_start_matches(|c: char| !c.is_ascii_digit());
    let digits: String = from_first_digit
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
/// 0 (DoReport)`), which the parser deliberately bails on.
fn contains_per_key_split(text: &str) -> bool {
    text.contains(") and ")
}

/// Parses a `N and M` range snippet into the inclusive `(low, high)`
/// bounds.
fn parse_between(snippet: &str) -> Option<(i64, i64)> {
    let (low, high) = snippet.trim().split_once(" and ")?;
    Some((parse_int(low)?, parse_int(high)?))
}

/// Splits a comma- and `and`-separated snippet into its items. List
/// items here are registry paths (no internal commas), and PDF-wrap
/// whitespace is already collapsed upstream, so the delimiters are
/// unambiguous.
fn split_list(snippet: &str) -> Vec<String> {
    snippet
        .replace(", and ", ", ")
        .replace(" and ", ", ")
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

pub(super) fn normalize_whitespace(text: &str) -> String {
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

/// Parses a comma-separated list of GUIDs (with optional Oxford "and") into
/// the substrings vector for `ContainsAll`. Returns `None` when the snippet
/// isn't a list of well-formed GUIDs.
fn parse_guid_list(snippet: &str) -> Option<Vec<String>> {
    let dewrapped = snippet.replace("- ", "-");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dword_equals() {
        let body = "...REG_DWORD value of 0.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::Dword { value: 0 }
            })
        );
    }

    #[test]
    fn parses_dword_oneof() {
        let body = "...REG_DWORD value of 0 or 1.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::OneOf {
                values: vec![Value::Dword { value: 0 }, Value::Dword { value: 1 }],
            })
        );
    }

    #[test]
    fn parses_dword_at_least_or_higher() {
        let body = "...REG_DWORD value of 5 or higher.\n";
        assert_eq!(parse(body), Some(ExpectedValue::AtLeast { value: 5 }));
    }

    #[test]
    fn parses_dword_at_least_or_more() {
        let body = "...the value is set to 180 or more.\n";
        assert_eq!(parse(body), Some(ExpectedValue::AtLeast { value: 180 }));
    }

    #[test]
    fn parses_parenthesized_at_least() {
        let body = "...the value is set to 14 (or higher).\n";
        assert_eq!(parse(body), Some(ExpectedValue::AtLeast { value: 14 }));
    }

    #[test]
    fn parses_dword_at_most_or_less() {
        let body = "...REG_DWORD value of 100 or less.\n";
        assert_eq!(parse(body), Some(ExpectedValue::AtMost { value: 100 }));
    }

    #[test]
    fn parses_dword_at_most_or_fewer_with_noun() {
        let body = "...the value is set to 365 or fewer days, but not 0.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 365 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            })
        );
    }

    #[test]
    fn parses_all_atmost_notequals_no_comma() {
        let body = "...REG_DWORD value of 900000 or less but not 0.\n";
        assert_eq!(
            parse(body),
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
    fn parses_all_with_lost_space_quirk() {
        let body = "...the value is set to 5or fewer invalid logon attempt(s), but not 0.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 5 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            })
        );
    }

    #[test]
    fn value_phrase_enabled_disabled_map_to_dword_bool() {
        assert_eq!(
            parse_value_phrase("Enabled"),
            ExpectedValue::Equals {
                value: Value::Dword { value: 1 }
            }
        );
        assert_eq!(
            parse_value_phrase("Disabled"),
            ExpectedValue::Equals {
                value: Value::Dword { value: 0 }
            }
        );
    }

    #[test]
    fn value_phrase_numeric_constraints() {
        assert_eq!(
            parse_value_phrase("24 or more password(s)"),
            ExpectedValue::AtLeast { value: 24 }
        );
        assert_eq!(
            parse_value_phrase("365 or fewer days, but not 0"),
            ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtMost { value: 365 },
                    ExpectedValue::NotEquals {
                        value: Value::Dword { value: 0 }
                    },
                ],
            }
        );
        assert_eq!(
            parse_value_phrase("1 or more day(s)"),
            ExpectedValue::AtLeast { value: 1 }
        );
    }

    #[test]
    fn value_phrase_falls_back_to_string() {
        assert_eq!(
            parse_value_phrase("Administrators"),
            ExpectedValue::Equals {
                value: Value::Str {
                    value: "Administrators".to_string()
                }
            }
        );
    }

    #[test]
    fn parses_anything_other_than() {
        let body = "...the value is set to anything other than 3.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::NotEquals {
                value: Value::Dword { value: 3 }
            })
        );
    }

    #[test]
    fn parses_set_to_simple_equals() {
        let body = "...the value is set to 1.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::Dword { value: 1 }
            })
        );
    }

    #[test]
    fn parses_sz_equals() {
        let body = "...REG_SZ value of MyExpectedString.\n";
        assert_eq!(
            parse(body),
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
        assert_eq!(parse(body), Some(ExpectedValue::Absent));
    }

    #[test]
    fn parses_blank_multi_sz_as_equals_empty() {
        let body = "...REG_MULTI_SZ value that is blank i.e. no value in key.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::MultiStr { values: Vec::new() }
            })
        );
    }

    #[test]
    fn parses_blank_sz_as_equals_empty_string() {
        let body = "...REG_SZ that is <blank> i.e. no value set.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::Str {
                    value: String::new()
                }
            })
        );
    }

    #[test]
    fn parses_dword_range_as_all_at_least_at_most() {
        let body = "...REG_DWORD value between 5 and 14.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::All {
                values: vec![
                    ExpectedValue::AtLeast { value: 5 },
                    ExpectedValue::AtMost { value: 14 },
                ],
            })
        );
    }

    #[test]
    fn parses_multi_sz_list_as_equals_multistr() {
        let body = "...REG_MULTI_SZ value of System\\CurrentControlSet\\Control\\ProductOptions, \
            System\\CurrentControlSet\\Control\\Server Applications and \
            Software\\Microsoft\\Windows NT\\CurrentVersion.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::MultiStr {
                    values: vec![
                        "System\\CurrentControlSet\\Control\\ProductOptions".to_string(),
                        "System\\CurrentControlSet\\Control\\Server Applications".to_string(),
                        "Software\\Microsoft\\Windows NT\\CurrentVersion".to_string(),
                    ]
                }
            })
        );
    }

    #[test]
    fn parses_mislabeled_dword_path_list_as_multistr() {
        let body = "...REG_DWORD value of System\\CurrentControlSet\\Control\\Print\\Printers \
            and System\\CurrentControlSet\\Services\\Eventlog.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::MultiStr {
                    values: vec![
                        "System\\CurrentControlSet\\Control\\Print\\Printers".to_string(),
                        "System\\CurrentControlSet\\Services\\Eventlog".to_string(),
                    ]
                }
            })
        );
    }

    #[test]
    fn parses_absent_or_with_reversed_wording() {
        // Services pattern: "REG_DWORD value of 4 or that the key does not exist."
        let body = "...REG_DWORD value of 4 or that the key does not exist.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::AbsentOr {
                inner: Box::new(ExpectedValue::Equals {
                    value: Value::Dword { value: 4 }
                }),
            })
        );
    }

    #[test]
    fn parses_absent_or_dword() {
        let body = "...registry value does not exist, or when it exists with a value of 0:\n";
        assert_eq!(
            parse(body),
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
        assert_eq!(parse(body), None);
    }


    #[test]
    fn parses_reg_sz_guid_list_as_containsall() {
        let body = "...REG_SZ value of {d48179be-ec20-11d1-b6b8-00c04fa372a7}, \
                    {7ebefbc0-3200-11d2-b4c2-00a0C9697d07}, \
                    and {c06ff265-ae09-48f0-812c-16753d7cba83}.\n";
        assert_eq!(
            parse(body),
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
    fn parses_or_greater_synonym() {
        let body = "...REG_DWORD value of 32768 or greater.\n";
        assert_eq!(parse(body), Some(ExpectedValue::AtLeast { value: 32768 }));
    }

    #[test]
    fn parses_dword_with_stray_backtick() {
        // Mimics 49.7's PDF artifact: "REG_DWORD value of `0."
        let body = "...REG_DWORD value of `0.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::Dword { value: 0 }
            })
        );
    }

    #[test]
    fn parses_value_contains_single_substring() {
        let body = "...the value contains 56a863a9-875e-4185-98a7-b882c64b5ce5=1 (Block).\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Contains {
                substring: "56a863a9-875e-4185-98a7-b882c64b5ce5=1".to_string(),
            })
        );
    }

    #[test]
    fn parses_value_contains_any_block_or_audit() {
        let body = "...the value contains d4f940ab-401b-4efc-aadc-ad5f3c50688a=1 (Block) \
                    or d4f940ab-401b-4efc-aadc-ad5f3c50688a=2 (Audit).\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Any {
                values: vec![
                    ExpectedValue::Contains {
                        substring: "d4f940ab-401b-4efc-aadc-ad5f3c50688a=1".to_string(),
                    },
                    ExpectedValue::Contains {
                        substring: "d4f940ab-401b-4efc-aadc-ad5f3c50688a=2".to_string(),
                    },
                ],
            })
        );
    }

    #[test]
    fn parses_value_contains_with_wrapped_guid() {
        // Mimics ASR recs where PDF wraps mid-GUID at hyphens.
        let body = "...the value contains d4f940ab-401b- 4efc-aadc-ad5f3c50688a=1 (Block).\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Contains {
                substring: "d4f940ab-401b-4efc-aadc-ad5f3c50688a=1".to_string(),
            })
        );
    }

    #[test]
    fn parses_admx_xml_literal_as_str_equals() {
        // Mimics 4.11.18.1 — XML literal value.
        let body = "...the value is set to <enabled/><data id=\"X\" value=\"Block\" />.\n";
        assert_eq!(
            parse(body),
            Some(ExpectedValue::Equals {
                value: Value::Str {
                    value: "<enabled/><data id=\"X\" value=\"Block\" />".to_string()
                }
            })
        );
    }

    #[test]
    fn parses_per_key_dword_returns_value_name_pairs() {
        // Mimics 4.10.20.1.13 — different expected values per key.
        let body = "...REG_DWORD value of 1 (Disabled) and 0 (DoReport).\n";
        let entries = parse_per_key_dword(body).expect("per-key");
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            (
                "Disabled".to_string(),
                ExpectedValue::Equals {
                    value: Value::Dword { value: 1 }
                }
            )
        );
        assert_eq!(
            entries[1],
            (
                "DoReport".to_string(),
                ExpectedValue::Equals {
                    value: Value::Dword { value: 0 }
                }
            )
        );
    }

    #[test]
    fn parse_per_key_dword_returns_none_when_no_per_key_split() {
        let body = "...REG_DWORD value of 0.\n";
        assert!(parse_per_key_dword(body).is_none());
    }

    #[test]
    fn detects_well_formed_guid() {
        assert!(is_guid("{d48179be-ec20-11d1-b6b8-00c04fa372a7}"));
        assert!(is_guid("{7ebefbc0-3200-11d2-b4c2-00a0C9697d07}"));
        assert!(!is_guid("d48179be-ec20-11d1-b6b8-00c04fa372a7"));
        assert!(!is_guid("{d48179be-ec20-11d1-b6b8}"));
        assert!(!is_guid(""));
    }
}
