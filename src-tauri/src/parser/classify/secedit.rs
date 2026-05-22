//! Secedit variant: extracts the setting name from the remediation's
//! policy path and the expected value from the title (or, for a
//! `Configure 'X'` rec with no value phrase, infers "differs from the
//! default" from the default-value section). All settings handled here
//! live in the secedit `[System Access]` INI section.

use crate::parser::classify::expected;
use crate::parser::classify::{DetectCtx, Detection};
use crate::parser::model::{AuditProcedure, ExpectedValue, Value};
use crate::parser::structure::RawRecommendation;

/// Secedit owns recs whose remediation references a Security Options or
/// Account Policies path. Cue and extraction share the same parent
/// markers, so a sub-node spelling difference or a PDF line-wrap can't
/// split them.
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    let is_secedit = ctx
        .rec
        .sections
        .remediation
        .as_deref()
        .map(|remediation| {
            super::policy_path_has(remediation, &["Security Options\\", "Account Policies\\"])
        })
        .unwrap_or(false);
    super::run_detector(is_secedit, "Secedit body could not be parsed", || {
        try_parse(ctx.rec)
    })
}

/// Returns a `Secedit` `AuditProcedure` if the rec's remediation has a
/// recognizable Security Options or Account Policies path and the title is
/// parseable.
pub(super) fn try_parse(rec: &RawRecommendation) -> Option<AuditProcedure> {
    let remediation = rec.sections.remediation.as_deref()?;
    let setting = extract_setting(remediation)?;
    let expected = parse_expected(rec)?;
    Some(AuditProcedure::Secedit { setting, expected })
}

fn extract_setting(remediation: &str) -> Option<String> {
    super::policy_setting(remediation, &["Security Options\\", "Account Policies\\"])
}

/// Reads the expected value from the title's quoted target (the shared
/// `is set to`/`to include` cue), routed through the shared value-phrase
/// parser. When the title says only `Configure 'X'` (no value phrase),
/// infers `NotEquals(default)` from the rec's default-value section.
fn parse_expected(rec: &RawRecommendation) -> Option<ExpectedValue> {
    let title = &rec.title;

    if let Some((phrase, _matching)) = super::quoted_title_target(title) {
        // Secedit checks are value comparisons; the match mode isn't
        // representable in the Secedit procedure, so an "includes"
        // phrasing is read as its value phrase the same as an exact one.
        return Some(expected::parse_value_phrase(phrase));
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
    use crate::parser::classify::testutil;
    use crate::parser::structure::BodySections;

    fn rec_for(title: &str, remediation: &str, default_value: Option<&str>) -> RawRecommendation {
        testutil::rec(
            title,
            BodySections {
                remediation: Some(remediation.to_string()),
                default_value: default_value.map(String::from),
                ..Default::default()
            },
        )
    }

    #[test]
    fn extracts_setting_from_remediation() {
        let remediation =
            "Set the path:\nLocal Policies Security Options\\Accounts: Guest account status\n";
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
                // Routed through the shared value-phrase parser:
                // Disabled is the [System Access] boolean 0.
                assert_eq!(
                    expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 0 }
                    }
                );
            }
            _ => panic!("expected Secedit"),
        }
    }

    #[test]
    fn parses_gpo_account_policy_path_and_numeric_constraint() {
        let rec = rec_for(
            "Ensure 'Enforce password history' is set to '24 or more password(s)'",
            "To establish the recommended configuration via GP, set the following \
             UI path to 24 or more password(s):\n\
             Computer Configuration\\Policies\\Windows Settings\\Security \
             Settings\\Account Policies\\Password Policy\\Enforce password history\n",
            None,
        );
        let procedure = try_parse(&rec).expect("should parse");
        match procedure {
            AuditProcedure::Secedit {
                setting, expected, ..
            } => {
                assert_eq!(setting, "Enforce password history");
                assert_eq!(expected, ExpectedValue::AtLeast { value: 24 });
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
