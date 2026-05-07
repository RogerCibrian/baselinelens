//! Data types parsed from a hardening baseline PDF.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Top-level
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub source: BaselineSource,
    pub categories: Vec<Category>,
    pub recommendations: Vec<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BaselineSource {
    pub benchmark_name: String,
    pub benchmark_version: String,
    pub pdf_filename: String,
    pub pdf_sha256: String,
    pub parsed_at: DateTime<Utc>,
    pub parser_version: String,
}

// ============================================================================
// Recommendations and categories
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub level: Level,
    pub category_number: String,
    pub title: String,
    pub description: String,
    pub rationale: Option<String>,
    pub impact: Option<String>,
    pub assessment: Assessment,
    pub audit: AuditProcedure,
    pub remediation: Option<Remediation>,
    pub references: Vec<Reference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum Level {
    L1,
    L2,
    BL,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum Assessment {
    Automated,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Remediation {
    pub description: String,
    pub settings_catalog_path: Option<String>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum Reference {
    Url { url: String },
    Note { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub number: String,
    pub name: String,
    pub parent: Option<String>,
}

// ============================================================================
// Audit procedure
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum AuditProcedure {
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
    },

    /// Account Policies / Security Options (audited via secedit /export).
    Secedit {
        section: SeceditSection,
        setting: String,
        expected: ExpectedValue,
    },

    /// Audit subcategory via auditpol /get /subcategory:"{GUID}".
    AuditPolicy {
        subcategory_guid: String,
        expected: AuditPolicyMode,
    },

    /// No automated audit available.
    Manual { description: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RegistryCheck {
    pub path: String,
    pub value_name: String,
    pub expected: ExpectedValue,
    pub scope: RegistryScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum RegistryScope {
    /// HKLM — applies to the machine.
    Machine,
    /// HKU\[USER SID]\... — applies to the currently-logged-in user only.
    CurrentUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum PolicyScope {
    Device,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum SeceditSection {
    /// Account Policies (Rename Guest, password policy, etc.).
    SystemAccess,
    /// Security Options exposed via UI but no separate registry path.
    RegistryValues,
    /// System Services.
    Service,
    /// Escape hatch for sections we encounter outside the above.
    Other { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum AuditPolicyMode {
    NoAuditing,
    Success,
    Failure,
    SuccessAndFailure,
}

// ============================================================================
// Expected values and principals
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ExpectedValue {
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
pub enum Value {
    Dword { value: u32 },
    QDword { value: i64 },
    Str { value: String },
    MultiStr { values: Vec<String> },
    Binary { bytes: Vec<u8> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub identifier: String,
    pub kind: PrincipalKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum PrincipalKind {
    Sid,
    WellKnownName,
    AccountName,
}
