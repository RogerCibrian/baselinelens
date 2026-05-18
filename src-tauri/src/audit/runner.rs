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

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::audit::elevation;
use crate::audit::error::AuditError;
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
/// recommendation thereafter.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum AuditEvent {
    Device(DeviceInfo),
    Result(ScanRecord),
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
    script_path: &Path,
    baseline_path: &Path,
    cancel_path: &Path,
    on_event: F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let result = if elevation::is_elevated() {
        run_in_process(script_path, baseline_path, cancel_path, on_event)
    } else {
        run_elevated_child(script_path, baseline_path, cancel_path, on_event)
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
    script_path: &Path,
    baseline_path: &Path,
    cancel_path: &Path,
    mut on_event: F,
) -> Result<(), AuditError>
where
    F: FnMut(AuditEvent),
{
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script_path)
        .arg("-BaselinePath")
        .arg(baseline_path)
        .arg("-CancelPath")
        .arg(cancel_path)
        .arg("-TimeoutSeconds")
        .arg(SCRIPT_TIMEOUT.as_secs().to_string())
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
                    on_event(parse_event(trimmed)?);
                    event_count += 1;
                }
            }
            Ok(Err(source)) => {
                return Err(AuditError::Io {
                    path: script_path.to_path_buf(),
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
    script_path: &Path,
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

    let ps_command = build_runas_command(script_path, baseline_path, &output_path, cancel_path);

    let mut outer_child = Command::new("powershell.exe")
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

/// Builds the PowerShell command we hand to the outer (unelevated)
/// PowerShell to launch the audit script elevated. The arguments are
/// passed as a list to `Start-Process` so PowerShell handles the
/// quoting through `ShellExecuteEx` without our format string having
/// to escape per-platform shell metacharacters.
fn build_runas_command(script: &Path, baseline: &Path, output: &Path, cancel: &Path) -> String {
    fn ps_squote(p: &Path) -> String {
        // Single-quoted PS strings only need `'` doubled; everything else
        // is literal, including backslashes.
        p.to_string_lossy().replace('\'', "''")
    }
    let script_q = ps_squote(script);
    let baseline_q = ps_squote(baseline);
    let output_q = ps_squote(output);
    let cancel_q = ps_squote(cancel);
    let timeout_secs = SCRIPT_TIMEOUT.as_secs();
    format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden \
         -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',\
         '-File','{script_q}','-BaselinePath','{baseline_q}','-OutputPath','{output_q}',\
         '-CancelPath','{cancel_q}','-TimeoutSeconds','{timeout_secs}')"
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
            on_event(parse_event(trimmed)?);
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
