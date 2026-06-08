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

/// Value-name suffixes that mark a provider-locator path. `_WinningProvider`
/// (REG_SZ) holds the winning provider's GUID and is what the runtime reads
/// to resolve the `Providers\{GUID}` path. Some recs cite the companion
/// `_ProviderSet` value in their audit text instead; the GUID still lives in
/// the `_WinningProvider` value beside it, so either suffix identifies the
/// same two-step pattern and resolves through the same lookup.
const PROVIDER_MARKERS: [&str; 2] = ["_WinningProvider", "_ProviderSet"];

/// Returns the provider-locator suffix `value_name` ends with, if any.
fn provider_marker(value_name: &str) -> Option<&'static str> {
    PROVIDER_MARKERS
        .iter()
        .copied()
        .find(|marker| value_name.ends_with(marker))
}

/// Reads a provider-locator path: its value name ends with a marker AND the
/// path is a `PolicyManager\current\<scope>\<area>` path. Both are required
/// -- a plain GPO value that merely ends in `_ProviderSet` (e.g. AppHVSI's
/// `AllowAppHVSI_ProviderSet` under `SOFTWARE\Policies\...`) is an ordinary
/// registry value, not this pattern, and must stay with the Registry
/// variant. Returns the marker, scope, and area for the caller to use.
fn provider_locator(joined: &JoinedPath) -> Option<(&'static str, PolicyScope, String)> {
    let marker = provider_marker(&joined.value_name)?;
    let (scope, area) = parse_scope_and_area(&joined.path)?;
    Some((marker, scope, area))
}

/// PolicyManager owns recs whose audit body has a provider-locator lookup
/// path.
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    super::run_detector(
        ctx.paths
            .iter()
            .any(|joined| provider_locator(joined).is_some()),
        "PolicyManager body could not be parsed",
        || try_parse(ctx.body, &ctx.paths),
    )
}

/// Returns a `PolicyManager` `AuditProcedure` if the audit body has a
/// provider-locator path AND a recognizable expected-value text shape.
/// Returns `None` so the dispatcher falls back to `Manual` for ASR-style
/// `value contains` recs and ADMX-XML structured values, neither of which
/// the v1 parser handles.
pub(super) fn try_parse(body: &str, paths: &[JoinedPath]) -> Option<AuditProcedure> {
    let (provider, marker, scope, area) = paths.iter().find_map(|joined| {
        let (marker, scope, area) = provider_locator(joined)?;
        Some((joined, marker, scope, area))
    })?;
    let setting = provider.value_name.strip_suffix(marker)?.to_string();
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
        assert!(
            parse_scope_and_area(
                "HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\unknown\\Area"
            )
            .is_none()
        );
    }

    #[test]
    fn try_parse_with_simple_dword_equals() {
        // Mimics rec 1.1 (Cortana): WinningProvider lookup + "is set to 0".
        let body = "\
1.  The location below holds the provider GUID.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\AboveLock:AllowCortanaAboveLock_WinningProvider

2.  At the location below the value is set to 0.
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
    fn try_parse_recognizes_provider_set_marker() {
        // Mimics 93.1: the audit text cites the `_ProviderSet` locator
        // rather than `_WinningProvider`. It's the same two-step pattern,
        // so it parses as PolicyManager with the marker stripped off the
        // setting name.
        let body = "\
1.  Note the WinningProvider GUID at the location below.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\Wifi:AllowAutoConnectToWiFiSenseHotspots_ProviderSet

2.  At the location below confirm the value is set to 0.
HKLM\\SOFTWARE\\Microsoft\\PolicyManager\\Providers\\{GUID}\\Default\\Device\\Wifi:AllowAutoConnectToWiFiSenseHotspots
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
                assert_eq!(area, "Wifi");
                assert_eq!(setting, "AllowAutoConnectToWiFiSenseHotspots");
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
    fn try_parse_ignores_gpo_value_ending_in_provider_set() {
        // Mimics 18.10.43.6 (AppHVSI): a plain GPO value whose name ends in
        // '_ProviderSet' but whose path is not a PolicyManager current path.
        // It must NOT be claimed here -- it belongs to the Registry variant.
        let body = "\
REG_DWORD value of 1.
HKLM\\SOFTWARE\\Policies\\Microsoft\\AppHVSI:AllowAppHVSI_ProviderSet
";
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
