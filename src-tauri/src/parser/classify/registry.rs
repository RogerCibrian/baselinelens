//! Registry variant: builds one or more `RegistryCheck` entries from the
//! audit body's HKLM/HKU paths and a shared expected value parsed from the
//! audit text.

use crate::parser::classify::expected;
use crate::parser::classify::path::JoinedPath;
use crate::parser::model::{AuditProcedure, RegistryCheck, RegistryScope};

/// Returns a `Registry` `AuditProcedure` if `paths` and `body` together
/// describe a recognizable shape; returns `None` so the dispatcher falls
/// back to `Manual` (e.g. for per-key differing values).
pub(super) fn try_parse(body: &str, paths: &[JoinedPath]) -> Option<AuditProcedure> {
    let scoped: Vec<(RegistryScope, &JoinedPath)> = paths
        .iter()
        .filter_map(|joined| Some((scope_prefix(&joined.path)?, joined)))
        .collect();
    if scoped.is_empty() {
        return None;
    }
    let expected = expected::parse(body)?;
    let checks = scoped
        .into_iter()
        .map(|(scope, joined)| RegistryCheck {
            path: joined.path.clone(),
            value_name: joined.value_name.clone(),
            expected: expected.clone(),
            scope,
        })
        .collect();
    Some(AuditProcedure::Registry { checks })
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
        let procedure = try_parse(body, &paths).expect("should parse");
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
        assert!(try_parse(body, &paths).is_none());
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
