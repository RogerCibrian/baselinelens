# BaselineLens audit helper: reads registry values the elevated audit
# process is denied, by escalating the read to the SYSTEM account.
#
# A few keys -- notably the Defender 'Policy Manager' CSP store -- are ACL'd
# so only SYSTEM may read them; an elevated administrator gets a
# SecurityException. Get-RegValue (audit-registry.ps1) falls back to here
# when that happens. Dot-sourced by audit.ps1, so this runs in the caller's
# already-elevated scope.
#
# This runs the most privileged code in the audit, so the hardening is
# deliberate:
#   - The task action is an inline -EncodedCommand built here in the trusted
#     elevated process. No script file is written for a non-administrator to
#     swap between staging and run -- the TOCTOU that would otherwise be a
#     SYSTEM remote-code-execution hole.
#   - powershell.exe is launched by full path, so a planted powershell.exe on
#     the search path cannot run as SYSTEM in its place.
#   - The key path is passed as data (single-quote escaped, read with
#     -LiteralPath), never interpolated as code.
#   - The result is written under %SystemRoot%\Temp, which standard users
#     cannot write, so a non-administrator cannot forge the read result.
#   - The task is given a random name, run once, and removed in a finally.

# One cache entry per key path: the values read as SYSTEM. A whole family of
# checks under the same key (the entire Defender 'Policy Manager' set) costs
# a single escalation.
$script:system_reg_cache = @{}

# Full path so a planted powershell.exe on PATH cannot run as SYSTEM here.
$script:system_powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Returns the value of $Name under $Path, read as SYSTEM. Returns $null when
# the key was read but has no such value (so an unset policy reads as absent,
# which the caller treats as non-compliant). Throws when the escalation
# itself fails, so a read failure surfaces as an Error rather than being
# mistaken for an absent value.
function Get-SystemRegValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )
    if (-not $script:system_reg_cache.ContainsKey($Path)) {
        $script:system_reg_cache[$Path] = Read-RegKeyAsSystem $Path
    }
    $values = $script:system_reg_cache[$Path]
    if ($null -eq $values) {
        throw "SYSTEM registry read failed for $Path"
    }
    if ($values.ContainsKey($Name)) {
        return $values[$Name]
    }
    return $null
}

# Reads every value of one key as SYSTEM via a one-shot scheduled task.
# Returns a hashtable of name -> value (empty when the key has no values),
# or $null when the escalation failed.
function Read-RegKeyAsSystem {
    param([Parameter(Mandatory)][string]$Path)

    $token    = [guid]::NewGuid().ToString('N')
    $outFile  = Join-Path $env:SystemRoot ("Temp\baselinelens-{0}.json" -f $token)
    $taskName = "BaselineLens-SysRead-$token"
    $safePath = $Path -replace "'", "''"

    # Inlined so there is no on-disk script for a non-administrator to swap.
    # $safePath/$outFile are baked in now; the reader's own variables are
    # backtick-escaped so they survive into the SYSTEM script.
    $reader = @"
`$ErrorActionPreference = 'Stop'
`$skip = 'PSPath','PSParentPath','PSChildName','PSDrive','PSProvider'
try {
    `$values = @{}
    `$props = Get-ItemProperty -LiteralPath '$safePath'
    foreach (`$p in `$props.PSObject.Properties) {
        if (`$skip -notcontains `$p.Name) { `$values[`$p.Name] = `$p.Value }
    }
    @{ ok = `$true; values = `$values } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '$outFile' -Encoding Unicode
} catch {
    @{ ok = `$false; error = `$_.Exception.GetType().FullName } | ConvertTo-Json | Set-Content -LiteralPath '$outFile' -Encoding Unicode
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($reader))

    try {
        $action = New-ScheduledTaskAction -Execute $script:system_powershell `
            -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
        $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest -LogonType ServiceAccount
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

        # Poll for a complete result rather than sleeping a fixed time:
        # Set-Content is not atomic, so a partial file fails to parse and we
        # keep waiting until it parses or the deadline passes.
        $deadline = (Get-Date).AddSeconds(30)
        $parsed = $null
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $outFile) {
                try { $parsed = Get-Content -LiteralPath $outFile -Raw | ConvertFrom-Json; break } catch {}
            }
            Start-Sleep -Milliseconds 250
        }

        if ($null -eq $parsed -or -not $parsed.ok) { return $null }

        $result = @{}
        if ($parsed.values) {
            foreach ($prop in $parsed.values.PSObject.Properties) { $result[$prop.Name] = $prop.Value }
        }
        return $result
    } catch {
        return $null
    } finally {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    }
}
