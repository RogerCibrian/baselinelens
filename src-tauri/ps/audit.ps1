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
    [string]$CancelPath,
    # Optional wall-clock cap in seconds. When > 0, the per-rec loop
    # stops once this many seconds have elapsed. Set deliberately longer
    # than the Rust runner's own timeout so the runner reports a timeout
    # first; this only backstops an elevated child left orphaned when the
    # runner gave up and killed the unelevated launcher.
    [int]$TimeoutSeconds = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# The launcher (see audit::runner) dot-sources device-info.ps1,
# audit-registry.ps1, and audit-security-policy.ps1 into the shared scope
# before dot-sourcing this dispatcher, after verifying each file against
# the digest the trusted binary computed. Their functions and $script:
# state are therefore already present here.

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

function Write-Line {
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
    Write-Line -Line $json
}

# Emits a Pass/Fail NDJSON result for a recommendation that reads
# exactly one value: builds the single-row check detail, derives the
# status, and delegates to Write-NdjsonResult. The single-check
# dispatch arms share this so the detail-hashtable + status + emit
# tail isn't rebuilt per arm. Registry stays bespoke -- it accumulates
# multiple checks. $Actual is left untyped so a null reading stays
# JSON null instead of being coerced to an empty string.
function Write-SingleCheckResult {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][bool]$Pass,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ValueName,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Expected,
        $Actual,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedText,
        [Parameter(Mandatory)][AllowEmptyString()][string]$CurrentValue
    )
    $details = @([ordered]@{
        path      = $Path
        valueName = $ValueName
        expected  = $Expected
        actual    = $Actual
        pass      = $Pass
    })
    $status = if ($Pass) { 'Pass' } else { 'Fail' }
    Write-NdjsonResult -Id $Id -Status $status `
        -Expected $ExpectedText `
        -CurrentValue $CurrentValue `
        -Checks $details
}

# Emits the NDJSON device line by wrapping Get-BlDeviceInfo (defined in
# device-info.ps1) with the 'type' discriminator the Rust runner expects.
function Write-NdjsonDevice {
    $info = Get-BlDeviceInfo
    $payload = [ordered]@{ type = 'device' }
    foreach ($key in $info.Keys) { $payload[$key] = $info[$key] }
    Write-Line -Line ($payload | ConvertTo-Json -Compress -Depth 4)
}

# ============================================================================
# Human-readable formatters (for the `expected` UI field)
# ============================================================================

# Turns a Value object ({type, value/values/bytes}) into a short string.
# String values go through ConvertTo-Json so quotes inside the string are
# escaped properly -- single-quote wrapping would render strings like
# `it's` as `'it's'`, which a reader has no way to disambiguate from a
# closed quote followed by stray text.
function Format-Value {
    param($Value)
    switch ($Value.type) {
        'Dword'    { [string]$Value.value }
        'QDword'   { [string]$Value.value }
        'Str'      { ConvertTo-Json -InputObject $Value.value -Compress }
        'MultiStr' {
            '[' + (($Value.values | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress }) -join ', ') + ']'
        }
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

# Returns the leaf Value type an ExpectedValue constrains, so a raw
# reading can be rendered the same way Format-Expected renders the
# expected side. Compound predicates report their first or inner
# member's type; Absent and unknown shapes report $null.
function Get-ExpectedValueType {
    param($Expected)
    switch ($Expected.type) {
        'Equals'      { $Expected.value.type }
        'NotEquals'   { $Expected.value.type }
        'OneOf'       { if (@($Expected.values).Count -gt 0) { $Expected.values[0].type } else { $null } }
        'AtLeast'     { 'Dword' }
        'AtMost'      { 'Dword' }
        'Contains'    { 'Str' }
        'ContainsAll' { 'Str' }
        'AbsentOr'    { Get-ExpectedValueType $Expected.inner }
        'All'         { if (@($Expected.values).Count -gt 0) { Get-ExpectedValueType $Expected.values[0] } else { $null } }
        'Any'         { if (@($Expected.values).Count -gt 0) { Get-ExpectedValueType $Expected.values[0] } else { $null } }
        default       { $null }
    }
}

# Renders a raw reading for the Found field, matching how Format-Expected
# renders the same value type so both sides read alike (a REG_SZ shows as
# "0" on each). A missing value renders as "Not configured", the same
# wording the expected side and the secedit/audit-policy reads use.
function Format-Found {
    param($Current, $Expected)
    if ($null -eq $Current) { return 'Not configured' }
    switch (Get-ExpectedValueType $Expected) {
        'Str'      { Format-Value @{ type = 'Str'; value = [string]$Current } }
        'MultiStr' { Format-Value @{ type = 'MultiStr'; values = @($Current) } }
        'Binary'   { Format-Value @{ type = 'Binary'; bytes = @([byte[]]$Current) } }
        default    { [string]$Current }
    }
}

# Service startup-type rendering. Service-state recs are registry checks
# on the Start value under ...\Services\<name>; the bare "Start" value
# name and the raw Start DWORD are machinery, so these render in service
# startup terms (per Microsoft's ServiceStartMode) and a missing key
# reads as Not Installed rather than Not configured.
$script:service_start_modes = @{
    0 = 'Boot'
    1 = 'System'
    2 = 'Automatic'
    3 = 'Manual'
    4 = 'Disabled'
}

# True when a registry check targets a service's Start value: the value
# named Start under a ...\Services\... path.
function Test-ServiceStartCheck {
    param($Path, $ValueName)
    return ($ValueName -eq 'Start') -and ($Path -match '\\Services\\')
}

# Renders a raw Start reading as its service startup type. An absent key
# means the service isn't present; an unknown number falls back to the
# raw value rather than hide it.
function Format-ServiceStartFound {
    param($Current)
    if ($null -eq $Current) { return 'Not Installed' }
    $mode = $script:service_start_modes[[int]$Current]
    if ($null -ne $mode) { return $mode }
    return [string]$Current
}

# Renders a Start ExpectedValue in service startup terms. Mirrors the
# Equals / Absent / AbsentOr / OneOf shapes the parser emits for service
# recs; other shapes fall back to the generic Format-Expected.
function Format-ServiceStartExpected {
    param($Expected)
    switch ($Expected.type) {
        'Equals'   { Format-ServiceStartFound $Expected.value.value }
        'Absent'   { 'Not Installed' }
        'AbsentOr' { (Format-ServiceStartExpected $Expected.inner) + ', or Not Installed' }
        'OneOf'    { (($Expected.values | ForEach-Object { Format-ServiceStartFound $_.value }) -join ', ') }
        default    { Format-Expected $Expected }
    }
}

# Normalizes an audit mode to one readable phrase. Accepts the benchmark
# enum spelling (`SuccessAndFailure`) and the spaced spelling so expected
# and found render the same way.
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
                    $is_service = Test-ServiceStartCheck $check.path $check.valueName
                    $exp_str = if ($is_service) {
                        Format-ServiceStartExpected $check.expected
                    } else {
                        Format-Expected $check.expected
                    }
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
                        $current_summary += "$($check.valueName) = (unresolved)"
                        $expected_summary += "$($check.valueName) = $exp_str"
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
                    $found_str = if ($is_service) {
                        Format-ServiceStartFound $current
                    } else {
                        Format-Found $current $check.expected
                    }
                    # Service recs always carry a label ('Not Installed' for an
                    # absent key); other recs keep $null so the drawer shows its
                    # 'Not configured' fallback.
                    $actual_str = if ($is_service -or $null -ne $current) { $found_str } else { $null }
                    if ($is_service) {
                        $current_summary += $found_str
                        $expected_summary += $exp_str
                    } else {
                        $current_summary += "$($check.valueName) = $found_str"
                        $expected_summary += "$($check.valueName) = $exp_str"
                    }
                    $check_details += [ordered]@{
                        path      = $resolution.display
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
                # reported as a registry check against the concrete path read.
                # User scope under both subtrees is keyed by the interactive
                # desktop user's SID; the parsed `(USER SID)` token is a
                # placeholder, not a real subkey name.
                $user_sid = if ($audit.scope -eq 'Device') {
                    $null
                } else {
                    Resolve-InteractiveUserSid
                }
                if ($audit.scope -ne 'Device' -and [string]::IsNullOrWhiteSpace($user_sid)) {
                    Write-NdjsonResult -Id $id -Status 'Error' `
                        -ErrorMessage 'Interactive user SID could not be determined; user-scope policy cannot be read' `
                        -Expected "$($audit.setting) = $(Format-Expected $audit.expected)"
                    break
                }
                $scope_current = if ($audit.scope -eq 'Device') { 'device' } else { $user_sid }
                $scope_provider = if ($audit.scope -eq 'Device') { 'Device' } else { $user_sid }

                $wp_path = "HKLM:\SOFTWARE\Microsoft\PolicyManager\current\$scope_current\$($audit.area)"
                $wp_name = "$($audit.setting)_WinningProvider"
                $provider = Get-RegValue -Path $wp_path -Name $wp_name

                # When a provider claims the setting, the actual value lives
                # under \Providers\{GUID}\Default\... -- that's what was read.
                # When none claims it, the only thing actually read is the
                # WinningProvider name itself, so the displayed path/value
                # name reflect *that* lookup rather than a Providers path
                # we never touched.
                $current = $null
                if ($null -ne $provider) {
                    $read_path = "HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers\$provider\Default\$scope_provider\$($audit.area)"
                    $read_value_name = $audit.setting
                    $current = Get-RegValue -Path $read_path -Name $audit.setting
                } else {
                    $read_path = $wp_path
                    $read_value_name = $wp_name
                }

                $pass = Test-Expected $current $audit.expected
                $exp_str = Format-Expected $audit.expected
                $found_str = Format-Found $current $audit.expected
                $actual_str = if ($null -eq $current) { $null } else { $found_str }
                Write-SingleCheckResult -Id $id -Pass $pass -Path $read_path `
                    -ValueName $read_value_name -Expected $exp_str -Actual $actual_str `
                    -ExpectedText "$($audit.setting) = $exp_str" `
                    -CurrentValue "$($audit.setting) = $found_str"
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
                        expected  = '(no policy mapping)'
                        actual    = $null
                        pass      = $null
                    })
                    Write-NdjsonResult -Id $id -Status 'Manual' `
                        -Expected "$($audit.rightName) = (no policy mapping for this right)" `
                        -Checks $details
                    break
                }

                $actual_sids = @(Get-PrivilegeSids -RightLspName $lsp_name)
                # Track unresolved expected principals separately so the
                # rec doesn't silently appear to pass when a name we
                # couldn't translate to a SID gets dropped from the
                # comparison set.
                $expected_sids = @()
                $unresolved = @()
                foreach ($principal in $audit.expected) {
                    $sid = Resolve-PrincipalToSid -Identifier $principal.identifier
                    if ($null -eq $sid) {
                        $unresolved += $principal.identifier
                    } else {
                        $expected_sids += $sid
                    }
                }

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

                if ($unresolved.Count -gt 0) {
                    # We can't conclude either way when an expected
                    # principal doesn't resolve on this device -- the
                    # comparison would be against a subset of what the
                    # benchmark requires. Surface it as Error rather than
                    # let it look like a real Pass/Fail.
                    $unresolved_list = ($unresolved -join ', ')
                    Write-NdjsonResult -Id $id -Status 'Error' `
                        -ErrorMessage "Expected principal(s) could not be resolved to a SID on this device: $unresolved_list" `
                        -Expected "$($audit.rightName) = $exp_str" `
                        -CurrentValue "$($audit.rightName) = $actual_str" `
                        -Checks @([ordered]@{
                            path      = 'User Rights Assignment'
                            valueName = $audit.rightName
                            expected  = $exp_str
                            actual    = $actual_str
                            pass      = $null
                        })
                    break
                }

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

                Write-SingleCheckResult -Id $id -Pass $pass `
                    -Path 'User Rights Assignment' -ValueName $audit.rightName `
                    -Expected $exp_str -Actual $actual_str `
                    -ExpectedText "$($audit.rightName) = $exp_str" `
                    -CurrentValue "$($audit.rightName) = $actual_str"
            }
            'Secedit' {
                # Every Secedit rec the parser emits targets the
                # `[System Access]` INI section -- the only section the
                # classifier produces. The Security Options display names
                # map to short INI keys (e.g. `Accounts: Guest account
                # status` -> `EnableGuestAccount`); password/lockout
                # settings use their display name verbatim as the key.
                $ini_key = if ($script:security_options_map.ContainsKey($audit.setting)) {
                    $script:security_options_map[$audit.setting]
                } else {
                    $audit.setting
                }

                $data = Get-SeceditExport
                $section = $data['System Access']
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
                $actual_str = if ($null -eq $raw) { 'Not configured' } else { Format-Found $raw $audit.expected }
                Write-SingleCheckResult -Id $id -Pass $pass `
                    -Path 'Local Security Policy' -ValueName $audit.setting `
                    -Expected $exp_str -Actual $actual_str `
                    -ExpectedText "$($audit.setting) = $exp_str" `
                    -CurrentValue "$($audit.setting) = $actual_str"
            }
            'AuditPolicy' {
                # AuditQuerySystemPolicy returns the effective mode as a
                # numeric bitmask keyed by GUID, so the read doesn't depend
                # on the display language. An unconfigured subcategory reads
                # as NoAuditing -- the system default Windows reports for any
                # subcategory without an explicit policy.
                $current_mode = Get-AuditSubcategoryMode -Guid $audit.subcategoryGuid
                $sub_name = Get-AuditSubcategoryName -Guid $audit.subcategoryGuid

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
                $found_str = Format-AuditMode $current_mode
                Write-SingleCheckResult -Id $id -Pass $pass -Path 'Audit Policy' `
                    -ValueName $sub_name -Expected $exp_str -Actual $found_str `
                    -ExpectedText "$sub_name = $exp_str" `
                    -CurrentValue "$sub_name = $found_str"
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
    # Re-throw baseline-load failures with a clear, user-readable
    # prefix. PS's default exception message ('Cannot find path ...') is
    # surfaced verbatim to the UI through the Rust runner's NonZeroExit
    # capture, so the wrapped form is what the user actually reads.
    try {
        $raw = Get-Content -LiteralPath $BaselinePath -Raw -Encoding UTF8
        $baseline = $raw | ConvertFrom-Json
    } catch {
        throw "Failed to load baseline JSON from '$BaselinePath': $($_.Exception.Message)"
    }

    Write-NdjsonDevice

    $check_cancel = -not [string]::IsNullOrEmpty($CancelPath)
    $deadline = if ($TimeoutSeconds -gt 0) {
        [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    } else {
        $null
    }
    foreach ($rec in $baseline.recommendations) {
        if ($check_cancel -and (Test-Path -LiteralPath $CancelPath)) {
            break
        }
        if ($null -ne $deadline -and [DateTime]::UtcNow -gt $deadline) {
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
