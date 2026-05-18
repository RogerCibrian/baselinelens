//! Audit pipeline: writes the static `audit.ps1` to disk, spawns
//! `powershell.exe` to execute it against a parsed `Baseline` JSON, and
//! merges the streamed NDJSON results into a `Scan`.

pub(crate) mod elevation;
pub(crate) mod error;
pub(crate) mod generator;
pub(crate) mod merge;
pub(crate) mod model;
pub(crate) mod runner;

/// Schema version of the audit script. Bumped whenever `ps/audit.ps1` or
/// the output contract changes in a way that should invalidate the
/// cached `.ps1` file on a user's machine — the script path embeds this
/// number so a bump produces a fresh cache entry automatically.
pub(crate) const AUDIT_SCRIPT_VERSION: &str = "3";
