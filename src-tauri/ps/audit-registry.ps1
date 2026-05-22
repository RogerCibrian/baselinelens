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

    # HKU paths carry a '[USER SID]' placeholder for the
    # currently-logged-in user. Resolve it from the running identity, the
    # same source the PolicyManager check uses, so user-scope reads stay
    # consistent across check types.
    if ($resolved -match '\[\s*USER\s*SID\s*\]') {
        $usid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ([string]::IsNullOrWhiteSpace($usid)) {
            return @{
                kind   = 'error'
                reason = 'Current user SID could not be determined'
            }
        }
        $resolved = $resolved.Replace($Matches[0], $usid)
    }

    if ($resolved -match '[:<>]') {
        return @{
            kind   = 'error'
            reason = 'Registry path could not be parsed'
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
