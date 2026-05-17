//! UserRightsAssignment variant: extracts the right name from the rec's
//! remediation section and the principal list from the title.
//!
//! All 35 URA recs in the v4.0.0 benchmark have a `User Rights\<Right Name>`
//! Settings Catalog path in their remediation — that's a uniform detection
//! cue that works for both explicit recs (whose audit body has an LSP path
//! too) and the implicit one (89.14, whose audit body has no path).

use crate::parser::classify::{DetectCtx, Detection};
use crate::parser::model::{AuditProcedure, MatchMode, Principal, PrincipalKind};
use crate::parser::structure::RawRecommendation;

/// User Rights Assignment owns recs whose remediation references the
/// rights path — the Settings Catalog form (`User Rights\`) or the Local
/// Security Policy form (`User Rights Assignment\`).
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    let is_ura = ctx
        .rec
        .sections
        .remediation
        .as_deref()
        .map(|remediation| {
            remediation.contains("User Rights\\")
                || remediation.contains("User Rights Assignment\\")
        })
        .unwrap_or(false);
    if !is_ura {
        return Detection::NotApplicable;
    }
    match try_parse(ctx.rec) {
        Some(procedure) => Detection::Parsed(procedure),
        None => Detection::Recognized {
            reason: "URA body could not be parsed",
        },
    }
}

/// Returns a `UserRightsAssignment` `AuditProcedure` if `rec`'s remediation
/// has a `User Rights\<Right>` line and the title is parseable; returns
/// `None` so the dispatcher emits `Manual` otherwise.
pub(super) fn try_parse(rec: &RawRecommendation) -> Option<AuditProcedure> {
    let remediation = rec.sections.remediation.as_deref()?;
    let right_name = extract_right_name(remediation)?;
    let (expected, matching) = parse_principals_from_title(&rec.title)?;
    Some(AuditProcedure::UserRightsAssignment {
        right_name,
        expected,
        matching,
    })
}

/// Returns the right name from the remediation's policy path. Handles the
/// Settings Catalog form (`User Rights\<Right>`) and the Local Security
/// Policy form (`…\User Rights Assignment\<Right>`); the trailing segment
/// is the right name in both.
fn extract_right_name(remediation: &str) -> Option<String> {
    for line in remediation.lines() {
        let trimmed = line.trim();
        if let Some(idx) = trimmed.find("User Rights Assignment\\") {
            let name = trimmed[idx + "User Rights Assignment\\".len()..].trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
        if let Some(rest) = trimmed.strip_prefix("User Rights\\") {
            let name = rest.trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Reads the principal list and match mode from the rec title.
/// `is set to 'X'` → `(parse(X), Exact)`; `to include 'X'` → `(parse(X), Includes)`.
fn parse_principals_from_title(title: &str) -> Option<(Vec<Principal>, MatchMode)> {
    let (after_cue, matching) = if let Some(idx) = title.find("to include '") {
        (&title[idx + "to include '".len()..], MatchMode::Includes)
    } else if let Some(idx) = title.find("is set to '") {
        (&title[idx + "is set to '".len()..], MatchMode::Exact)
    } else {
        return None;
    };
    let end = after_cue.find('\'')?;
    let principals = parse_principal_list(&after_cue[..end]);
    Some((principals, matching))
}

/// Parses a comma-separated principal list. The literal `No One` token
/// represents an empty principal set.
fn parse_principal_list(text: &str) -> Vec<Principal> {
    let trimmed = text.trim();
    if trimmed == "No One" {
        return Vec::new();
    }
    trimmed
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let kind = if name.contains('\\') {
                PrincipalKind::AccountName
            } else {
                PrincipalKind::WellKnownName
            };
            Principal {
                identifier: name.to_string(),
                kind,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::structure::BodySections;

    fn rec_with(remediation: &str, title: &str) -> RawRecommendation {
        use crate::parser::model::{Assessment, Level};
        RawRecommendation {
            id: "test".to_string(),
            level: Level::L1,
            bitlocker: false,
            assessment: Assessment::Automated,
            title: title.to_string(),
            sections: BodySections {
                remediation: Some(remediation.to_string()),
                ..Default::default()
            },
        }
    }

    #[test]
    fn extracts_right_name_from_remediation() {
        let remediation = "Set the following Settings Catalog path:\nUser Rights\\Debug Programs\n";
        assert_eq!(extract_right_name(remediation).as_deref(), Some("Debug Programs"));
    }

    #[test]
    fn extracts_right_name_from_gpo_local_security_policy_path() {
        let remediation = "To establish the recommended configuration via GP, set the \
            following UI path to Administrators, Remote Desktop Users:\n\
            Computer Configuration\\Policies\\Windows Settings\\Security Settings\\Local \
            Policies\\User Rights Assignment\\Access this computer from the network\n";
        assert_eq!(
            extract_right_name(remediation).as_deref(),
            Some("Access this computer from the network")
        );
    }

    #[test]
    fn returns_none_when_no_user_rights_line() {
        let remediation = "Set the path to Disabled.\n";
        assert!(extract_right_name(remediation).is_none());
    }

    #[test]
    fn parses_exact_with_single_principal() {
        let title = "Ensure 'Debug Programs' is set to 'Administrators'";
        let (principals, matching) = parse_principals_from_title(title).expect("parse");
        assert_eq!(matching, MatchMode::Exact);
        assert_eq!(principals.len(), 1);
        assert_eq!(principals[0].identifier, "Administrators");
        assert_eq!(principals[0].kind, PrincipalKind::WellKnownName);
    }

    #[test]
    fn parses_includes_with_multiple_principals() {
        let title = "Ensure 'Deny Access From Network' to include 'Guests, Local account'";
        let (principals, matching) = parse_principals_from_title(title).expect("parse");
        assert_eq!(matching, MatchMode::Includes);
        assert_eq!(principals.len(), 2);
        assert_eq!(principals[0].identifier, "Guests");
        assert_eq!(principals[1].identifier, "Local account");
    }

    #[test]
    fn parses_no_one_as_empty_list() {
        let title = "Ensure 'Lock Memory' is set to 'No One'";
        let (principals, matching) = parse_principals_from_title(title).expect("parse");
        assert_eq!(matching, MatchMode::Exact);
        assert!(principals.is_empty());
    }

    #[test]
    fn detects_account_name_kind_for_path_style() {
        let title = "Ensure 'Increase Scheduling Priority' is set to 'Administrators, Window Manager\\Window Manager Group'";
        let (principals, _) = parse_principals_from_title(title).expect("parse");
        assert_eq!(principals.len(), 2);
        assert_eq!(principals[0].kind, PrincipalKind::WellKnownName);
        assert_eq!(principals[1].kind, PrincipalKind::AccountName);
        assert_eq!(principals[1].identifier, "Window Manager\\Window Manager Group");
    }

    #[test]
    fn try_parse_full_rec() {
        let rec = rec_with(
            "Set the following Settings Catalog path to *S-1-5-32-544 (Administrators).\n\
             User Rights\\Debug Programs\n",
            "Ensure 'Debug Programs' is set to 'Administrators'",
        );
        let procedure = try_parse(&rec).expect("should parse");
        match procedure {
            AuditProcedure::UserRightsAssignment {
                right_name,
                expected,
                matching,
            } => {
                assert_eq!(right_name, "Debug Programs");
                assert_eq!(matching, MatchMode::Exact);
                assert_eq!(expected.len(), 1);
                assert_eq!(expected[0].identifier, "Administrators");
            }
            _ => panic!("expected UserRightsAssignment"),
        }
    }

    #[test]
    fn try_parse_implicit_rec_via_remediation() {
        // Mimics 89.14: audit body has no LSP path, but remediation does.
        let rec = rec_with(
            "Set the following Settings Catalog path to *S-1-5-32-546 (Guests).\n\
             User Rights\\Deny Local Log On\n",
            "Ensure 'Deny Local Log On' to include 'Guests'",
        );
        let procedure = try_parse(&rec).expect("should parse");
        match procedure {
            AuditProcedure::UserRightsAssignment {
                right_name,
                expected,
                matching,
            } => {
                assert_eq!(right_name, "Deny Local Log On");
                assert_eq!(matching, MatchMode::Includes);
                assert_eq!(expected[0].identifier, "Guests");
            }
            _ => panic!("expected UserRightsAssignment"),
        }
    }
}
