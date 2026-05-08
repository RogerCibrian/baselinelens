//! Secedit variant: extracts the setting name from the Settings Catalog
//! path in the remediation and the expected value from either the title or
//! the default-value section.
//!
//! The v1 benchmark surfaces three Secedit recs (49.1, 49.3, 49.4), all in
//! the secedit `[System Access]` section. The "Configure 'X'" recs (no
//! specific value in the title) verify that the value differs from the
//! default — the audit semantically checks that the admin renamed the
//! account.

use crate::parser::model::{AuditProcedure, ExpectedValue, SeceditSection, Value};
use crate::parser::structure::RawRecommendation;

/// Returns a `Secedit` `AuditProcedure` if the rec's remediation has a
/// `Local Policies Security Options\<Setting>` path and the title is
/// parseable.
pub(super) fn try_parse(rec: &RawRecommendation) -> Option<AuditProcedure> {
    let remediation = rec.sections.remediation.as_deref()?;
    let setting = extract_setting(remediation)?;
    let expected = parse_expected(rec)?;
    Some(AuditProcedure::Secedit {
        section: SeceditSection::SystemAccess,
        setting,
        expected,
    })
}

fn extract_setting(remediation: &str) -> Option<String> {
    for line in remediation.lines() {
        if let Some(rest) = line.trim().strip_prefix("Local Policies Security Options\\") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Reads the expected value from the title (`is set to 'X'`) or, when the
/// title says only `Configure 'X'`, infers `NotEquals(default)` from the
/// rec's default-value section.
fn parse_expected(rec: &RawRecommendation) -> Option<ExpectedValue> {
    let title = &rec.title;

    if let Some(idx) = title.find("is set to '") {
        let after = &title[idx + "is set to '".len()..];
        let end = after.find('\'')?;
        return Some(ExpectedValue::Equals {
            value: Value::Str {
                value: after[..end].to_string(),
            },
        });
    }

    if title.contains("Configure '") {
        let default_section = rec.sections.default_value.as_deref()?;
        let default_value = first_nonblank_line(default_section)?
            .trim()
            .trim_end_matches('.')
            .trim()
            .to_string();
        if default_value.is_empty() {
            return None;
        }
        return Some(ExpectedValue::NotEquals {
            value: Value::Str {
                value: default_value,
            },
        });
    }

    None
}

fn first_nonblank_line(text: &str) -> Option<&str> {
    text.lines().find(|line| !line.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::model::{Assessment, Level};
    use crate::parser::structure::BodySections;

    fn rec_for(title: &str, remediation: &str, default_value: Option<&str>) -> RawRecommendation {
        RawRecommendation {
            id: "test".to_string(),
            level: Level::L1,
            assessment: Assessment::Automated,
            title: title.to_string(),
            sections: BodySections {
                remediation: Some(remediation.to_string()),
                default_value: default_value.map(String::from),
                ..Default::default()
            },
        }
    }

    #[test]
    fn extracts_setting_from_remediation() {
        let remediation = "Set the path:\nLocal Policies Security Options\\Accounts: Guest account status\n";
        assert_eq!(
            extract_setting(remediation).as_deref(),
            Some("Accounts: Guest account status")
        );
    }

    #[test]
    fn parses_explicit_value_from_title() {
        let rec = rec_for(
            "Ensure 'Accounts: Enable Guest account status' is set to 'Disabled'",
            "Local Policies Security Options\\Accounts: Guest account status\n",
            None,
        );
        let procedure = try_parse(&rec).expect("should parse");
        match procedure {
            AuditProcedure::Secedit {
                setting, expected, ..
            } => {
                assert_eq!(setting, "Accounts: Guest account status");
                assert_eq!(
                    expected,
                    ExpectedValue::Equals {
                        value: Value::Str {
                            value: "Disabled".to_string()
                        }
                    }
                );
            }
            _ => panic!("expected Secedit"),
        }
    }

    #[test]
    fn parses_configure_as_not_equals_default() {
        let rec = rec_for(
            "Configure 'Accounts: Rename administrator account'",
            "Local Policies Security Options\\Accounts: Rename administrator account\n",
            Some("Administrator.\n"),
        );
        let procedure = try_parse(&rec).expect("should parse");
        match procedure {
            AuditProcedure::Secedit {
                setting, expected, ..
            } => {
                assert_eq!(setting, "Accounts: Rename administrator account");
                assert_eq!(
                    expected,
                    ExpectedValue::NotEquals {
                        value: Value::Str {
                            value: "Administrator".to_string()
                        }
                    }
                );
            }
            _ => panic!("expected Secedit"),
        }
    }

    #[test]
    fn returns_none_for_configure_without_default_value() {
        let rec = rec_for(
            "Configure 'Foo'",
            "Local Policies Security Options\\Foo\n",
            None,
        );
        assert!(try_parse(&rec).is_none());
    }
}
