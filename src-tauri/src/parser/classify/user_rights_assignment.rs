//! UserRightsAssignment variant: extracts the right name from the rec's
//! remediation section and the principal list from the title.
//!
//! All 35 URA recs in the v4.0.0 benchmark have a `User Rights\<Right Name>`
//! Settings Catalog path in their remediation — that's a uniform detection
//! cue that works for both explicit recs (whose audit body has an LSP path
//! too) and the implicit one (89.14, whose audit body has no path).

use crate::parser::model::{AuditProcedure, MatchMode, Principal, PrincipalKind};
use crate::parser::structure::RawRecommendation;

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

/// Finds the `User Rights\<Right Name>` line in the remediation and returns
/// the right name.
fn extract_right_name(remediation: &str) -> Option<String> {
    for line in remediation.lines() {
        if let Some(rest) = line.trim().strip_prefix("User Rights\\") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
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
