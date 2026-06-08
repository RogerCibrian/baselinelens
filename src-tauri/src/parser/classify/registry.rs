//! Registry variant: builds one or more `RegistryCheck` entries from the
//! audit body's HKLM/HKU paths and a shared expected value parsed from the
//! audit text.

use crate::parser::classify::expected;
use crate::parser::classify::path::JoinedPath;
use crate::parser::classify::{DetectCtx, Detection};
use crate::parser::model::{AuditProcedure, ExpectedValue, RegistryCheck, RegistryScope, Value};

/// Registry owns recs with one or more HKLM/HKU paths. PolicyManager runs
/// first, so any `_WinningProvider` rec is already claimed before this.
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    super::run_detector(
        !ctx.paths.is_empty(),
        "registry body could not be parsed",
        || try_parse(ctx.body, &ctx.paths, &ctx.rec.title),
    )
}

/// Returns a `Registry` `AuditProcedure` if `paths` and `body` together
/// describe a recognizable shape; returns `None` so the dispatcher falls
/// back to `Manual` (e.g. for per-key differing values).
pub(super) fn try_parse(body: &str, paths: &[JoinedPath], title: &str) -> Option<AuditProcedure> {
    let scoped: Vec<(RegistryScope, &JoinedPath)> = paths
        .iter()
        .filter_map(|joined| Some((scope_prefix(&joined.path)?, joined)))
        .collect();
    if scoped.is_empty() {
        return None;
    }

    // Common case: a single expected value applies to every check.
    if let Some(expected) = expected::parse(body) {
        let expected = refine_with_title_range(expected, title);
        let checks = scoped
            .into_iter()
            .map(|(scope, joined)| RegistryCheck {
                path: joined.path.clone(),
                value_name: joined.value_name.clone(),
                expected: expected.clone(),
                scope,
            })
            .collect();
        return Some(AuditProcedure::Registry { checks });
    }

    // Per-key fallback: the audit text says "value of N1 (NameA) and N2 (NameB)" —
    // each check looks up its expected value by matching value_name to NameA/NameB.
    // Every extracted path must match a labeled entry — anything less is a sign
    // the body and the path list disagree (PDF wrap mangling a label, or a path
    // the labels don't cover), and a partially-covered check would silently pass
    // without flagging the missing keys. Bail to Manual instead.
    if let Some(per_key) = expected::parse_per_key_dword(body) {
        let mut checks = Vec::with_capacity(scoped.len());
        for (scope, joined) in &scoped {
            let entry = per_key
                .iter()
                .find(|(name, _)| name == &joined.value_name)?;
            checks.push(RegistryCheck {
                path: joined.path.clone(),
                value_name: joined.value_name.clone(),
                expected: entry.1.clone(),
                scope: *scope,
            });
        }
        return Some(AuditProcedure::Registry { checks });
    }

    None
}

/// Upgrades a bare exact-DWORD expected value to the threshold the title
/// states when the audit text only gave the boundary number.
///
/// Some recs back a range setting with audit text that names just the
/// threshold value (`REG_DWORD value of 30`), leaving the `or fewer` /
/// `or more` qualifier in the title (`'Configured: 30 or fewer'`). Read
/// from the body alone that becomes `Equals(30)`, which wrongly fails a
/// more-secure value. When the title's quoted target parses to an
/// `AtLeast`/`AtMost` bound on the same number, that bound is the
/// recommended state. The Windows LAPS Password Age Days and Password
/// Length recs read this way. Any other shape (a plain value, a string
/// target, a mismatched number) keeps the body-derived value.
fn refine_with_title_range(expected: ExpectedValue, title: &str) -> ExpectedValue {
    let ExpectedValue::Equals {
        value: Value::Dword { value: audit_value },
    } = expected
    else {
        return expected;
    };
    let unchanged = ExpectedValue::Equals {
        value: Value::Dword { value: audit_value },
    };
    let Some((phrase, _matching)) = super::quoted_title_target(title) else {
        return unchanged;
    };
    match expected::parse_value_phrase(phrase) {
        bound @ (ExpectedValue::AtLeast { value } | ExpectedValue::AtMost { value })
            if value == i64::from(audit_value) =>
        {
            bound
        }
        _ => unchanged,
    }
}

fn scope_prefix(path: &str) -> Option<RegistryScope> {
    let trimmed = path.trim_start();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::classify::path;
    use crate::parser::model::{ExpectedValue, Value};

    fn paths_for(body: &str) -> Vec<JoinedPath> {
        path::extract_all(body)
    }

    #[test]
    fn try_parse_emits_one_check_per_path_with_shared_expected() {
        let body = "\
REG_DWORD value of 1.
HKLM\\SOFTWARE\\A:X
HKLM\\SOFTWARE\\B:Y
";
        let paths = paths_for(body);
        let procedure = try_parse(body, &paths, "").expect("should parse");
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

    #[test]
    fn try_parse_returns_none_with_no_paths() {
        let body = "Some text with REG_DWORD value of 0 but no path.\n";
        let paths = paths_for(body);
        assert!(try_parse(body, &paths, "").is_none());
    }

    #[test]
    fn try_parse_assigns_per_key_expected_when_text_uses_split() {
        // Mimics 4.10.20.1.13: each path's value_name maps to its own expected.
        let body = "\
REG_DWORD value of 1 (Disabled) and 0 (DoReport).
HKLM\\SOFTWARE\\X:Disabled
HKLM\\SOFTWARE\\Y:DoReport
";
        let paths = paths_for(body);
        let procedure = try_parse(body, &paths, "").expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(checks.len(), 2);
                let disabled = checks.iter().find(|c| c.value_name == "Disabled").unwrap();
                let do_report = checks.iter().find(|c| c.value_name == "DoReport").unwrap();
                assert_eq!(
                    disabled.expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 1 }
                    }
                );
                assert_eq!(
                    do_report.expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 0 }
                    }
                );
            }
            _ => panic!("expected Registry variant"),
        }
    }

    #[test]
    fn try_parse_returns_none_when_per_key_label_missing_for_a_path() {
        // Three paths but only two labels — the third path can't be mapped
        // to an expected value, so try_parse must bail rather than silently
        // produce a two-check rec that omits the third.
        let body = "\
REG_DWORD value of 1 (Disabled) and 0 (DoReport).
HKLM\\SOFTWARE\\X:Disabled
HKLM\\SOFTWARE\\Y:DoReport
HKLM\\SOFTWARE\\Z:Extra
";
        let paths = paths_for(body);
        assert!(try_parse(body, &paths, "").is_none());
    }

    #[test]
    fn title_or_fewer_upgrades_bare_dword_to_at_most() {
        // Mimics 105.2 Password Age Days: audit text states only the
        // threshold (`value of 30`); the `or fewer` lives in the title.
        let body = "\
REG_DWORD value of 30.
HKLM\\SOFTWARE\\Microsoft\\Policies\\LAPS:PasswordAgeDays
";
        let paths = paths_for(body);
        let title = "Ensure 'Sample age setting' is set to 'Configured: 30 or fewer'";
        let procedure = try_parse(body, &paths, title).expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(checks.len(), 1);
                assert_eq!(checks[0].expected, ExpectedValue::AtMost { value: 30 });
            }
            _ => panic!("expected Registry variant"),
        }
    }

    #[test]
    fn title_or_more_upgrades_bare_dword_to_at_least() {
        // Mimics 105.4 Password Length: `value of 15` plus an `or more` title.
        let body = "\
REG_DWORD value of 15.
HKLM\\SOFTWARE\\Microsoft\\Policies\\LAPS:PasswordLength
";
        let paths = paths_for(body);
        let title = "Ensure 'Sample length setting' is set to 'Configured: 15 or more'";
        let procedure = try_parse(body, &paths, title).expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(checks[0].expected, ExpectedValue::AtLeast { value: 15 });
            }
            _ => panic!("expected Registry variant"),
        }
    }

    #[test]
    fn title_without_range_keeps_exact_body_value() {
        // An exact-value title ('Enabled') must not perturb the body value.
        let body = "\
REG_DWORD value of 1.
HKLM\\SOFTWARE\\A:X
";
        let paths = paths_for(body);
        let title = "Ensure 'Sample toggle' is set to 'Enabled'";
        let procedure = try_parse(body, &paths, title).expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(
                    checks[0].expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 1 }
                    }
                );
            }
            _ => panic!("expected Registry variant"),
        }
    }

    #[test]
    fn title_range_on_mismatched_number_keeps_body_value() {
        // The title's bound must agree with the audit threshold before it
        // overrides; a number that disagrees signals the two describe
        // different things, so the body value stands.
        let body = "\
REG_DWORD value of 30.
HKLM\\SOFTWARE\\A:X
";
        let paths = paths_for(body);
        let title = "Ensure 'Sample setting' is set to '15 or fewer'";
        let procedure = try_parse(body, &paths, title).expect("should parse");
        match procedure {
            AuditProcedure::Registry { checks } => {
                assert_eq!(
                    checks[0].expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 30 }
                    }
                );
            }
            _ => panic!("expected Registry variant"),
        }
    }

    #[test]
    fn detects_hku_scope() {
        assert_eq!(
            scope_prefix("HKU\\[USER SID]\\Software\\Foo"),
            Some(RegistryScope::CurrentUser)
        );
        assert_eq!(
            scope_prefix("HKLM\\SOFTWARE\\Foo"),
            Some(RegistryScope::Machine)
        );
        assert_eq!(scope_prefix("HKCU\\Foo"), None);
    }
}
