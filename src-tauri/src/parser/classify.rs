//! Variant detection: maps a raw recommendation's audit body to an
//! `AuditProcedure` variant.

mod audit_policy;
mod expected;
mod path;
mod policy_manager;
mod registry;
mod secedit;
mod user_rights_assignment;

use crate::parser::model::AuditProcedure;
use crate::parser::structure::RawRecommendation;

/// Returns the appropriate `AuditProcedure` variant for this recommendation.
///
/// HKLM/HKU paths are extracted once via the shared `path` module; if any of
/// them is a `_WinningProvider` lookup the rec is routed to PolicyManager,
/// otherwise to Registry. Anything we don't yet recognize falls through to a
/// `Manual` variant whose description names the reason.
pub(crate) fn audit_procedure(rec: &RawRecommendation) -> AuditProcedure {
    let Some(body) = rec.sections.audit.as_deref() else {
        return manual("missing audit section");
    };

    let paths = path::extract_all(body);

    if paths
        .iter()
        .any(|joined| joined.value_name.ends_with("_WinningProvider"))
    {
        if let Some(procedure) = policy_manager::try_parse(body, &paths) {
            return procedure;
        }
        return manual("PolicyManager body could not be parsed");
    }

    if !paths.is_empty() {
        if let Some(procedure) = registry::try_parse(body, &paths) {
            return procedure;
        }
        return manual("registry body could not be parsed");
    }

    if body.contains("auditpol /get /subcategory:") {
        if let Some(procedure) = audit_policy::try_parse(body, &rec.title) {
            return procedure;
        }
        return manual("AuditPolicy body could not be parsed");
    }

    if rec
        .sections
        .remediation
        .as_deref()
        .map(|remediation| remediation.contains("User Rights\\"))
        .unwrap_or(false)
    {
        if let Some(procedure) = user_rights_assignment::try_parse(rec) {
            return procedure;
        }
        return manual("URA body could not be parsed");
    }

    if rec
        .sections
        .remediation
        .as_deref()
        .map(|remediation| remediation.contains("Local Policies Security Options\\"))
        .unwrap_or(false)
    {
        if let Some(procedure) = secedit::try_parse(rec) {
            return procedure;
        }
        return manual("Secedit body could not be parsed");
    }

    manual("unhandled audit body shape")
}

fn manual(reason: &str) -> AuditProcedure {
    AuditProcedure::Manual {
        description: format!("Automated parser fell back to manual: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{pdf, structure};

    #[test]
    #[ignore = "requires dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf on disk"]
    fn classifies_real_pdf_recs() {
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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

        assert!(
            registry >= 200,
            "expected at least 200 Registry classifications, got {registry}"
        );
        assert!(
            policy_manager >= 30,
            "expected at least 30 PolicyManager classifications, got {policy_manager}"
        );
        assert!(
            audit_policy >= 25,
            "expected at least 25 AuditPolicy classifications, got {audit_policy}"
        );
        assert!(
            user_rights >= 30,
            "expected at least 30 URA classifications, got {user_rights}"
        );
        assert!(
            secedit_count >= 3,
            "expected at least 3 Secedit classifications, got {secedit_count}"
        );
    }

    #[test]
    #[ignore = "spot-check classifications for the oracle test-case sections"]
    fn inspects_oracle_section_classifications() {
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
            ("4.11.36.4.10.1", "Registry All(AtMost(900000), NotEquals(0))"),
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
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
    #[ignore = "diagnostic — dumps every Manual-fallback rec grouped by reason"]
    fn dumps_all_manual_fallbacks() {
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
            eprintln!("\n############ {} ({} recs) ############", reason, members.len());
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
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
        let pdf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../dev/CIS_Microsoft_Intune_for_Windows_11_Benchmark_v4.0.0.pdf");
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
