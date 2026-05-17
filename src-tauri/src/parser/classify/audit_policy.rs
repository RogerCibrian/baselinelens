//! AuditPolicy variant: pulls the subcategory GUID from the
//! `auditpol /get /subcategory:"{GUID}"` line in the audit body and the
//! expected mode from the rec title.

use crate::parser::classify::{DetectCtx, Detection};
use crate::parser::model::{AuditPolicyMode, AuditProcedure, MatchMode};

/// AuditPolicy owns recs whose audit body runs `auditpol /get
/// /subcategory:`.
pub(super) fn detect(ctx: &DetectCtx) -> Detection {
    if !ctx.body.contains("auditpol /get /subcategory:") {
        return Detection::NotApplicable;
    }
    match try_parse(ctx.body, &ctx.rec.title) {
        Some(procedure) => Detection::Parsed(procedure),
        None => Detection::Recognized {
            reason: "AuditPolicy body could not be parsed",
        },
    }
}

/// Returns an `AuditPolicy` `AuditProcedure` if the body has a recognizable
/// auditpol command and the title carries a parseable mode. Returns `None`
/// for unrecognized title shapes so the dispatcher emits `Manual`.
pub(super) fn try_parse(audit_body: &str, title: &str) -> Option<AuditProcedure> {
    let subcategory_guid = extract_subcategory_guid(audit_body)?;
    let (expected, matching) = parse_mode_from_title(title)?;
    Some(AuditProcedure::AuditPolicy {
        subcategory_guid,
        expected,
        matching,
    })
}

/// Pulls the literal `{GUID}` (curly braces included, as auditpol expects)
/// from the `auditpol /get /subcategory:"{GUID}"` invocation.
fn extract_subcategory_guid(audit_body: &str) -> Option<String> {
    let cue = "/subcategory:\"";
    let after_cue = audit_body
        .find(cue)
        .map(|idx| &audit_body[idx + cue.len()..])?;
    let end = after_cue.find('"')?;
    Some(after_cue[..end].to_string())
}

/// Reads the mode and match kind out of the rec title.
/// `is set to 'X'` → `(X, Exact)`; `is set to include 'X'` → `(X, Includes)`.
fn parse_mode_from_title(title: &str) -> Option<(AuditPolicyMode, MatchMode)> {
    let (cue, matching) = if let Some(idx) = title.find("is set to include '") {
        (&title[idx + "is set to include '".len()..], MatchMode::Includes)
    } else if let Some(idx) = title.find("is set to '") {
        (&title[idx + "is set to '".len()..], MatchMode::Exact)
    } else {
        return None;
    };
    let end = cue.find('\'')?;
    let mode = parse_mode_token(&cue[..end])?;
    Some((mode, matching))
}

fn parse_mode_token(token: &str) -> Option<AuditPolicyMode> {
    match token {
        "Success and Failure" => Some(AuditPolicyMode::SuccessAndFailure),
        "Success" => Some(AuditPolicyMode::Success),
        "Failure" => Some(AuditPolicyMode::Failure),
        "No Auditing" => Some(AuditPolicyMode::NoAuditing),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_guid_from_body() {
        let body = "auditpol /get /subcategory:\"{0cce923f-69ae-11d9-bed3-505054503030}\"\n";
        assert_eq!(
            extract_subcategory_guid(body).as_deref(),
            Some("{0cce923f-69ae-11d9-bed3-505054503030}")
        );
    }

    #[test]
    fn parses_exact_success_and_failure() {
        let title = "Ensure 'Foo' is set to 'Success and Failure'";
        let (mode, matching) = parse_mode_from_title(title).expect("should parse");
        assert_eq!(mode, AuditPolicyMode::SuccessAndFailure);
        assert_eq!(matching, MatchMode::Exact);
    }

    #[test]
    fn parses_includes_success() {
        let title = "Ensure 'Foo' is set to include 'Success'";
        let (mode, matching) = parse_mode_from_title(title).expect("should parse");
        assert_eq!(mode, AuditPolicyMode::Success);
        assert_eq!(matching, MatchMode::Includes);
    }

    #[test]
    fn parses_includes_failure() {
        let title = "Ensure 'Foo' is set to include 'Failure'";
        let (mode, matching) = parse_mode_from_title(title).expect("should parse");
        assert_eq!(mode, AuditPolicyMode::Failure);
        assert_eq!(matching, MatchMode::Includes);
    }

    #[test]
    fn parses_no_auditing() {
        let title = "Ensure 'Foo' is set to 'No Auditing'";
        let (mode, matching) = parse_mode_from_title(title).expect("should parse");
        assert_eq!(mode, AuditPolicyMode::NoAuditing);
        assert_eq!(matching, MatchMode::Exact);
    }

    #[test]
    fn rejects_unknown_mode_token() {
        let title = "Ensure 'Foo' is set to 'Bogus'";
        assert!(parse_mode_from_title(title).is_none());
    }

    #[test]
    fn try_parse_full_rec() {
        let body = "\
Navigate to the UI Path articulated in the Remediation section and confirm it is set as
prescribed.
OR
auditpol /get /subcategory:\"{0cce9215-69ae-11d9-bed3-505054503030}\"
";
        let title = "Ensure 'Account Logon Logoff Audit Logon' is set to 'Success and Failure'";
        let procedure = try_parse(body, title).expect("should parse");
        match procedure {
            AuditProcedure::AuditPolicy {
                subcategory_guid,
                expected,
                matching,
            } => {
                assert_eq!(subcategory_guid, "{0cce9215-69ae-11d9-bed3-505054503030}");
                assert_eq!(expected, AuditPolicyMode::SuccessAndFailure);
                assert_eq!(matching, MatchMode::Exact);
            }
            _ => panic!("expected AuditPolicy variant"),
        }
    }
}
