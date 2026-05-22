//! Data types parsed from a hardening baseline PDF.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Top-level
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Baseline {
    pub(crate) source: BaselineSource,
    pub(crate) categories: Vec<Category>,
    pub(crate) recommendations: Vec<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaselineSource {
    pub(crate) benchmark_name: String,
    pub(crate) benchmark_version: String,
    pub(crate) pdf_filename: String,
    pub(crate) pdf_sha256: String,
    pub(crate) parsed_at: DateTime<Utc>,
    pub(crate) parser_version: u32,
}

// ============================================================================
// Recommendations and categories
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recommendation {
    pub(crate) id: String,
    pub(crate) level: Level,
    /// True when the recommendation's CIS profile is BitLocker-related.
    /// Independent of `level`: a BitLocker rec may carry `Level::BL` or a
    /// base level with this flag set. `#[serde(default)]` lets a cache
    /// written before this field deserialize (as stale) so the re-parse
    /// prompt fires instead of a hard load error.
    #[serde(default)]
    pub(crate) bitlocker: bool,
    pub(crate) category_number: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) rationale: Option<String>,
    pub(crate) impact: Option<String>,
    pub(crate) assessment: Assessment,
    pub(crate) audit: AuditProcedure,
    pub(crate) remediation: Option<Remediation>,
    pub(crate) references: Vec<Reference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub(crate) enum Level {
    L1,
    L2,
    BL,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum Assessment {
    Automated,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remediation {
    pub(crate) description: String,
    pub(crate) settings_catalog_path: Option<String>,
    pub(crate) default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub(crate) enum Reference {
    Url { url: String },
    Note { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Category {
    pub(crate) number: String,
    pub(crate) name: String,
    pub(crate) parent: Option<String>,
}

// ============================================================================
// Audit procedure
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub(crate) enum AuditProcedure {
    /// One or more registry checks; ALL must pass.
    Registry { checks: Vec<RegistryCheck> },

    /// Intune MDM PolicyManager (two-step WinningProvider lookup).
    PolicyManager {
        scope: PolicyScope,
        area: String,
        setting: String,
        expected: ExpectedValue,
    },

    /// User Rights Assignment (audited via secedit /export → [Privilege Rights]).
    UserRightsAssignment {
        right_name: String,
        expected: Vec<Principal>,
        matching: MatchMode,
    },

    /// Account Policies / Security Options (audited via secedit /export
    /// against the `[System Access]` INI section).
    Secedit {
        setting: String,
        expected: ExpectedValue,
    },

    /// Audit subcategory via auditpol /get /subcategory:"{GUID}".
    AuditPolicy {
        subcategory_guid: String,
        expected: AuditPolicyMode,
        matching: MatchMode,
    },

    /// No automated audit available.
    Manual { description: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryCheck {
    pub(crate) path: String,
    pub(crate) value_name: String,
    pub(crate) expected: ExpectedValue,
    pub(crate) scope: RegistryScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum RegistryScope {
    /// HKLM — applies to the machine.
    Machine,
    /// HKU\[USER SID]\... — applies to the currently-logged-in user only.
    CurrentUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum PolicyScope {
    Device,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum AuditPolicyMode {
    NoAuditing,
    Success,
    Failure,
    SuccessAndFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum MatchMode {
    /// Title says `is set to 'X'` — actual must equal `X` exactly.
    Exact,
    /// Title says `is set to include 'X'` / `to include 'X'` — actual must
    /// contain `X` (so e.g. URA principals can be a superset, AuditPolicy
    /// `Success` recs pass when actual is `SuccessAndFailure`).
    Includes,
}

// ============================================================================
// Expected values and principals
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub(crate) enum ExpectedValue {
    Equals { value: Value },
    NotEquals { value: Value },
    AtLeast { value: i64 },
    AtMost { value: i64 },
    OneOf { values: Vec<Value> },
    Contains { substring: String },
    ContainsAll { substrings: Vec<String> },
    Absent,
    AbsentOr { inner: Box<ExpectedValue> },
    All { values: Vec<ExpectedValue> },
    Any { values: Vec<ExpectedValue> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub(crate) enum Value {
    Dword { value: u32 },
    QDword { value: i64 },
    Str { value: String },
    MultiStr { values: Vec<String> },
    Binary { bytes: Vec<u8> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Principal {
    pub(crate) identifier: String,
    pub(crate) kind: PrincipalKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) enum PrincipalKind {
    Sid,
    WellKnownName,
    AccountName,
}
