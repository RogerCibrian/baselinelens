//! Variant detection: maps a raw recommendation's audit body to an
//! `AuditProcedure` variant.

mod audit_policy;
mod expected;
mod path;
mod policy_manager;
mod registry;
mod secedit;
mod user_rights_assignment;

use crate::parser::classify::path::JoinedPath;
use crate::parser::model::AuditProcedure;
use crate::parser::structure::RawRecommendation;

/// Inputs every variant detector needs, computed once per recommendation.
struct DetectCtx<'a> {
    rec: &'a RawRecommendation,
    body: &'a str,
    paths: Vec<JoinedPath>,
}

/// A variant's answer to "is this recommendation mine, and could I parse
/// it?" — colocated with the variant's parser so detection and extraction
/// can't drift apart.
enum Detection {
    /// Not this variant's shape; the dispatcher tries the next.
    NotApplicable,
    /// This variant's shape, but the body couldn't be fully parsed.
    /// `reason` becomes the `Manual` description.
    Recognized { reason: &'static str },
    /// Successfully classified.
    Parsed(AuditProcedure),
}

/// Returns the appropriate `AuditProcedure` variant for this recommendation.
///
/// Each variant module owns a `detect` that decides whether the rec is its
/// shape and, if so, parses it. The dispatcher tries them in priority
/// order and takes the first non-`NotApplicable` answer. The order is
/// intentional: some shapes are subsets of others (PolicyManager is the
/// `_WinningProvider` subset of "has a registry path"), so a more specific
/// detector must run before a more general one.
pub(crate) fn audit_procedure(rec: &RawRecommendation) -> AuditProcedure {
    let Some(body) = rec.sections.audit.as_deref() else {
        return manual("missing audit section");
    };
    let ctx = DetectCtx {
        rec,
        body,
        paths: path::extract_all(body),
    };

    let detectors: [fn(&DetectCtx) -> Detection; 5] = [
        policy_manager::detect,
        registry::detect,
        audit_policy::detect,
        user_rights_assignment::detect,
        secedit::detect,
    ];
    for detect in detectors {
        match detect(&ctx) {
            Detection::NotApplicable => {}
            Detection::Recognized { reason } => return manual(reason),
            Detection::Parsed(procedure) => return procedure,
        }
    }
    manual("unhandled audit body shape")
}

fn manual(reason: &str) -> AuditProcedure {
    AuditProcedure::Manual {
        description: format!("Automated parser fell back to manual: {reason}"),
    }
}

/// True when the whitespace-normalized `remediation` contains any of
/// `markers`. Normalizing first makes the match immune to PDF
/// line-wraps falling inside a policy-path token.
pub(super) fn policy_path_has(remediation: &str, markers: &[&str]) -> bool {
    let normalized = expected::normalize_whitespace(remediation);
    markers.iter().any(|marker| normalized.contains(marker))
}

/// Returns the policy setting/right name from the remediation's policy
/// path: the segment after the final backslash following the first of
/// `markers` found in the whitespace-normalized text. Intermediate
/// sub-nodes (e.g. `Password Policy\`) are discarded; the trailing
/// segment is the setting name in every policy tree we read.
pub(super) fn policy_setting(remediation: &str, markers: &[&str]) -> Option<String> {
    let normalized = expected::normalize_whitespace(remediation);
    for marker in markers {
        if let Some(idx) = normalized.find(marker) {
            let tail = &normalized[idx + marker.len()..];
            let bounded = tail.split(" Note:").next().unwrap_or(tail);
            let segment = bounded.rsplit('\\').next().unwrap_or(bounded).trim();
            if !segment.is_empty() {
                return Some(segment.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::parser::{pdf, structure};

    /// Path to the benchmark PDF the diagnostics run against. Defaults to the
    /// v4.0.0 fixture under `dev/`; set `BASELINELENS_TEST_PDF` to an absolute
    /// path to point any diagnostic at a different baseline.
    fn fixture_pdf_path() -> PathBuf {
        if let Ok(override_path) = std::env::var("BASELINELENS_TEST_PDF") {
            return PathBuf::from(override_path);
        }
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf")
    }

    #[test]
    #[ignore = "diagnostic — prints classification breakdown without asserting; \
                drive with BASELINELENS_TEST_PDF to survey any baseline"]
    fn survey_classification() {
        let pdf_path = fixture_pdf_path();
        let text = match pdf::extract(&pdf_path) {
            Ok(text) => text,
            Err(err) => {
                eprintln!("PDF extraction FAILED for {}: {err}", pdf_path.display());
                return;
            }
        };
        let recs = match structure::slice(&text) {
            Ok(recs) => recs,
            Err(err) => {
                eprintln!("STRUCTURE SLICING FAILED for {}: {err}", pdf_path.display());
                return;
            }
        };

        let mut registry = 0usize;
        let mut policy_manager = 0usize;
        let mut audit_policy = 0usize;
        let mut user_rights = 0usize;
        let mut secedit_count = 0usize;
        let mut manual_by_reason: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();

        for rec in &recs {
            match audit_procedure(rec) {
                AuditProcedure::Registry { .. } => registry += 1,
                AuditProcedure::PolicyManager { .. } => policy_manager += 1,
                AuditProcedure::AuditPolicy { .. } => audit_policy += 1,
                AuditProcedure::UserRightsAssignment { .. } => user_rights += 1,
                AuditProcedure::Secedit { .. } => secedit_count += 1,
                AuditProcedure::Manual { description } => {
                    *manual_by_reason.entry(description).or_default() += 1;
                }
            }
        }
        let manual_total: usize = manual_by_reason.values().sum();
        let automated = registry + policy_manager + audit_policy + user_rights + secedit_count;

        use crate::parser::model::Level;
        let l1 = recs.iter().filter(|r| r.level == Level::L1).count();
        let l2 = recs.iter().filter(|r| r.level == Level::L2).count();
        let bl_level = recs.iter().filter(|r| r.level == Level::BL).count();
        let bitlocker = recs.iter().filter(|r| r.bitlocker).count();

        eprintln!("===== {} =====", pdf_path.display());
        eprintln!(
            "recs sliced: {}  |  automated: {automated}  |  manual: {manual_total}",
            recs.len()
        );
        eprintln!("  level: L1={l1} L2={l2} BL={bl_level}  |  bitlocker_tagged={bitlocker}");
        eprintln!(
            "  registry={registry} policy_manager={policy_manager} \
             audit_policy={audit_policy} user_rights={user_rights} \
             secedit={secedit_count}"
        );
        for (reason, count) in &manual_by_reason {
            eprintln!("  MANUAL [{count}]  {reason}");
        }
    }

    #[test]
    #[ignore = "requires dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf on disk"]
    fn classifies_real_pdf_recs() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");
        assert_eq!(recs.len(), 457);

        let mut registry = 0usize;
        let mut policy_manager = 0usize;
        let mut audit_policy = 0usize;
        let mut user_rights = 0usize;
        let mut secedit_count = 0usize;
        let mut manual_unparsed_pm = 0usize;
        let mut manual_unparsed_registry = 0usize;
        let mut manual_unparsed_ap = 0usize;
        let mut manual_unparsed_ura = 0usize;
        let mut manual_unparsed_secedit = 0usize;
        let mut manual_other = 0usize;

        for rec in &recs {
            match audit_procedure(rec) {
                AuditProcedure::Registry { .. } => registry += 1,
                AuditProcedure::PolicyManager { .. } => policy_manager += 1,
                AuditProcedure::AuditPolicy { .. } => audit_policy += 1,
                AuditProcedure::UserRightsAssignment { .. } => user_rights += 1,
                AuditProcedure::Secedit { .. } => secedit_count += 1,
                AuditProcedure::Manual { description } => {
                    if description.contains("PolicyManager body") {
                        manual_unparsed_pm += 1;
                    } else if description.contains("registry body could not be parsed") {
                        manual_unparsed_registry += 1;
                    } else if description.contains("AuditPolicy body") {
                        manual_unparsed_ap += 1;
                    } else if description.contains("URA body") {
                        manual_unparsed_ura += 1;
                    } else if description.contains("Secedit body") {
                        manual_unparsed_secedit += 1;
                    } else {
                        manual_other += 1;
                    }
                }
            }
        }

        eprintln!(
            "classification: registry={registry} \
             policy_manager={policy_manager} \
             audit_policy={audit_policy} \
             user_rights={user_rights} \
             secedit={secedit_count} \
             manual_unparsed_pm={manual_unparsed_pm} \
             manual_unparsed_registry={manual_unparsed_registry} \
             manual_unparsed_ap={manual_unparsed_ap} \
             manual_unparsed_ura={manual_unparsed_ura} \
             manual_unparsed_secedit={manual_unparsed_secedit} \
             manual_other={manual_other}"
        );

        assert_eq!(
            registry + policy_manager + audit_policy + user_rights + secedit_count,
            recs.len(),
            "every recommendation should be cleanly classified"
        );
        assert!(
            registry >= 330,
            "expected at least 330 Registry classifications, got {registry}"
        );
        assert!(
            policy_manager >= 55,
            "expected at least 55 PolicyManager classifications, got {policy_manager}"
        );
        assert_eq!(audit_policy, 27);
        assert_eq!(user_rights, 35);
        assert_eq!(secedit_count, 3);
    }

    #[test]
    #[ignore = "spot-check classifications for the oracle test-case sections"]
    fn inspects_oracle_section_classifications() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        // (id, expected variant per memory). We don't assert against
        // these — this test is for human inspection.
        let oracle = [
            ("1.1", "PolicyManager (Cortana)"),
            ("4.6.8.2", "Registry multi-key, all REG_DWORD=0"),
            ("4.6.11.1", "Registry multi-key REG_SZ"),
            ("4.7.5", "Registry OneOf(Dword(0), Dword(1))"),
            ("4.10.9.1.3", "Registry ContainsAll(4 GUIDs)"),
            ("4.10.19.2", "Registry Absent"),
            ("4.10.20.1.13", "Registry per-key different (should bail)"),
            ("4.11.5.2", "Registry HKU (CurrentUser scope)"),
            ("4.11.28.3.2", "Registry AbsentOr(Equals(Dword(0)))"),
            (
                "4.11.36.4.10.1",
                "Registry All(AtMost(900000), NotEquals(0))",
            ),
            ("38.22", "Registry Str with %SystemRoot% literal"),
        ];

        for (id, expected) in &oracle {
            let line = match recs.iter().find(|rec| rec.id == *id) {
                None => format!("[{id}] NOT FOUND  (expected: {expected})"),
                Some(rec) => format!(
                    "[{id}] {}\n         expected: {expected}",
                    summarize(&audit_procedure(rec))
                ),
            };
            eprintln!("{line}");
        }
    }

    #[test]
    #[ignore = "diagnostic — dumps all PolicyManager rec bodies for pattern review"]
    fn dumps_all_policy_manager_audit_bodies() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        let mut count = 0;
        for rec in &recs {
            let Some(audit) = rec.sections.audit.as_deref() else {
                continue;
            };
            if !audit.contains("_WinningProvider") {
                continue;
            }
            count += 1;
            eprintln!("\n=== [{}] {} ===", rec.id, rec.title);
            eprintln!("{audit}");
        }
        eprintln!("\n--- total PolicyManager recs: {count} ---");
    }

    #[test]
    #[ignore = "diagnostic — dumps all AuditPolicy rec bodies for pattern review"]
    fn dumps_all_audit_policy_bodies() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        let mut count = 0;
        for rec in &recs {
            let Some(audit) = rec.sections.audit.as_deref() else {
                continue;
            };
            if !audit.contains("auditpol /get /subcategory:") {
                continue;
            }
            count += 1;
            eprintln!("\n=== [{}] {} ===", rec.id, rec.title);
            eprintln!("--- audit ---\n{audit}");
            if let Some(desc) = rec.sections.description.as_deref() {
                eprintln!("--- description excerpt ---");
                for line in desc.lines() {
                    if line.contains("recommended state") {
                        eprintln!("{line}");
                    }
                }
            }
        }
        eprintln!("\n--- total AuditPolicy recs: {count} ---");
    }

    #[test]
    #[ignore = "diagnostic — title/audit/remediation for BASELINELENS_IDS; \
                BASELINELENS_TEST_PDF"]
    fn inspect_recs_by_id() {
        let pdf_path = fixture_pdf_path();
        let ids = std::env::var("BASELINELENS_IDS").unwrap_or_default();
        let wanted: Vec<&str> = ids.split(',').map(str::trim).collect();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");
        for rec in &recs {
            if !wanted.contains(&rec.id.as_str()) {
                continue;
            }
            eprintln!("\n===== [{}] {} =====", rec.id, rec.title);
            eprintln!(
                "--AUDIT--\n{}",
                rec.sections.audit.as_deref().unwrap_or("<none>")
            );
            eprintln!(
                "--REMEDIATION--\n{}",
                rec.sections.remediation.as_deref().unwrap_or("<none>")
            );
        }
    }

    #[test]
    #[ignore = "diagnostic — compact manual-fallback summary; BASELINELENS_TEST_PDF"]
    fn summarize_manual_fallbacks() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        let mut by_reason: std::collections::BTreeMap<String, Vec<&_>> =
            std::collections::BTreeMap::new();
        for rec in &recs {
            if let AuditProcedure::Manual { description } = audit_procedure(rec) {
                by_reason.entry(description).or_default().push(rec);
            }
        }
        for (reason, members) in &by_reason {
            eprintln!("\n#### {} ({}) ####", reason, members.len());
            for rec in members {
                let snippet: String = rec
                    .sections
                    .audit
                    .as_deref()
                    .unwrap_or("")
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" | ");
                eprintln!("[{}] {}\n    {}", rec.id, rec.title, snippet);
            }
        }
    }

    #[test]
    #[ignore = "diagnostic — dumps every Manual-fallback rec grouped by reason"]
    fn dumps_all_manual_fallbacks() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        let mut by_reason: std::collections::BTreeMap<String, Vec<&_>> =
            std::collections::BTreeMap::new();
        for rec in &recs {
            if let AuditProcedure::Manual { description } = audit_procedure(rec) {
                by_reason.entry(description).or_default().push(rec);
            }
        }

        for (reason, members) in &by_reason {
            eprintln!(
                "\n############ {} ({} recs) ############",
                reason,
                members.len()
            );
            for rec in members {
                eprintln!("\n--- [{}] {} ---", rec.id, rec.title);
                if let Some(audit) = rec.sections.audit.as_deref() {
                    eprintln!("{audit}");
                }
            }
        }
    }

    #[test]
    #[ignore = "diagnostic — dumps every URA-shaped audit body for pattern review"]
    fn dumps_all_user_rights_assignment_bodies() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        let mut count = 0;
        for rec in &recs {
            // Detect URA candidates: title in 89.x series or audit mentions
            // "User Rights Assignment".
            let is_ura = rec.id.starts_with("89.")
                || rec
                    .sections
                    .audit
                    .as_deref()
                    .map(|audit| audit.contains("User Rights Assignment"))
                    .unwrap_or(false);
            if !is_ura {
                continue;
            }
            count += 1;
            eprintln!("\n=== [{}] {} ===", rec.id, rec.title);
            if let Some(audit) = rec.sections.audit.as_deref() {
                eprintln!("--- audit ---\n{audit}");
            }
        }
        eprintln!("\n--- total URA recs: {count} ---");
    }

    #[test]
    #[ignore = "diagnostic — dumps Secedit + Services rec bodies for pattern review"]
    fn dumps_secedit_and_services_bodies() {
        let pdf_path = fixture_pdf_path();
        let text = pdf::extract(&pdf_path).expect("PDF extraction");
        let recs = structure::slice(&text).expect("slicing");

        for rec in &recs {
            // Secedit (49.x) and Services (81.x).
            if !rec.id.starts_with("49.") && !rec.id.starts_with("81.") {
                continue;
            }
            eprintln!("\n=== [{}] {} ===", rec.id, rec.title);
            if let Some(audit) = rec.sections.audit.as_deref() {
                eprintln!("--- audit ---\n{audit}");
            }
            if let Some(rem) = rec.sections.remediation.as_deref() {
                eprintln!("--- remediation ---\n{rem}");
            }
        }
    }

    fn summarize(procedure: &AuditProcedure) -> String {
        match procedure {
            AuditProcedure::Registry { checks } => {
                let mut summary = format!("Registry [{} key(s)]", checks.len());
                for check in checks {
                    summary.push_str(&format!(
                        "\n           {:?}  {}:{}  expected={:?}",
                        check.scope, check.path, check.value_name, check.expected
                    ));
                }
                summary
            }
            AuditProcedure::Manual { description } => format!("Manual: {description}"),
            other => format!("{other:?}"),
        }
    }
}
