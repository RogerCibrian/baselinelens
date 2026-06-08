# BaselineLens audit helpers: registry reads and path resolution.
#
# Dot-sourced by audit.ps1 -- not a standalone script. Dot-sourcing runs
# in the caller's scope, so the $script: state and functions defined here
# are shared with the dispatcher.

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
    } catch [System.Security.SecurityException], [System.UnauthorizedAccessException] {
        # The Defender 'Policy Manager' CSP keys are readable only by SYSTEM;
        # an elevated administrator is denied. Escalate the read to SYSTEM for
        # Defender keys, and only those -- a denied read anywhere else (e.g.
        # HKLM\SAM, HKLM\SECURITY) stays an Error, so a stray or hostile path
        # can never make us SYSTEM-read an unrelated protected key.
        if ($Path -match 'Defender') {
            return Get-SystemRegValue -Path $Path -Name $Name
        }
        throw
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
        # Fully-qualified so a planted dsregcmd.exe on the search path can't
        # run in our place under elevation.
        $dsregcmd = Join-Path $env:SystemRoot 'System32\dsregcmd.exe'
        $status = & $dsregcmd /status 2>$null
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

# GUID of the Intune MDM enrollment, used to resolve the '{ProviderGUID}'
# placeholder some policy paths carry under
# HKLM\SOFTWARE\Microsoft\Enrollments\{ProviderGUID}\. The enrollment
# subkeys are GUID-named; the Intune one is the subkey whose 'ProviderID'
# value is 'MS DM Server'. Resolved by inspecting each subkey rather than
# trusting whatever GUID happens to exist. Cached (incl. a negative
# result) since it's stable per scan.
$script:enrollment_provider_guid = $null
$script:enrollment_provider_guid_resolved = $false
function Resolve-EnrollmentProviderGuid {
    if ($script:enrollment_provider_guid_resolved) { return $script:enrollment_provider_guid }
    $script:enrollment_provider_guid_resolved = $true

    try {
        $enrollments = 'HKLM:\SOFTWARE\Microsoft\Enrollments'
        if (Test-Path -LiteralPath $enrollments) {
            foreach ($sub in Get-ChildItem -LiteralPath $enrollments -ErrorAction Stop) {
                $provider_id = (Get-ItemProperty -LiteralPath $sub.PSPath -Name 'ProviderID' -ErrorAction SilentlyContinue).ProviderID
                if ($provider_id -eq 'MS DM Server') {
                    $script:enrollment_provider_guid = $sub.PSChildName
                    return $script:enrollment_provider_guid
                }
            }
        }
    } catch {
        # No readable enrollment; leave the GUID null for the caller to handle.
    }
    return $null
}

# SID of the interactive desktop user, used to resolve user-scope reads:
# the '[USER SID]' registry placeholder and the user-scope PolicyManager
# subkeys both key off it. The scan runs elevated, so the process identity
# can be a different admin than the person signed in -- explorer.exe runs
# as the desktop user, so its owner names the hive that holds user-scope
# settings. Cached (incl. a negative result) since it's stable per scan.
$script:interactive_user_sid = $null
$script:interactive_user_sid_resolved = $false
function Resolve-InteractiveUserSid {
    if ($script:interactive_user_sid_resolved) { return $script:interactive_user_sid }
    $script:interactive_user_sid_resolved = $true

    try {
        $shells = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop)
        foreach ($shell in $shells) {
            $owner = Invoke-CimMethod -InputObject $shell -MethodName GetOwner -ErrorAction Stop
            if ([string]::IsNullOrWhiteSpace($owner.User)) { continue }
            try {
                $account = New-Object System.Security.Principal.NTAccount($owner.Domain, $owner.User)
                $script:interactive_user_sid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
                return $script:interactive_user_sid
            } catch {
                # This shell's owner did not translate to a SID; try the next.
            }
        }
    } catch {
        # No interactive shell reachable (e.g. running as SYSTEM with no
        # console session). Leave the SID null for the caller to handle.
    }
    return $null
}

# Resolves a registry check path before reading it. Substitutes the
# '<Tenant-ID>' and '[USER SID]' placeholders, then maps the hive prefix
# to a provider-qualified path. Returns a hashtable with 'kind':
#   'ok'    -> 'path' is the provider-qualified path passed to
#              Get-ItemProperty; 'display' is the readable resolved form
#              used in the reported check detail
#   'fail'  -> a required '<Tenant-ID>' could not be resolved; the
#              per-tenant policy counts as a Fail
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

    # Some policy paths carry a '{ProviderGUID}' placeholder for the Intune
    # MDM enrollment subkey under HKLM\...\Enrollments\. Resolve it from the
    # enrollment whose ProviderID is 'MS DM Server'.
    if ($resolved -match '\{ProviderGUID\}') {
        $provider_guid = Resolve-EnrollmentProviderGuid
        if ([string]::IsNullOrWhiteSpace($provider_guid)) {
            return @{
                kind   = 'fail'
                reason = 'Intune enrollment could not be found; the policy cannot be confirmed'
            }
        }
        $resolved = $resolved.Replace('{ProviderGUID}', $provider_guid)
    }

    # HKU paths carry a '[USER SID]' placeholder for the interactive
    # desktop user. Resolve it from explorer.exe's owner -- the same
    # source the user-scope PolicyManager check uses -- so user-scope
    # reads hit the signed-in user's hive even when the scan runs elevated
    # as a different admin.
    if ($resolved -match '\[\s*USER\s*SID\s*\]') {
        $usid = Resolve-InteractiveUserSid
        if ([string]::IsNullOrWhiteSpace($usid)) {
            return @{
                kind   = 'error'
                reason = 'Interactive user SID could not be determined'
            }
        }
        $resolved = $resolved.Replace($Matches[0], $usid)
    }

    # Any placeholder left unresolved here (an unhandled '{...}', or a
    # stray ':'/'<'/'>') is an automation gap, not a device misconfig --
    # surface it as Error rather than reading a literal key that can't
    # exist and reporting a misleading Fail.
    if ($resolved -match '[:<>{}]') {
        return @{
            kind   = 'error'
            reason = "Unsupported registry path placeholder in $resolved"
        }
    }

    # The parser emits colon-less, hive-prefixed paths. Get-ItemProperty
    # resolves the registry only through a drive or a provider qualifier,
    # and HKU has no default drive, so map both hives to the Registry
    # provider form. The colon-less resolved form is kept for display.
    if ($resolved -match '^HKLM\\(.+)$') {
        $qualified = "Registry::HKEY_LOCAL_MACHINE\$($Matches[1])"
    } elseif ($resolved -match '^HKU\\(.+)$') {
        $qualified = "Registry::HKEY_USERS\$($Matches[1])"
    } else {
        return @{
            kind   = 'error'
            reason = 'Registry path could not be parsed'
        }
    }

    return @{ kind = 'ok'; path = $qualified; display = $resolved }
}
