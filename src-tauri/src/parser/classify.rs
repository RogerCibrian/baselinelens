//! Variant detection: maps a raw recommendation's audit body to an
//! `AuditProcedure` variant.

mod registry;

use crate::parser::model::AuditProcedure;
use crate::parser::structure::RawRecommendation;

/// Returns the appropriate `AuditProcedure` variant for this recommendation.
///
/// Cues are checked in priority order so that recs whose body happens to
/// contain `HKLM\` for incidental reasons (PolicyManager's WinningProvider
/// lookup) don't get mis-classified as Registry. Anything we don't yet
/// recognize falls through to a `Manual` variant whose description names
/// the reason.
pub(crate) fn audit_procedure(rec: &RawRecommendation) -> AuditProcedure {
    let Some(body) = rec.sections.audit.as_deref() else {
        return manual("missing audit section");
    };

    // PolicyManager recs also contain `HKLM\` paths, so we have to disambiguate
    // before falling into the registry branch.
    if body.contains("_WinningProvider") {
        return manual("PolicyManager variant (not yet implemented)");
    }

    if body.contains("HKLM\\") || body.contains("HKU\\") {
        if let Some(procedure) = registry::try_parse(body) {
            return procedure;
        }
        return manual("registry body could not be parsed");
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
        let mut manual_pm = 0usize;
        let mut manual_other = 0usize;
        let mut manual_unparsed_registry = 0usize;
        let mut other_variants = 0usize;

        for rec in &recs {
            match audit_procedure(rec) {
                AuditProcedure::Registry { .. } => registry += 1,
                AuditProcedure::Manual { description } => {
                    if description.contains("PolicyManager") {
                        manual_pm += 1;
                    } else if description.contains("registry body could not be parsed") {
                        manual_unparsed_registry += 1;
                    } else {
                        manual_other += 1;
                    }
                }
                _ => other_variants += 1,
            }
        }

        eprintln!(
            "classification: registry={registry} \
             manual_policy_manager={manual_pm} \
             manual_unparsed_registry={manual_unparsed_registry} \
             manual_other={manual_other} \
             other_variants={other_variants}"
        );

        // Conservative floor: most Registry recs (memory-noted ~337) should
        // classify cleanly with the v1 expected-value patterns.
        assert!(
            registry >= 200,
            "expected at least 200 Registry classifications, got {registry}"
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
