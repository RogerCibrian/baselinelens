//! Spawns `powershell.exe` to execute the audit script and streams its
//! NDJSON output back via callbacks. Two paths:
//!
//! - **In-process pipe** when the app is already elevated. Uses
//!   `CreateProcess` + a piped stdout for a direct read.
//! - **UAC-elevated child** when the app is not elevated. Asks an
//!   unelevated outer PowerShell to `Start-Process -Verb RunAs` the
//!   audit script, with `-OutputPath` pointing at a temp file. The
//!   parent tails that file line-by-line — UAC blocks stdout from
//!   crossing back, so a file is the only practical channel.
//!
//! Both paths run a base64 `-EncodedCommand` bootstrap rather than
//! `-File`-ing the on-disk dispatcher directly. The staged scripts live
//! in a user-writable appdata directory, so an attacker who can write
//! there could otherwise plant code that runs at the elevated integrity
//! level. The bootstrap carries the SHA-256 of each script — derived by
//! this binary from its baked-in copies and delivered over the command
//! line, which a same-box attacker can't forge — and refuses to run a
//! file whose bytes don't match. Encoding the bootstrap sidesteps the
//! nested-quoting hazard of passing a multi-statement `-Command` through
//! `Start-Process -ArgumentList`.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;

use crate::audit::elevation;
use crate::audit::error::AuditError;
use crate::audit::generator::AuditStaging;
use crate::audit::model::{DeviceInfo, ScanRecord};

/// Hard ceiling on a single audit run. Real scans finish in seconds;
/// this only fires when PowerShell is wedged (a blocked cmdlet, a modal
/// stuck behind RunAs) so the app cannot hang forever. Generous enough
/// to cover a slow machine plus the time a user spends at the UAC
/// prompt, since that wait counts against this deadline too.
const SCAN_TIMEOUT: Duration = Duration::from_secs(300);

/// Deadline handed to the audit script itself via `-TimeoutSeconds`.
/// Deliberately longer than `SCAN_TIMEOUT` so the runner reports the
/// timeout first; the script's own check only backstops an elevated
/// child left orphaned after the runner killed the unelevated launcher
/// (a higher-integrity child can't be reaped from here).
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(SCAN_TIMEOUT.as_secs() + 120);

/// One line of the NDJSON stream from the audit script. `Device` is
/// emitted once at the top of the run; `Result` is emitted once per
/// recommendation thereafter. `Fatal` is emitted at most once, by the
/// launcher's `catch`, when the run aborts before producing results
/// (e.g. an integrity-check failure); the read loops turn it into
/// [`AuditError::ScriptFatal`] rather than forwarding it as data.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum AuditEvent {
    Device(DeviceInfo),
    Result(ScanRecord),
    Fatal(FatalEvent),
}

/// Payload of a `{"type":"fatal","message":"..."}` line.
#[derive(Debug, Deserialize)]
pub(crate) struct FatalEvent {
    message: String,
}

/// Runs `script_path` against the baseline JSON at `baseline_path` and
/// forwards each NDJSON line to `on_event` as it arrives. The
/// single-callback shape lets the caller mutate one piece of state
/// (e.g. a `ScanCollector`) without juggling overlapping `FnMut`
/// borrows. Returns when the audit child exits.
/// `cancel_path` is handed to the audit script as `-CancelPath`. The
/// script `break`s its per-rec loop the moment that file appears, so a
/// cancelled run exits cleanly on both the in-process and elevated
/// paths — no process needs to be killed and no elevated child is left
/// finishing in the background. `cancel_scan` requests cancellation by
/// creating the file; the run then resolves to [`AuditError::Cancelled`]
/// and the caller skips persistence.
pub(crate) fn run<F>(
    staging: &AuditStaging,
    baseline_path: &Path,
    cancel_path: &Path,
    on_event: F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let result = if elevation::is_elevated() {
        run_in_process(staging, baseline_path, cancel_path, on_event)
    } else {
        run_elevated_child(staging, baseline_path, cancel_path, on_event)
    };
    // A cancelled run exits 0 (clean loop break), so its status looks
    // like success — the sentinel's existence is the only signal that
    // the user asked to stop, and it reinterprets an otherwise-fine run
    // as cancelled. But ElevationDenied and Spawn mean the scan never
    // ran at all: a cancel is meaningless there, so the real reason must
    // win instead of being masked as a cancel (e.g. a fast double-click
    // that fires a cancel while the UAC prompt is still open).
    match result {
        Err(err @ (AuditError::ElevationDenied | AuditError::Spawn(_))) => {
            let _ = fs::remove_file(cancel_path);
            Err(err)
        }
        other => {
            if cancel_path.exists() {
                let _ = fs::remove_file(cancel_path);
                return Err(AuditError::Cancelled);
            }
            other
        }
    }
}

/// Direct path: spawn `powershell.exe` from this (already-elevated)
/// process and pipe its stdout. Same shape as before the elevation
/// branch was introduced.
fn run_in_process<F>(
    staging: &AuditStaging,
    baseline_path: &Path,
    cancel_path: &Path,
    mut on_event: F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let bootstrap = build_bootstrap(staging, baseline_path, None, cancel_path);
    let mut child = super::powershell_command()
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ])
        .arg(encode_command(&bootstrap))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AuditError::Spawn)?;

    // Stderr must be drained on a side thread so PowerShell never blocks
    // on a full pipe while we're reading stdout. Anything written there
    // is collected for diagnostics in case the child exits non-zero.
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped because we configured Stdio::piped()");
    let stderr_join = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf);
        buf
    });

    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped because we configured Stdio::piped()");
    // Read stdout on a side thread and forward lines over a channel so
    // the main loop can enforce SCAN_TIMEOUT — a blocking `lines()` read
    // has no deadline and would hang here if PowerShell wedged.
    let (tx, rx) = mpsc::channel::<std::io::Result<String>>();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let started = Instant::now();
    let mut event_count = 0usize;
    loop {
        if started.elapsed() >= SCAN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AuditError::Timeout {
                secs: SCAN_TIMEOUT.as_secs(),
            });
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(Ok(line)) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    dispatch_event(parse_event(trimmed)?, &mut on_event)?;
                    event_count += 1;
                }
            }
            Ok(Err(source)) => {
                return Err(AuditError::Io {
                    path: staging.audit.path.clone(),
                    source,
                });
            }
            // Reader hit EOF (PowerShell closed stdout): the run is
            // finishing — reap the exit status below.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    let _ = reader.join();

    let status = child.wait().map_err(AuditError::Spawn)?;
    let stderr_text = stderr_join.join().unwrap_or_default();

    if !status.success() {
        let trimmed = stderr_text.trim();
        return Err(AuditError::NonZeroExit {
            status: status.code().unwrap_or(-1),
            stderr: if trimmed.is_empty() {
                None
            } else {
                Some(stderr_text)
            },
        });
    }
    // Clean exit but nothing emitted: the script started and stopped
    // without producing the device line or any results.
    if event_count == 0 {
        return Err(AuditError::NoOutput);
    }
    Ok(())
}

/// Elevated-child path: spawn an unelevated outer PowerShell that
/// `Start-Process -Verb RunAs` invokes the audit script. The elevated
/// PowerShell writes NDJSON to a temp file (PS `-OutputPath` param);
/// we tail that file from this process. UAC denial surfaces as
/// `AuditError::NonZeroExit` (the outer PS returns non-zero when its
/// `Start-Process -Wait` throws).
fn run_elevated_child<F>(
    staging: &AuditStaging,
    baseline_path: &Path,
    cancel_path: &Path,
    mut on_event: F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let output_path = temp_ndjson_path();
    // Pre-create the file so the tail can open it before the elevated
    // child has spawned. The elevated PS truncates and rewrites on open.
    fs::File::create(&output_path).map_err(|source| AuditError::Io {
        path: output_path.clone(),
        source,
    })?;

    let bootstrap = build_bootstrap(staging, baseline_path, Some(&output_path), cancel_path);
    let ps_command = build_runas_command(&encode_command(&bootstrap));

    let mut outer_child = super::powershell_command()
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Discard stderr — any non-zero exit here is an elevation
        // failure (UAC denied, dismissed, no admin available, etc.),
        // and we surface that with a fixed message rather than the
        // raw PowerShell stack trace. Errors that happen *inside* the
        // elevated child run come back via the NDJSON output file, so
        // we don't lose script-level diagnostics by ignoring stderr.
        .stderr(Stdio::null())
        .spawn()
        .map_err(AuditError::Spawn)?;

    let mut event_count = 0usize;
    let tail_result = {
        let mut counting = |event| {
            event_count += 1;
            on_event(event);
        };
        tail_output_file(&output_path, &mut outer_child, &mut counting)
    };

    // Best-effort cleanup; if it fails (file lock, permission) the next
    // scan reuses a fresh timestamped path anyway.
    let _ = fs::remove_file(&output_path);

    // A non-zero outer exit means `Start-Process -Verb RunAs` itself
    // threw — UAC denied/dismissed or no admin available — since the
    // outer PS returns 0 once the elevated child launches regardless of
    // how that child exits. A zero exit with zero events is the other
    // case: UAC *was* granted but the elevated child wrote nothing
    // (blocked by policy/security software, or it failed to start).
    // That is distinct from a denial, so it carries its own message
    // rather than the admin one.
    match tail_result {
        Ok(()) if event_count == 0 => Err(AuditError::NoOutput),
        Ok(()) => Ok(()),
        Err(AuditError::NonZeroExit { .. }) => Err(AuditError::ElevationDenied),
        Err(other) => Err(other),
    }
}

/// Generates a per-run temp-file path. Process id + millisecond
/// timestamp keep concurrent invocations from colliding even though
/// the UI prevents that today.
fn temp_ndjson_path() -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("baselinelens_audit_{pid}_{stamp}.ndjson"))
}

/// Single-quotes `p` for embedding in a PowerShell string literal.
/// Single-quoted PS strings only need `'` doubled; everything else
/// (backslashes included) is literal.
fn ps_squote(p: &Path) -> String {
    p.to_string_lossy().replace('\'', "''")
}

/// Builds the bootstrap script the elevated (or in-process) PowerShell
/// runs. It verifies each staged script against the digest this binary
/// computed, dot-sources the three helpers in dependency order, then
/// dot-sources the dispatcher with the run's parameters. `output` is
/// `Some` only on the elevated-child path, where the dispatcher writes
/// NDJSON to a file instead of stdout.
///
/// A mismatch makes `Use-BlScript` throw, so a planted script can't run
/// at the elevated integrity level — it aborts the run instead.
fn build_bootstrap(
    staging: &AuditStaging,
    baseline: &Path,
    output: Option<&Path>,
    cancel: &Path,
) -> String {
    let mut audit_args = format!(
        "-BaselinePath '{}' -CancelPath '{}' -TimeoutSeconds {}",
        ps_squote(baseline),
        ps_squote(cancel),
        SCRIPT_TIMEOUT.as_secs(),
    );
    let output_literal = match output {
        Some(output) => {
            audit_args.push_str(&format!(" -OutputPath '{}'", ps_squote(output)));
            ps_squote(output)
        }
        None => String::new(),
    };

    // A failure inside the `try` (a digest mismatch, a baseline that won't
    // load) is written to the output file as a `fatal` line before being
    // re-thrown. That file is the only channel back across the UAC
    // boundary on the elevated path, where the child's stderr is dropped;
    // the in-process path leaves `$BlOutputPath` empty and relies on the
    // re-throw reaching the captured stderr instead.
    //
    // `{{`/`}}` are escaped literal braces; PowerShell sees single braces.
    format!(
        "$ErrorActionPreference='Stop'\n\
         $BlOutputPath='{output_literal}'\n\
         function Use-BlScript {{ param([string]$Path,[string]$Hash)\n\
         $bytes=[System.IO.File]::ReadAllBytes($Path)\n\
         $sha=[System.Security.Cryptography.SHA256]::Create()\n\
         try {{ $computed=($sha.ComputeHash($bytes)|ForEach-Object {{ $_.ToString('x2') }}) -join '' }}\n\
         finally {{ $sha.Dispose() }}\n\
         if ($computed -ne $Hash) {{ throw \"A BaselineLens script file was modified and failed its integrity check: $Path\" }}\n\
         return [scriptblock]::Create([System.Text.Encoding]::UTF8.GetString($bytes)) }}\n\
         try {{\n\
         . (Use-BlScript -Path '{di_path}' -Hash '{di_hash}')\n\
         . (Use-BlScript -Path '{sys_path}' -Hash '{sys_hash}')\n\
         . (Use-BlScript -Path '{reg_path}' -Hash '{reg_hash}')\n\
         . (Use-BlScript -Path '{sec_path}' -Hash '{sec_hash}')\n\
         . (Use-BlScript -Path '{audit_path}' -Hash '{audit_hash}') {audit_args}\n\
         }} catch {{\n\
         if (-not [string]::IsNullOrEmpty($BlOutputPath)) {{\n\
         $err=[ordered]@{{ type='fatal'; message=$_.Exception.Message }} | ConvertTo-Json -Compress\n\
         [System.IO.File]::AppendAllText($BlOutputPath, [Environment]::NewLine + $err + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))\n\
         }}\n\
         throw\n\
         }}\n",
        di_path = ps_squote(&staging.device_info.path),
        di_hash = staging.device_info.sha256,
        sys_path = ps_squote(&staging.system_read.path),
        sys_hash = staging.system_read.sha256,
        reg_path = ps_squote(&staging.registry.path),
        reg_hash = staging.registry.sha256,
        sec_path = ps_squote(&staging.security_policy.path),
        sec_hash = staging.security_policy.sha256,
        audit_path = ps_squote(&staging.audit.path),
        audit_hash = staging.audit.sha256,
    )
}

/// Encodes `bootstrap` for `powershell.exe -EncodedCommand`: UTF-16LE
/// bytes, base64. The encoded form is alphanumeric plus `+/=`, so it
/// carries no quotes or spaces and embeds in a command line or a
/// `Start-Process -ArgumentList` element without any further escaping.
fn encode_command(bootstrap: &str) -> String {
    let utf16: Vec<u8> = bootstrap
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Builds the PowerShell command handed to the outer (unelevated)
/// PowerShell to launch the bootstrap elevated. `encoded` is base64, so
/// the single-quoted `ArgumentList` element needs no escaping.
fn build_runas_command(encoded: &str) -> String {
    format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden \
         -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',\
         '-EncodedCommand','{encoded}')"
    )
}

/// Polls the NDJSON output file for new lines until the outer PS
/// child exits. Reads in chunks, buffers up to the next `\n`, and
/// dispatches one parsed event per complete line.
fn tail_output_file<F>(
    path: &Path,
    outer_child: &mut Child,
    on_event: &mut F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let poll_interval = std::time::Duration::from_millis(150);
    let mut file = fs::File::open(path).map_err(|source| AuditError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut pending = Vec::<u8>::new();
    let mut chunk = vec![0u8; 8 * 1024];
    let started = Instant::now();

    loop {
        drain_available(&mut file, &mut chunk, &mut pending, path)?;
        emit_complete_lines(&mut pending, on_event)?;

        match outer_child.try_wait().map_err(AuditError::Spawn)? {
            Some(status) => {
                // Drain anything written between our last poll and exit.
                drain_available(&mut file, &mut chunk, &mut pending, path)?;
                emit_complete_lines(&mut pending, on_event)?;
                if !status.success() {
                    // Caller re-classifies with stderr text in hand —
                    // we only have the exit code here.
                    return Err(AuditError::NonZeroExit {
                        status: status.code().unwrap_or(-1),
                        stderr: None,
                    });
                }
                return Ok(());
            }
            None => {
                if started.elapsed() >= SCAN_TIMEOUT {
                    // Killing the outer launcher unblocks us; the
                    // elevated grandchild runs at a higher integrity and
                    // can't be reaped from here, so it may linger until
                    // it exits on its own.
                    let _ = outer_child.kill();
                    let _ = outer_child.wait();
                    return Err(AuditError::Timeout {
                        secs: SCAN_TIMEOUT.as_secs(),
                    });
                }
                std::thread::sleep(poll_interval);
            }
        }
    }
}

fn drain_available(
    file: &mut fs::File,
    chunk: &mut [u8],
    pending: &mut Vec<u8>,
    path: &Path,
) -> Result<(), AuditError> {
    loop {
        let n = file.read(chunk).map_err(|source| AuditError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if n == 0 {
            return Ok(());
        }
        pending.extend_from_slice(&chunk[..n]);
    }
}

fn emit_complete_lines<F>(pending: &mut Vec<u8>, on_event: &mut F) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    while let Some(nl) = pending.iter().position(|&b| b == b'\n') {
        let line_bytes: Vec<u8> = pending.drain(..=nl).collect();
        // Drop the trailing \n; trim() then removes any \r and stray
        // whitespace before JSON parsing.
        let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            dispatch_event(parse_event(trimmed)?, on_event)?;
        }
    }
    Ok(())
}

fn parse_event(line: &str) -> Result<AuditEvent, AuditError> {
    serde_json::from_str(line).map_err(|source| AuditError::Ndjson {
        line: line.to_string(),
        source,
    })
}

/// Forwards a parsed line to `on_event`, except a `Fatal` line, which
/// becomes [`AuditError::ScriptFatal`]. Without this the elevated path
/// would see a run that produced no `Result`s and report the generic
/// "no output" error, dropping the reason the script actually gave.
fn dispatch_event<F>(event: AuditEvent, on_event: &mut F) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    match event {
        AuditEvent::Fatal(fatal) => Err(AuditError::ScriptFatal {
            message: fatal.message,
        }),
        event => {
            on_event(event);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::audit::generator::StagedScript;
    use crate::audit::model::Status;

    /// Staging with recognizable paths and digests for the bootstrap
    /// tests. The audit path carries a single quote to exercise escaping.
    fn sample_staging() -> AuditStaging {
        let staged = |path: &str, sha: &str| StagedScript {
            path: PathBuf::from(path),
            sha256: sha.to_string(),
        };
        AuditStaging {
            device_info: staged(r"C:\data\device-info.ps1", "d0"),
            registry: staged(r"C:\data\audit-registry.ps1", "re"),
            security_policy: staged(r"C:\data\audit-security-policy.ps1", "5e"),
            system_read: staged(r"C:\data\audit-system-read.ps1", "55"),
            audit: staged(r"C:\it's\audit_v1.ps1", "a0"),
        }
    }

    /// Decodes an `-EncodedCommand` payload back to its source text:
    /// base64 to bytes, then UTF-16LE to a string.
    fn decode_command(encoded: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).expect("valid UTF-16")
    }

    #[test]
    fn parses_a_result_line_into_a_scan_record() {
        let line = r#"{"type":"result","id":"1.2","status":"Fail","measuredAt":"2025-05-15T12:00:00Z","currentValue":"1","expected":"0","error":null}"#;
        match parse_event(line).expect("parse") {
            AuditEvent::Result(record) => {
                assert_eq!(record.id, "1.2");
                assert_eq!(record.status, Status::Fail);
                // `checks` is absent on this line; it defaults to empty.
                assert!(record.checks.is_empty());
            }
            other => panic!("expected a Result event, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_line_that_is_not_json() {
        assert!(parse_event("not json at all").is_err());
    }

    #[test]
    fn bootstrap_verifies_each_script_against_its_digest() {
        let bootstrap = build_bootstrap(
            &sample_staging(),
            Path::new(r"C:\base.json"),
            Some(Path::new(r"C:\out.ndjson")),
            Path::new(r"C:\cancel"),
        );
        // Every staged script is dot-sourced through the verifying helper,
        // pairing its path with the expected digest.
        assert!(bootstrap.contains(r"-Path 'C:\data\device-info.ps1' -Hash 'd0'"));
        assert!(bootstrap.contains(r"-Path 'C:\data\audit-registry.ps1' -Hash 're'"));
        assert!(bootstrap.contains(r"-Path 'C:\data\audit-security-policy.ps1' -Hash '5e'"));
        assert!(bootstrap.contains(r"-Hash 'a0'"));
        // A mismatch must abort rather than run the planted file.
        assert!(bootstrap.contains("failed its integrity check"));
        // The dispatcher receives the run parameters; -OutputPath is
        // present only on the elevated-child path.
        assert!(bootstrap.contains(r"-BaselinePath 'C:\base.json'"));
        assert!(bootstrap.contains(r"-OutputPath 'C:\out.ndjson'"));
    }

    #[test]
    fn bootstrap_writes_a_fatal_line_to_the_output_file_when_set() {
        let elevated = build_bootstrap(
            &sample_staging(),
            Path::new(r"C:\base.json"),
            Some(Path::new(r"C:\out.ndjson")),
            Path::new(r"C:\cancel"),
        );
        // The elevated path knows its output file and writes a fatal line
        // there on abort, then re-throws.
        assert!(elevated.contains(r"$BlOutputPath='C:\out.ndjson'"));
        assert!(elevated.contains("type='fatal'"));

        // The in-process path has no output file, so the catch writes
        // nothing and leaves the re-throw to reach captured stderr.
        let in_process = build_bootstrap(
            &sample_staging(),
            Path::new(r"C:\base.json"),
            None,
            Path::new(r"C:\cancel"),
        );
        assert!(in_process.contains("$BlOutputPath=''"));
    }

    #[test]
    fn dispatch_turns_a_fatal_line_into_an_error() {
        let fatal = parse_event(r#"{"type":"fatal","message":"boom"}"#).expect("parse");
        let mut seen = 0;
        let result = dispatch_event(fatal, &mut |_| seen += 1);
        assert!(seen == 0, "a fatal line must not be forwarded as data");
        match result {
            Err(AuditError::ScriptFatal { message }) => assert_eq!(message, "boom"),
            other => panic!("expected ScriptFatal, got {other:?}"),
        }
    }

    #[test]
    fn bootstrap_doubles_embedded_single_quotes() {
        let bootstrap = build_bootstrap(
            &sample_staging(),
            Path::new(r"C:\base.json"),
            None,
            Path::new(r"C:\cancel"),
        );
        // The quote in the audit path is doubled so it can't break out of
        // its single-quoted PowerShell literal.
        assert!(bootstrap.contains(r"'C:\it''s\audit_v1.ps1'"));
        // No -OutputPath when the in-process path passes None.
        assert!(!bootstrap.contains("-OutputPath"));
    }

    #[test]
    fn encoded_command_round_trips_through_utf16_base64() {
        let bootstrap = build_bootstrap(
            &sample_staging(),
            Path::new(r"C:\base.json"),
            None,
            Path::new(r"C:\cancel"),
        );
        assert_eq!(decode_command(&encode_command(&bootstrap)), bootstrap);
    }

    #[test]
    fn runas_command_wraps_the_encoded_bootstrap() {
        let cmd = build_runas_command("QUJD");
        assert!(cmd.contains("-Verb RunAs"));
        assert!(cmd.contains("'-EncodedCommand','QUJD'"));
    }
}
