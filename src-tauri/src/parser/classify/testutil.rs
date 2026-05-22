//! Shared fixture builder for classifier unit tests.

use crate::parser::model::{Assessment, Level};
use crate::parser::structure::{BodySections, RawRecommendation};

/// Builds a `RawRecommendation` with stock metadata (`test` id, L1,
/// non-BitLocker, Automated) plus the given title and body sections, so
/// each classifier test only spells out the parts it actually exercises.
pub(super) fn rec(title: &str, sections: BodySections) -> RawRecommendation {
    RawRecommendation {
        id: "test".to_string(),
        level: Level::L1,
        bitlocker: false,
        assessment: Assessment::Automated,
        title: title.to_string(),
        sections,
    }
}
