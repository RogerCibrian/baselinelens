# BaselineLens audit script.
#
# Generic dispatcher -- the same script runs against any baseline. Reads
# a parsed Baseline JSON from -BaselinePath, walks each recommendation,
# dispatches by AuditProcedure variant, and emits NDJSON on stdout.
#
# Output contract: NDJSON line shapes, discriminated by `type`:
#   { "type": "device", "hostname": "...", "osName": "...", ... }   (once)
#   { "type": "result", "id": "1.2.3", "status": "Pass", ... }      (per rec)

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaselinePath,
    # Optional NDJSON output sink. When set, every line is written (with
    # autoflush) to this file instead of stdout. Used by the
    # elevated-child code path in the Rust runner, where stdout can't be
    # piped back across the UAC boundary.
    [string]$OutputPath,
    # Optional cooperative-cancel sentinel. When set, the per-rec loop
    # checks for this file before each recommendation and stops cleanly
    # the moment it appears. The Rust runner creates it on a cancel
    # request -- this avoids killing the (possibly elevated) child, which
    # an unelevated parent can't do reliably.
    [string]$CancelPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Dot-source the shared device-info reader so the same logic feeds both
# this scan and the onboarding 'Will scan' strip. Rust writes both .ps1
# files to the same directory before invoking us.
. (Join-Path $PSScriptRoot 'device-info.ps1')

# Lazy-opened sink used when -OutputPath is set. AutoFlush=true so the
# Rust parent can tail the file line-by-line as recs complete instead of
# waiting for the whole scan to finish.
$script:out_stream = if ([string]::IsNullOrEmpty($OutputPath)) {
    $null
} else {
    $sw = [System.IO.StreamWriter]::new($OutputPath, $false, [System.Text.UTF8Encoding]::new($false))
    $sw.AutoFlush = $true
    $sw
}

function Emit-Line {
    param([Parameter(Mandatory)][string]$Line)
    if ($null -ne $script:out_stream) {
        $script:out_stream.WriteLine($Line)
    } else {
        $Line | Write-Output
    }
}

# ============================================================================
# Output helpers
# ============================================================================

function Write-NdjsonResult {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][ValidateSet('Pass', 'Fail', 'Manual', 'Error')][string]$Status,
        [string]$CurrentValue,
        [string]$Expected,
        [string]$ErrorMessage,
        $Checks
    )
    $payload = [ordered]@{
        type       = 'result'
        id         = $Id
        status     = $Status
        measuredAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($PSBoundParameters.ContainsKey('CurrentValue')) { $payload['currentValue'] = $CurrentValue }
    if ($PSBoundParameters.ContainsKey('Expected'))     { $payload['expected']     = $Expected }
    if ($PSBoundParameters.ContainsKey('ErrorMessage')) { $payload['error']        = $ErrorMessage }
    # `-Checks` is the structured per-check breakdown -- wrap in @() so a
    # single-element collection still serializes as a JSON array.
    if ($PSBoundParameters.ContainsKey('Checks'))       { $payload['checks']       = @($Checks) }
    $json = $payload | ConvertTo-Json -Compress -Depth 6
    Emit-Line -Line $json
}

# Emits the NDJSON device line by wrapping Get-BlDeviceInfo (defined in
# device-info.ps1) with the 'type' discriminator the Rust runner expects.
function Write-NdjsonDevice {
    $info = Get-BlDeviceInfo
    $payload = [ordered]@{ type = 'device' }
    foreach ($key in $info.Keys) { $payload[$key] = $info[$key] }
    Emit-Line -Line ($payload | ConvertTo-Json -Compress -Depth 4)
}

# ============================================================================
# Registry read
# ============================================================================

# Reads a single registry value, returning $null when either the key path
# or the value name is missing. Other failures (access denied, etc.) bubble
# up so the per-rec catch block can classify them.
function Get-RegValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )
    try {
        return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name
    } catch [System.Management.Automation.ItemNotFoundException], [System.Management.Automation.PSArgumentException] {
        return $null
    }
}

# Authoritative Entra/Azure AD tenant ID for this device. Some policy
# keys (e.g. PassportForWork) live under a per-tenant GUID subkey that
# the benchmark writes as a '<Tenant-ID>' placeholder. Resolved from the
# device's join record rather than trusting whatever subkey happens to
# exist. Cached (incl. a negative result) since it's stable per scan.
$script:tenant_id = $null
$script:tenant_id_resolved = $false
function Resolve-TenantId {
    if ($script:tenant_id_resolved) { return $script:tenant_id }
    $script:tenant_id_resolved = $true

    # Primary: the CloudDomainJoin record -- the same data dsregcmd
    # surfaces, one subkey per join cert thumbprint.
    try {
        $join_info = 'HKLM:\SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo'
        if (Test-Path -LiteralPath $join_info) {
            foreach ($sub in Get-ChildItem -LiteralPath $join_info -ErrorAction Stop) {
                $tid = (Get-ItemProperty -LiteralPath $sub.PSPath -Name 'TenantId' -ErrorAction SilentlyContinue).TenantId
                if (-not [string]::IsNullOrWhiteSpace($tid)) {
                    $script:tenant_id = $tid
                    return $tid
                }
            }
        }
    } catch {
        # Fall through to dsregcmd.
    }

    # Fallback: dsregcmd /status. The 'TenantId' field name is not
    # localized, so the match is stable across UI languages.
    try {
        $status = & dsregcmd.exe /status 2>$null
        $match = $status | Select-String -Pattern 'TenantId\s*:\s*([0-9A-Fa-f-]{36})'
        if ($match) {
            $script:tenant_id = $match.Matches[0].Groups[1].Value
            return $script:tenant_id
        }
    } catch {
        # No authoritative source available.
    }
    return $null
}

# Resolves a registry check path before reading it. Returns a hashtable
# with 'kind':
#   'ok'    -> 'path' holds the concrete, readable path
#   'fail'  -> a required '<Tenant-ID>' couldn't be resolved, so the
#              per-tenant policy can't be confirmed (a real Fail, not an
#              automation gap)
#   'error' -> an unsupported placeholder or an unparseable path; the
#              rec is reported Error with 'reason'
function Resolve-CheckPath {
    param([Parameter(Mandatory)][string]$Path)
    $resolved = $Path
    foreach ($ph in [regex]::Matches($Path, '<[^>]+>')) {
        $token = $ph.Value
        $norm = ($token.Trim('<', '>') -replace '[\s_-]', '').ToLowerInvariant()
        if ($norm -eq 'tenantid') {
            $tid = Resolve-TenantId
            if ([string]::IsNullOrWhiteSpace($tid)) {
                return @{
                    kind   = 'fail'
                    reason = 'Entra tenant ID could not be determined; per-tenant policy cannot be confirmed'
                }
            }
            $resolved = $resolved.Replace($token, $tid)
        } else {
            return @{
                kind   = 'error'
                reason = "Unsupported registry path placeholder $token"
            }
        }
    }
    if ($resolved -notmatch '^HK(LM|U)\\' -or $resolved -match '[:<>]') {
        return @{
            kind   = 'error'
            reason = 'Registry path could not be parsed'
        }
    }
    return @{ kind = 'ok'; path = $resolved }
}

# ============================================================================
# System-state caches
# ============================================================================

# secedit /export dumps the local security policy to an INI file. We run
# it once per scan and parse into a section -> key -> value hashtable. Both
# success and failure are cached: on elevation denial the first
# secedit-using rec records the error, and every subsequent rec re-throws
# immediately instead of re-spawning secedit.
$script:secedit_cache = $null
$script:secedit_error = $null

function Get-SeceditExport {
    if ($null -ne $script:secedit_error) { throw $script:secedit_error }
    if ($null -ne $script:secedit_cache) { return $script:secedit_cache }

    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath 'secedit.exe' `
            -ArgumentList @('/export', '/cfg', $tmp, '/quiet') `
            -Wait -PassThru -NoNewWindow -ErrorAction Stop
        if ($proc.ExitCode -ne 0) {
            throw [System.UnauthorizedAccessException]::new(
                "secedit /export exited with code $($proc.ExitCode); typically means administrator is required"
            )
        }
        # secedit writes the INI as little-endian UTF-16.
        $lines = Get-Content -LiteralPath $tmp -Encoding Unicode -ErrorAction Stop
        $cache = @{}
        $current_section = $null
        foreach ($raw_line in $lines) {
            $line = $raw_line.Trim()
            if ($line -eq '' -or $line.StartsWith(';')) { continue }
            if ($line.StartsWith('[') -and $line.EndsWith(']')) {
                $current_section = $line.Substring(1, $line.Length - 2)
                if (-not $cache.ContainsKey($current_section)) {
                    $cache[$current_section] = @{}
                }
                continue
            }
            if ($null -eq $current_section) { continue }
            $eq_idx = $line.IndexOf('=')
            if ($eq_idx -lt 0) { continue }
            $key = $line.Substring(0, $eq_idx).Trim()
            $val = $line.Substring($eq_idx + 1).Trim()
            $cache[$current_section][$key] = $val
        }
        $script:secedit_cache = $cache
        return $cache
    } catch {
        $script:secedit_error = $_.Exception
        throw
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

# auditpol /get /category:* /r dumps every subcategory's audit setting
# as CSV, including the subcategory's display name. Keyed by GUID (the
# stable, locale-independent identifier the benchmark references) to a
# { Name; Setting } pair so checks can show the readable name instead
# of the GUID. Same caching pattern as secedit.
$script:auditpol_cache = $null
$script:auditpol_error = $null

function Get-AuditPolDump {
    if ($null -ne $script:auditpol_error) { throw $script:auditpol_error }
    if ($null -ne $script:auditpol_cache) { return $script:auditpol_cache }

    try {
        $csv_text = & auditpol.exe /get /category:* /r 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw [System.UnauthorizedAccessException]::new(
                "auditpol /get exited with code ${LASTEXITCODE}; typically means administrator is required"
            )
        }
        $cache = @{}
        foreach ($row in ($csv_text | ConvertFrom-Csv)) {
            $guid = $row.'Subcategory GUID'
            if ($null -ne $guid -and $guid -ne '') {
                $cache[$guid] = [ordered]@{
                    Name    = $row.'Subcategory'
                    Setting = $row.'Inclusion Setting'
                }
            }
        }
        $script:auditpol_cache = $cache
        return $cache
    } catch {
        $script:auditpol_error = $_.Exception
        throw
    }
}

# ============================================================================
# Principal resolution
# ============================================================================

# Resolves a principal identifier (raw SID, well-known name, or
# DOMAIN\Account form) to its SID string. Returns $null when the
# identifier can't be resolved on this device -- the URA comparison
# treats that as "missing from the actual set."
function Resolve-PrincipalToSid {
    param([Parameter(Mandatory)][string]$Identifier)
    if ($Identifier -match '^S-\d-\d+(-\d+)*$') { return $Identifier }
    try {
        $account = New-Object System.Security.Principal.NTAccount($Identifier)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

# Resolves a SID string back to a readable account name (e.g.
# `BUILTIN\Administrators`) for display. Falls back to the raw SID when
# the account can't be translated on this device -- still informative,
# just less friendly.
function Resolve-SidToName {
    param([Parameter(Mandatory)][string]$Sid)
    try {
        $obj = New-Object System.Security.Principal.SecurityIdentifier($Sid)
        return $obj.Translate([System.Security.Principal.NTAccount]).Value
    } catch {
        return $Sid
    }
}

# Returns the SID strings assigned to a Privilege Rights entry in the
# secedit export. Raw form is `*S-1-5-32-544,*S-1-5-32-545`; the leading
# asterisks mark SID literals and are stripped. A missing entry (right
# unconfigured) returns an empty array.
function Get-PrivilegeSids {
    param([Parameter(Mandatory)][string]$RightLspName)
    $data = Get-SeceditExport
    $section = $data['Privilege Rights']
    if (-not $section -or -not $section.ContainsKey($RightLspName)) { return @() }
    return ($section[$RightLspName] -split ',') `
        | ForEach-Object { $_.TrimStart('*').Trim() } `
        | Where-Object { $_ -ne '' }
}

# ============================================================================
# Display-name mappings
# ============================================================================

# Maps a User Rights Assignment policy name to its LSP constant, which
# is what secedit's INI is keyed on. Keyed on both the Windows
# display-name form (used by the GPO benchmarks) and the Settings
# Catalog short form (used by the Intune benchmarks); hashtable lookup
# is case-insensitive. Names not in this table fall through to Manual
# rather than guess.
$script:user_rights_map = @{
    # Windows display-name form.
    'Access Credential Manager as a trusted caller'                      = 'SeTrustedCredManAccessPrivilege'
    'Access this computer from the network'                              = 'SeNetworkLogonRight'
    'Act as part of the operating system'                                = 'SeTcbPrivilege'
    'Add workstations to domain'                                         = 'SeMachineAccountPrivilege'
    'Adjust memory quotas for a process'                                 = 'SeIncreaseQuotaPrivilege'
    'Allow log on locally'                                               = 'SeInteractiveLogonRight'
    'Allow log on through Remote Desktop Services'                       = 'SeRemoteInteractiveLogonRight'
    'Back up files and directories'                                      = 'SeBackupPrivilege'
    'Bypass traverse checking'                                           = 'SeChangeNotifyPrivilege'
    'Change the system time'                                             = 'SeSystemtimePrivilege'
    'Change the time zone'                                               = 'SeTimeZonePrivilege'
    'Create a pagefile'                                                  = 'SeCreatePagefilePrivilege'
    'Create a token object'                                              = 'SeCreateTokenPrivilege'
    'Create global objects'                                              = 'SeCreateGlobalPrivilege'
    'Create permanent shared objects'                                    = 'SeCreatePermanentPrivilege'
    'Create symbolic links'                                              = 'SeCreateSymbolicLinkPrivilege'
    'Debug programs'                                                     = 'SeDebugPrivilege'
    'Deny access to this computer from the network'                      = 'SeDenyNetworkLogonRight'
    'Deny log on as a batch job'                                         = 'SeDenyBatchLogonRight'
    'Deny log on as a service'                                           = 'SeDenyServiceLogonRight'
    'Deny log on locally'                                                = 'SeDenyInteractiveLogonRight'
    'Deny log on through Remote Desktop Services'                        = 'SeDenyRemoteInteractiveLogonRight'
    'Enable computer and user accounts to be trusted for delegation'     = 'SeEnableDelegationPrivilege'
    'Force shutdown from a remote system'                                = 'SeRemoteShutdownPrivilege'
    'Generate security audits'                                           = 'SeAuditPrivilege'
    'Impersonate a client after authentication'                          = 'SeImpersonatePrivilege'
    'Increase a process working set'                                     = 'SeIncreaseWorkingSetPrivilege'
    'Increase scheduling priority'                                       = 'SeIncreaseBasePriorityPrivilege'
    'Load and unload device drivers'                                     = 'SeLoadDriverPrivilege'
    'Lock pages in memory'                                               = 'SeLockMemoryPrivilege'
    'Log on as a batch job'                                              = 'SeBatchLogonRight'
    'Log on as a service'                                                = 'SeServiceLogonRight'
    'Manage auditing and security log'                                   = 'SeSecurityPrivilege'
    'Modify an object label'                                             = 'SeRelabelPrivilege'
    'Modify firmware environment values'                                 = 'SeSystemEnvironmentPrivilege'
    'Obtain an impersonation token for another user in the same session' = 'SeDelegateSessionUserImpersonatePrivilege'
    'Perform volume maintenance tasks'                                   = 'SeManageVolumePrivilege'
    'Profile single process'                                             = 'SeProfileSingleProcessPrivilege'
    'Profile system performance'                                         = 'SeSystemProfilePrivilege'
    'Remove computer from docking station'                               = 'SeUndockPrivilege'
    'Replace a process level token'                                      = 'SeAssignPrimaryTokenPrivilege'
    'Restore files and directories'                                      = 'SeRestorePrivilege'
    'Shut down the system'                                                = 'SeShutdownPrivilege'
    'Synchronize directory service data'                                 = 'SeSyncAgentPrivilege'
    'Take ownership of files or other objects'                           = 'SeTakeOwnershipPrivilege'

    # Settings Catalog short form (only those not already covered
    # case-insensitively by a display-name key above).
    'Access Credential Manager As Trusted Caller' = 'SeTrustedCredManAccessPrivilege'
    'Access From Network'                         = 'SeNetworkLogonRight'
    'Allow Local Log On'                          = 'SeInteractiveLogonRight'
    'Backup Files And Directories'                = 'SeBackupPrivilege'
    'Change System Time'                          = 'SeSystemtimePrivilege'
    'Create Page File'                            = 'SeCreatePagefilePrivilege'
    'Create Token'                                = 'SeCreateTokenPrivilege'
    'Deny Access From Network'                    = 'SeDenyNetworkLogonRight'
    'Deny Local Log On'                           = 'SeDenyInteractiveLogonRight'
    'Deny Log On As Batch Job'                    = 'SeDenyBatchLogonRight'
    'Deny Log On As Service Job'                  = 'SeDenyServiceLogonRight'
    'Deny Remote Desktop Services Log On'         = 'SeDenyRemoteInteractiveLogonRight'
    'Enable Delegation'                           = 'SeEnableDelegationPrivilege'
    'Impersonate Client'                          = 'SeImpersonatePrivilege'
    'Load Unload Device Drivers'                  = 'SeLoadDriverPrivilege'
    'Lock Memory'                                 = 'SeLockMemoryPrivilege'
    'Log On As Batch Job'                         = 'SeBatchLogonRight'
    'Manage Volume'                               = 'SeManageVolumePrivilege'
    'Modify Firmware Environment'                 = 'SeSystemEnvironmentPrivilege'
    'Modify Object Label'                         = 'SeRelabelPrivilege'
    'Remote Shutdown'                             = 'SeRemoteShutdownPrivilege'
    'Replace Process Level Token'                 = 'SeAssignPrimaryTokenPrivilege'
    'Take Ownership'                              = 'SeTakeOwnershipPrivilege'
}

# Maps a Local Security Policy display name to its secedit INI key under
# [System Access]: the Security Options "Accounts:" entries and the
# Account Policies password/lockout entries.
$script:security_options_map = @{
    'Accounts: Administrator account status'                                     = 'EnableAdminAccount'
    'Accounts: Block Microsoft accounts'                                         = 'NoConnectedUser'
    'Accounts: Guest account status'                                             = 'EnableGuestAccount'
    'Accounts: Limit local account use of blank passwords to console logon only' = 'LimitBlankPasswordUse'
    'Accounts: Rename administrator account'                                     = 'NewAdministratorName'
    'Accounts: Rename guest account'                                             = 'NewGuestName'
    'Enforce password history'                                                   = 'PasswordHistorySize'
    'Maximum password age'                                                       = 'MaximumPasswordAge'
    'Minimum password age'                                                       = 'MinimumPasswordAge'
    'Minimum password length'                                                    = 'MinimumPasswordLength'
    'Password must meet complexity requirements'                                 = 'PasswordComplexity'
    'Store passwords using reversible encryption'                                = 'ClearTextPassword'
    'Account lockout duration'                                                   = 'LockoutDuration'
    'Account lockout threshold'                                                  = 'LockoutBadCount'
    'Allow Administrator account lockout'                                        = 'AllowAdministratorLockout'
    'Reset account lockout counter after'                                        = 'ResetLockoutCount'
}

# ============================================================================
# Human-readable formatters (for the `expected` UI field)
# ============================================================================

# Turns a Value object ({type, value/values/bytes}) into a short string.
function Format-Value {
    param($Value)
    switch ($Value.type) {
        'Dword'    { [string]$Value.value }
        'QDword'   { [string]$Value.value }
        'Str'      { "'$($Value.value)'" }
        'MultiStr' { '[' + (($Value.values | ForEach-Object { "'$_'" }) -join ', ') + ']' }
        'Binary'   { '0x' + (($Value.bytes | ForEach-Object { '{0:X2}' -f $_ }) -join '') }
        default    { "?$($Value.type)?" }
    }
}

# Turns an ExpectedValue object into a short string. Recurses for
# Absent-Or / All / Any so nested predicates render in full.
function Format-Expected {
    param($Expected)
    switch ($Expected.type) {
        'Equals'      { Format-Value $Expected.value }
        'NotEquals'   { "not $(Format-Value $Expected.value)" }
        'AtLeast'     { "at least $($Expected.value)" }
        'AtMost'      { "at most $($Expected.value)" }
        'OneOf'       { 'one of ' + (($Expected.values | ForEach-Object { Format-Value $_ }) -join ', ') }
        'Contains'    { "contains '$($Expected.substring)'" }
        'ContainsAll' { 'contains all of ' + (($Expected.substrings | ForEach-Object { "'$_'" }) -join ', ') }
        'Absent'      { 'Not configured' }
        'AbsentOr'    { 'Not configured, or ' + (Format-Expected $Expected.inner) }
        'All'         { 'all of (' + (($Expected.values | ForEach-Object { Format-Expected $_ }) -join '; ') + ')' }
        'Any'         { 'any of (' + (($Expected.values | ForEach-Object { Format-Expected $_ }) -join '; ') + ')' }
        default       { "?$($Expected.type)?" }
    }
}

# Normalizes an audit mode to one readable phrase, accepting both the
# benchmark enum spelling (`SuccessAndFailure`) and auditpol's display
# text (`Success and Failure`) so expected and found render the same
# way.
function Format-AuditMode {
    param($Mode)
    switch -Exact ("$Mode") {
        'NoAuditing'          { 'No auditing' }
        'No Auditing'         { 'No auditing' }
        'Success'             { 'Success' }
        'Failure'             { 'Failure' }
        'SuccessAndFailure'   { 'Success and Failure' }
        'Success and Failure' { 'Success and Failure' }
        default               { "$Mode" }
    }
}

# ============================================================================
# Predicate dispatch
# ============================================================================

# Evaluates an ExpectedValue against a registry-read result. Centralizes
# the null guard so missing values can't sneak through cast-driven
# coercion (e.g. `[int64]$null -eq 0` is True). Variants that require a
# present value (Equals, AtLeast, etc.) fail fast when $Current is $null;
# Absent / AbsentOr explicitly handle the null case themselves.
function Test-Expected {
    param($Current, $Expected)

    $requiresPresent = @('Equals', 'NotEquals', 'AtLeast', 'AtMost', 'OneOf', 'Contains', 'ContainsAll')
    if ($Expected.type -in $requiresPresent -and $null -eq $Current) {
        return $false
    }

    switch ($Expected.type) {
        'Equals'      { Test-ValueEquals $Current $Expected.value }
        'NotEquals'   { -not (Test-ValueEquals $Current $Expected.value) }
        'AtLeast'     { [int64]$Current -ge [int64]$Expected.value }
        'AtMost'      { [int64]$Current -le [int64]$Expected.value }
        'OneOf'       {
            $matched = $false
            foreach ($v in $Expected.values) {
                if (Test-ValueEquals $Current $v) { $matched = $true; break }
            }
            return $matched
        }
        'Contains'    { [string]$Current -like "*$($Expected.substring)*" }
        'ContainsAll' {
            $all = $true
            foreach ($s in $Expected.substrings) {
                if (-not ([string]$Current -like "*$s*")) { $all = $false; break }
            }
            return $all
        }
        'Absent'      { $null -eq $Current }
        'AbsentOr'    { ($null -eq $Current) -or (Test-Expected $Current $Expected.inner) }
        'All'         {
            $all = $true
            foreach ($inner in $Expected.values) {
                if (-not (Test-Expected $Current $inner)) { $all = $false; break }
            }
            return $all
        }
        'Any'         {
            $any = $false
            foreach ($inner in $Expected.values) {
                if (Test-Expected $Current $inner) { $any = $true; break }
            }
            return $any
        }
        default       { throw "unknown ExpectedValue type: $($Expected.type)" }
    }
}

# Equality comparison sized to the typed Value (Dword/QDword/Str/etc.).
# Casts both operands to the same type so operand-order coercion doesn't
# decide the result.
function Test-ValueEquals {
    param($Current, $Value)
    switch ($Value.type) {
        'Dword'    { [int64]$Current -eq [int64]$Value.value }
        'QDword'   { [int64]$Current -eq [int64]$Value.value }
        'Str'      { [string]$Current -eq [string]$Value.value }
        'MultiStr' {
            $cur = @($Current | ForEach-Object { [string]$_ }) | Sort-Object
            $exp = @($Value.values | ForEach-Object { [string]$_ }) | Sort-Object
            if ($cur.Count -ne $exp.Count) { return $false }
            for ($i = 0; $i -lt $cur.Count; $i++) {
                if ($cur[$i] -ne $exp[$i]) { return $false }
            }
            return $true
        }
        'Binary'   {
            $cur = @([byte[]]$Current)
            $exp = @($Value.bytes | ForEach-Object { [byte]$_ })
            if ($cur.Length -ne $exp.Length) { return $false }
            for ($i = 0; $i -lt $cur.Length; $i++) {
                if ($cur[$i] -ne $exp[$i]) { return $false }
            }
            return $true
        }
        default    { throw "unknown Value type: $($Value.type)" }
    }
}

# ============================================================================
# AuditProcedure dispatch
# ============================================================================

# Runs a single recommendation's check and emits its NDJSON result.
# Catches access-denied at the outer layer so admin-required reads come
# back with a "Requires elevation: ..." error message rather than
# crashing the whole script.
function Invoke-Rec {
    param($Rec)
    $audit = $Rec.audit
    $id = $Rec.id

    try {
        switch ($audit.type) {
            'Registry' {
                $check_details = @()
                $passes = @()
                $current_summary = @()
                $expected_summary = @()
                $path_error = $null
                foreach ($check in $audit.checks) {
                    $exp_str = Format-Expected $check.expected
                    $resolution = Resolve-CheckPath $check.path
                    if ($resolution.kind -eq 'error') {
                        $path_error = $resolution.reason
                        break
                    }
                    if ($resolution.kind -eq 'fail') {
                        # A required <Tenant-ID> couldn't be resolved: the
                        # per-tenant policy can't be confirmed, which is a
                        # real Fail rather than an automation gap.
                        $passes += $false
                        $current_summary += "$($check.valueName)=(unresolved)"
                        $expected_summary += "$($check.valueName) $exp_str"
                        $check_details += [ordered]@{
                            path      = $check.path
                            valueName = $check.valueName
                            expected  = $exp_str
                            actual    = $resolution.reason
                            pass      = $false
                        }
                        continue
                    }
                    $current = Get-RegValue -Path $resolution.path -Name $check.valueName
                    $pass = Test-Expected $current $check.expected
                    $passes += $pass
                    $actual_str = if ($null -eq $current) { $null } else { [string]$current }
                    $display = if ($null -eq $current) { '(absent)' } else { [string]$current }
                    $current_summary += "$($check.valueName)=$display"
                    $expected_summary += "$($check.valueName) $exp_str"
                    $check_details += [ordered]@{
                        path      = $resolution.path
                        valueName = $check.valueName
                        expected  = $exp_str
                        actual    = $actual_str
                        pass      = $pass
                    }
                }
                if ($null -ne $path_error) {
                    Write-NdjsonResult -Id $id -Status 'Error' -ErrorMessage $path_error
                    break
                }
                $all_pass = -not ($passes -contains $false)
                $status = if ($all_pass) { 'Pass' } else { 'Fail' }
                Write-NdjsonResult -Id $id -Status $status `
                    -CurrentValue ($current_summary -join '; ') `
                    -Expected ($expected_summary -join '; ') `
                    -Checks $check_details
            }
            'PolicyManager' {
                # Intune MDM settings are registry-backed. A WinningProvider
                # GUID under PolicyManager\current\<scope>\<area> names the
                # provider tree that holds the value; the value itself lives
                # under \PolicyManager\Providers\{GUID}\Default\<scope>\<area>.
                # Both steps are plain registry reads, so the result is
                # reported as a registry check against the concrete path read
                # -- the provider path when a provider claimed the setting,
                # the WinningProvider lookup path when none did.
                $scope_current = if ($audit.scope -eq 'Device') { 'device' } else { '(USER SID)' }
                # User-scope values live under the currently-logged-in user's
                # SID per the data-model decision in project memory.
                $scope_provider = if ($audit.scope -eq 'Device') {
                    'Device'
                } else {
                    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
                }

                $wp_path = "HKLM:\SOFTWARE\Microsoft\PolicyManager\current\$scope_current\$($audit.area)"
                $wp_name = "$($audit.setting)_WinningProvider"
                $provider = Get-RegValue -Path $wp_path -Name $wp_name

                $current = $null
                $read_path = $wp_path
                if ($null -ne $provider) {
                    $read_path = "HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers\$provider\Default\$scope_provider\$($audit.area)"
                    $current = Get-RegValue -Path $read_path -Name $audit.setting
                }

                $pass = Test-Expected $current $audit.expected
                $exp_str = Format-Expected $audit.expected
                $actual_str = if ($null -eq $current) { $null } else { [string]$current }
                $display = if ($null -eq $current) { '(absent)' } else { [string]$current }
                $details = @([ordered]@{
                    path      = $read_path
                    valueName = $audit.setting
                    expected  = $exp_str
                    actual    = $actual_str
                    pass      = $pass
                })
                $status = if ($pass) { 'Pass' } else { 'Fail' }
                Write-NdjsonResult -Id $id -Status $status `
                    -CurrentValue "$($audit.setting)=$display" `
                    -Expected "$($audit.setting) $exp_str" `
                    -Checks $details
            }
            'UserRightsAssignment' {
                $lsp_name = $script:user_rights_map[$audit.rightName]
                if ($null -eq $lsp_name) {
                    # No display->LSP mapping. Surface as Manual rather than
                    # guess; user can extend $script:user_rights_map if the
                    # name shows up in a future benchmark.
                    $details = @([ordered]@{
                        path      = 'User Rights Assignment'
                        valueName = $audit.rightName
                        expected  = '(unmapped display name)'
                        actual    = $null
                        pass      = $null
                    })
                    Write-NdjsonResult -Id $id -Status 'Manual' `
                        -Expected "User Right '$($audit.rightName)' -- no LSP-constant mapping" `
                        -Checks $details
                    break
                }

                $actual_sids = @(Get-PrivilegeSids -RightLspName $lsp_name)
                $expected_sids = @($audit.expected `
                    | ForEach-Object { Resolve-PrincipalToSid -Identifier $_.identifier } `
                    | Where-Object { $null -ne $_ })

                if ($audit.matching -eq 'Exact') {
                    $a_sorted = (@($actual_sids) | Sort-Object) -join ','
                    $e_sorted = (@($expected_sids) | Sort-Object) -join ','
                    $pass = $a_sorted -eq $e_sorted
                } else {
                    # Includes: every expected principal must appear in the
                    # actual set; extra principals on the device are OK.
                    $missing = @($expected_sids | Where-Object { $_ -notin $actual_sids })
                    $pass = ($missing.Count -eq 0)
                }

                # Display in plain language. An empty expected set means
                # the right must be granted to nobody ("No one"); the
                # matching mode reads as a sentence rather than the raw
                # enum + bracket form. Actual SIDs are translated back to
                # account names so the reader sees `BUILTIN\Administrators`
                # rather than `S-1-5-32-544`.
                $exp_names = @($audit.expected | ForEach-Object { $_.identifier })
                if ($exp_names.Count -eq 0) {
                    $exp_str = 'No one'
                } elseif ($audit.matching -eq 'Exact') {
                    $exp_str = 'Only ' + ($exp_names -join ', ')
                } else {
                    $exp_str = 'Includes ' + ($exp_names -join ', ')
                }
                $actual_str = if ($actual_sids.Count -eq 0) {
                    'No one'
                } else {
                    (@($actual_sids | ForEach-Object { Resolve-SidToName $_ })) -join ', '
                }
                $details = @([ordered]@{
                    path      = 'User Rights Assignment'
                    valueName = $audit.rightName
                    expected  = $exp_str
                    actual    = $actual_str
                    pass      = $pass
                })
                $status = if ($pass) { 'Pass' } else { 'Fail' }
                Write-NdjsonResult -Id $id -Status $status `
                    -Expected "User Right '$($audit.rightName)' $exp_str" `
                    -CurrentValue $actual_str `
                    -Checks $details
            }
            'Secedit' {
                $section_name = switch ($audit.section.type) {
                    'SystemAccess'   { 'System Access' }
                    'RegistryValues' { 'Registry Values' }
                    'Service'        { 'Service General Setting' }
                    'Other'          { $audit.section.name }
                    default          { $null }
                }
                if ($null -eq $section_name) {
                    throw "unknown SeceditSection type: $($audit.section.type)"
                }

                # SystemAccess settings reference the secedit INI key via a
                # display-name map; other sections use the setting verbatim.
                $ini_key = if ($section_name -eq 'System Access' `
                    -and $script:security_options_map.ContainsKey($audit.setting)) {
                    $script:security_options_map[$audit.setting]
                } else {
                    $audit.setting
                }

                $data = Get-SeceditExport
                $section = $data[$section_name]
                $raw = if ($section -and $section.ContainsKey($ini_key)) { $section[$ini_key] } else { $null }
                # Secedit wraps string values in quotes -- strip so the
                # predicate compares the unwrapped string.
                if ($null -ne $raw `
                    -and $raw.Length -ge 2 `
                    -and $raw.StartsWith('"') `
                    -and $raw.EndsWith('"')) {
                    $raw = $raw.Substring(1, $raw.Length - 2)
                }

                $pass = Test-Expected $raw $audit.expected
                $exp_str = Format-Expected $audit.expected
                # These settings live in "Local Security Policy"
                # (secpol.msc) -- name the user-facing location, not the
                # secedit tool used to read it. An unset entry reads
                # "Not configured" rather than a null the UI would show
                # as the misleading "absent".
                $actual_str = if ($null -eq $raw) { 'Not configured' } else { [string]$raw }
                $details = @([ordered]@{
                    path      = 'Local Security Policy'
                    valueName = $audit.setting
                    expected  = $exp_str
                    actual    = $actual_str
                    pass      = $pass
                })
                $status = if ($pass) { 'Pass' } else { 'Fail' }
                Write-NdjsonResult -Id $id -Status $status `
                    -Expected "Local Security Policy / $($audit.setting) $exp_str" `
                    -CurrentValue $actual_str `
                    -Checks $details
            }
            'AuditPolicy' {
                $dump = Get-AuditPolDump
                $entry = $dump[$audit.subcategoryGuid]
                $current_text = if ($null -ne $entry) { $entry.Setting } else { $null }
                $sub_name = if ($null -ne $entry `
                    -and -not [string]::IsNullOrWhiteSpace($entry.Name)) {
                    $entry.Name
                } else {
                    # No display name (subcategory absent on this OS, or an
                    # invalid GUID): fall back to the GUID so there's still
                    # an identifier rather than a blank.
                    $audit.subcategoryGuid
                }

                # auditpol's "Inclusion Setting" column uses display strings
                # with spaces; map to our enum spelling for comparison.
                $current_mode = switch ($current_text) {
                    'No Auditing'         { 'NoAuditing' }
                    'Success'             { 'Success' }
                    'Failure'             { 'Failure' }
                    'Success and Failure' { 'SuccessAndFailure' }
                    default               { $current_text }
                }

                if ($audit.matching -eq 'Exact') {
                    $pass = ($current_mode -eq $audit.expected)
                } else {
                    # Includes: SuccessAndFailure satisfies a single-direction
                    # expectation; otherwise straight equality.
                    $pass = switch ($audit.expected) {
                        'Success' { $current_mode -in @('Success', 'SuccessAndFailure') }
                        'Failure' { $current_mode -in @('Failure', 'SuccessAndFailure') }
                        default   { $current_mode -eq $audit.expected }
                    }
                }

                $exp_value = Format-AuditMode $audit.expected
                $exp_str = if ($audit.matching -eq 'Exact') {
                    $exp_value
                } else {
                    "Includes $exp_value"
                }
                $found_str = if ($null -eq $current_text) {
                    'Not configured'
                } else {
                    Format-AuditMode $current_text
                }
                $details = @([ordered]@{
                    path      = 'Audit Policy'
                    valueName = $sub_name
                    expected  = $exp_str
                    actual    = $found_str
                    pass      = $pass
                })
                $status = if ($pass) { 'Pass' } else { 'Fail' }
                Write-NdjsonResult -Id $id -Status $status `
                    -Expected "Audit subcategory '$sub_name' $exp_str" `
                    -CurrentValue $found_str `
                    -Checks $details
            }
            'Manual' {
                $details = @([ordered]@{
                    path      = '(manual review)'
                    valueName = ''
                    expected  = $audit.description
                    actual    = $null
                    pass      = $null
                })
                Write-NdjsonResult -Id $id -Status 'Manual' -Expected $audit.description -Checks $details
            }
            default { throw "unknown AuditProcedure type: $($audit.type)" }
        }
    } catch [System.Security.SecurityException], [System.UnauthorizedAccessException] {
        Write-NdjsonResult -Id $id -Status 'Error' -ErrorMessage "Requires elevation: $($_.Exception.Message)"
    } catch {
        Write-NdjsonResult -Id $id -Status 'Error' -ErrorMessage $_.Exception.Message
    }
}

# ============================================================================
# Main
# ============================================================================

try {
    $raw = Get-Content -LiteralPath $BaselinePath -Raw -Encoding UTF8
    $baseline = $raw | ConvertFrom-Json

    Write-NdjsonDevice

    $check_cancel = -not [string]::IsNullOrEmpty($CancelPath)
    foreach ($rec in $baseline.recommendations) {
        if ($check_cancel -and (Test-Path -LiteralPath $CancelPath)) {
            break
        }
        Invoke-Rec $rec
    }
}
finally {
    if ($null -ne $script:out_stream) {
        $script:out_stream.Close()
    }
}
