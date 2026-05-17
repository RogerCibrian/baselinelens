//! PolicyManager variant: locates the `_WinningProvider` lookup path,
//! decomposes it into scope/area/setting, and pairs it with the expected
//! value parsed from the audit text.
//!
//! PolicyManager recs use Intune's two-step pattern in the audit body — step 1
//! reads `HKLM\SOFTWARE\Microsoft\PolicyManager\current\<scope>\<area>:<setting>_WinningProvider`
//! to discover the provider GUID, step 2 reads
//! `HKLM\SOFTWARE\Microsoft\PolicyManager\Providers\{GUID}\Default\<Scope>\<Area>:<Setting>`
//! for the actual value. The first path is canonical for parser purposes;
//! the GUID isn't known until audit time.

use crate::parser::classify::expected;
use crate::parser::classify::path::JoinedPath;
use crate::parser::classify::{DetectCtx, Detection};
use crate::parser::model::{AuditProcedure, PolicyScope};

/// PolicyManager owns recs whose audit body has a `_WinningProvider`
/// lookup path.
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    if !ctx
        .paths
        .iter()
        .any(|joined| joined.value_name.ends_with("_WinningProvider"))
    {
        return Detection::NotApplicable;
    }
    match try_parse(ctx.body, &ctx.paths) {
        Some(procedure) => Detection::Parsed(procedure),
        None => Detection::Recognized {
            reason: "PolicyManager body could not be parsed",
        },
    }
}

/// Returns a `PolicyManager` `AuditProcedure` if the audit body has a
/// `_WinningProvider` path AND a recognizable expected-value text shape.
/// Returns `None` so the dispatcher falls back to `Manual` for ASR-style
/// `value contains` recs and ADMX-XML structured values, neither of which
/// the v1 parser handles.
pub(super) fn try_parse(body: &str, paths: &[JoinedPath]) -> Option<AuditProcedure> {
    let provider = paths
        .iter()
        .find(|joined| joined.value_name.ends_with("_WinningProvider"))?;
    let (scope, area) = parse_scope_and_area(&provider.path)?;
    let setting = provider
        .value_name
        .strip_suffix("_WinningProvider")?
        .to_string();
    let expected = expected::parse(body)?;
    Some(AuditProcedure::PolicyManager {
        scope,
        area,
        setting,
        expected,
    })
}

/// Walks the provider path's components and pulls the two segments that sit
/// directly after `current`: the scope (`device` or `(USER SID)`) and the
/// area (e.g. `AboveLock`, `BitLocker`).
fn parse_scope_and_area(path: &str) -> Option<(PolicyScope, String)> {
    let parts: Vec<&str> = path.split('\\').collect();
    let current_idx = parts.iter().position(|segment| *segment == "current")?;
    let scope_part = parts.get(current_idx + 1)?;
    let area_part = parts.get(current_idx + 2)?;
    let scope = match *scope_part {
        "device" => PolicyScope::Device,
        "(USER SID)" => PolicyScope::User,
        _ => return None,
    };
    Some((scope, (*area_part).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::classify::path;
    use crate::parser::model::{ExpectedValue, Value};

    #[test]
    fn parses_device_scope_and_area() {
        let (scope, area) = parse_scope_and_area(
            "HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\AboveLock",
        )
        .expect("valid path");
        assert_eq!(scope, PolicyScope::Device);
        assert_eq!(area, "AboveLock");
    }

    #[test]
    fn parses_user_scope_and_area() {
        let (scope, area) = parse_scope_and_area(
            "HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\(USER SID)\\Settings",
        )
        .expect("valid path");
        assert_eq!(scope, PolicyScope::User);
        assert_eq!(area, "Settings");
    }

    #[test]
    fn rejects_unknown_scope_token() {
        assert!(parse_scope_and_area(
            "HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\unknown\\Area"
        )
        .is_none());
    }

    #[test]
    fn try_parse_with_simple_dword_equals() {
        // Mimics rec 1.1 (Cortana): WinningProvider lookup + "is set to 0".
        let body = "\
1.  Navigate to the following registry location and note the WinningProvider GUID.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\AboveLock:AllowCortanaAboveLock_WinningProvider

2.  Navigate to the following registry location and confirm the value is set to 0.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\Providers\\{GUID}\\Default\\Device\\AboveLock:AllowCortanaAboveLock
";
        let paths = path::extract_all(body);
        let procedure = try_parse(body, &paths).expect("should parse");
        match procedure {
            AuditProcedure::PolicyManager {
                scope,
                area,
                setting,
                expected,
            } => {
                assert_eq!(scope, PolicyScope::Device);
                assert_eq!(area, "AboveLock");
                assert_eq!(setting, "AllowCortanaAboveLock");
                assert_eq!(
                    expected,
                    ExpectedValue::Equals {
                        value: Value::Dword { value: 0 }
                    }
                );
            }
            _ => panic!("expected PolicyManager variant"),
        }
    }

    #[test]
    fn try_parse_returns_none_when_no_winning_provider() {
        let body = "HKLM\\SOFTWARE\\Foo:Bar\n";
        let paths = path::extract_all(body);
        assert!(try_parse(body, &paths).is_none());
    }

    #[test]
    fn try_parse_handles_admx_xml_value_as_str_equals() {
        let body = "\
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\ADMX_X:Setting_WinningProvider

the value is set to <enabled/><data id=\"X\" value=\"Y\" />.
";
        let paths = path::extract_all(body);
        let procedure = try_parse(body, &paths).expect("should parse");
        match procedure {
            AuditProcedure::PolicyManager { expected, .. } => {
                assert_eq!(
                    expected,
                    ExpectedValue::Equals {
                        value: Value::Str {
                            value: "<enabled/><data id=\"X\" value=\"Y\" />".to_string()
                        }
                    }
                );
            }
            _ => panic!("expected PolicyManager"),
        }
    }
}
