//! Audit pipeline: writes the static `audit.ps1` to disk, spawns
//! `powershell.exe` to execute it against a parsed `Baseline` JSON, and
//! merges the streamed NDJSON results into a `Scan`.

use std::process::Command;

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
pub(crate) const AUDIT_SCRIPT_VERSION: u32 = 2;

/// Builds a `Command` for `powershell.exe` with its console window
/// suppressed on Windows. The GUI app owns no console, so a plain spawn
/// pops a separate `powershell.exe` window in front of the dashboard;
/// `CREATE_NO_WINDOW` keeps the child windowless. A plain spawn on
/// non-Windows dev builds, where these scripts don't run.
pub(crate) fn powershell_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("powershell.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new("powershell.exe")
    }
}
