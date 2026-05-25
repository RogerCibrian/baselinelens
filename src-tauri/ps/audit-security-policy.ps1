# BaselineLens audit helpers: local security policy inspections.
#
# Dot-sourced by audit.ps1 -- not a standalone script. Covers the secedit
# /export, the security-audit policy API, principal/SID resolution, and the
# display-name -> policy-key maps used by the Secedit, UserRightsAssignment,
# and AuditPolicy dispatch arms. Dot-sourcing runs in the caller's scope,
# so the $script: state and functions defined here are shared with the
# dispatcher.

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
        # Fully-qualified so an attacker-planted secedit.exe earlier in the
        # search path can't run in our place under elevation.
        $secedit = Join-Path $env:SystemRoot 'System32\secedit.exe'
        $proc = Start-Process -FilePath $secedit `
            -ArgumentList @('/export', '/cfg', $tmp, '/quiet') `
            -Wait -PassThru -NoNewWindow -ErrorAction Stop
        if ($proc.ExitCode -ne 0) {
            throw [System.UnauthorizedAccessException]::new(
                "secedit /export exited with code $($proc.ExitCode); typically means administrator is required"
            )
        }
        # secedit writes the INI without a byte-order mark as UTF-8 on
        # current Windows; some builds emit UTF-16 with a BOM. This
        # StreamReader honors a BOM when present and reads a BOM-less file
        # as UTF-8, so the section parse below sees real text either way.
        $reader = New-Object System.IO.StreamReader($tmp, [System.Text.Encoding]::UTF8, $true)
        try {
            $content = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
        $lines = $content -split "`r`n|`r|`n"
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
        # secedit always emits [System Access] on a successful export; its
        # absence means the file was empty, truncated, or otherwise didn't
        # contain real policy data. Caching that would have every later
        # lookup miss and report "Not configured" -- which is a lie, since
        # we never actually saw the policy state.
        if (-not $cache.ContainsKey('System Access')) {
            throw [System.IO.InvalidDataException]::new(
                'secedit /export produced no [System Access] section; policy could not be read'
            )
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

# Reads the effective audit policy through the Windows security-audit API
# (AuditQuerySystemPolicy), keyed by subcategory GUID. The API returns a
# numeric success/failure bitmask, so the read is independent of the
# display language; auditpol's CSV "Inclusion Setting" column is localized
# and breaks string matching on non-English Windows. The query needs
# SeSecurityPrivilege, which the helper enables in the already-elevated
# scan token; AuditLookupSubCategoryName supplies the readable name.
function Initialize-AuditPolicyApi {
    if (([System.Management.Automation.PSTypeName]'BlAuditPolicy').Type) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BlAuditPolicy {
    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIT_POLICY_INFORMATION {
        public Guid AuditSubCategoryGuid;
        public uint AuditingInformation;
        public Guid AuditCategoryGuid;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privilege; }

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool AuditQuerySystemPolicy(
        Guid[] pSubCategoryGuids, uint dwPolicyCount, out IntPtr ppAuditPolicy);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool AuditLookupSubCategoryName(
        ref Guid pAuditSubCategoryGuid, out IntPtr ppszSubCategoryName);
    [DllImport("advapi32.dll")]
    private static extern void AuditFree(IntPtr buffer);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint SE_PRIVILEGE_ENABLED = 0x00000002;

    private static void EnableSecurityPrivilege() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) { return; }
        try {
            LUID luid;
            if (!LookupPrivilegeValue(null, "SeSecurityPrivilege", out luid)) { return; }
            TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
            tp.PrivilegeCount = 1;
            tp.Privilege.Luid = luid;
            tp.Privilege.Attributes = SE_PRIVILEGE_ENABLED;
            AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
        } finally {
            CloseHandle(token);
        }
    }

    public static int QueryMode(Guid subcategory, out int lastError) {
        lastError = 0;
        EnableSecurityPrivilege();
        Guid[] guids = new Guid[] { subcategory };
        IntPtr buffer;
        if (!AuditQuerySystemPolicy(guids, 1, out buffer) || buffer == IntPtr.Zero) {
            lastError = Marshal.GetLastWin32Error();
            return -1;
        }
        try {
            AUDIT_POLICY_INFORMATION info = (AUDIT_POLICY_INFORMATION)
                Marshal.PtrToStructure(buffer, typeof(AUDIT_POLICY_INFORMATION));
            return (int)info.AuditingInformation;
        } finally {
            AuditFree(buffer);
        }
    }

    public static string LookupName(Guid subcategory) {
        IntPtr namePtr;
        if (!AuditLookupSubCategoryName(ref subcategory, out namePtr) || namePtr == IntPtr.Zero) {
            return null;
        }
        try {
            return Marshal.PtrToStringUni(namePtr);
        } finally {
            AuditFree(namePtr);
        }
    }
}
'@
}

# Canonical audit mode (NoAuditing/Success/Failure/SuccessAndFailure) for a
# subcategory GUID. An unconfigured subcategory reads as 0 -> NoAuditing,
# the same effective state auditpol reports for an absent entry. Throws on
# an API failure so the per-rec catch reports it; a privilege/access error
# surfaces as "Requires elevation".
function Get-AuditSubcategoryMode {
    param([Parameter(Mandatory)][string]$Guid)
    Initialize-AuditPolicyApi
    $err = 0
    $bits = [BlAuditPolicy]::QueryMode([Guid]$Guid, [ref]$err)
    if ($bits -lt 0) {
        if ($err -eq 1314 -or $err -eq 5) {
            throw [System.UnauthorizedAccessException]::new(
                "Audit policy query requires elevation (Win32 error $err)")
        }
        throw "AuditQuerySystemPolicy failed for ${Guid} (Win32 error $err)"
    }
    $success = ($bits -band 1) -ne 0
    $failure = ($bits -band 2) -ne 0
    if ($success -and $failure) { return 'SuccessAndFailure' }
    if ($success) { return 'Success' }
    if ($failure) { return 'Failure' }
    return 'NoAuditing'
}

# Readable subcategory name for a GUID, falling back to the GUID itself
# when the lookup returns nothing (e.g. an invalid GUID).
function Get-AuditSubcategoryName {
    param([Parameter(Mandatory)][string]$Guid)
    Initialize-AuditPolicyApi
    $name = [BlAuditPolicy]::LookupName([Guid]$Guid)
    if ([string]::IsNullOrWhiteSpace($name)) { return $Guid }
    return $name
}

# Built-in groups and well-known accounts named by URA recs, mapped to
# their SID. The actual side reads SIDs from secedit, so resolving the
# benchmark's English names to SIDs here keeps the comparison working on
# non-English Windows, where the built-in group names are localized
# (Administratoren, Administradores) and translating the English name
# returns nothing. SID values are from the Microsoft well-known SID
# reference. Names with a domain prefix (NT SERVICE\..., Window Manager\...)
# are not localized and resolve through NTAccount below.
$script:well_known_sids = @{
    'Administrators'       = 'S-1-5-32-544'
    'Users'                = 'S-1-5-32-545'
    'Guests'               = 'S-1-5-32-546'
    'Remote Desktop Users' = 'S-1-5-32-555'
    'Local account'        = 'S-1-5-113'
    'SERVICE'              = 'S-1-5-6'
    'LOCAL SERVICE'        = 'S-1-5-19'
    'NETWORK SERVICE'      = 'S-1-5-20'
}

# Resolves a principal identifier (raw SID, well-known name, or
# DOMAIN\Account form) to its SID string. Well-known names resolve from
# the locale-independent map; everything else goes through NTAccount.
# Returns $null when the identifier can't be resolved on this device --
# the URA comparison treats that as "missing from the actual set."
function Resolve-PrincipalToSid {
    param([Parameter(Mandatory)][string]$Identifier)
    if ($Identifier -match '^S-\d-\d+(-\d+)*$') { return $Identifier }
    if ($script:well_known_sids.ContainsKey($Identifier)) {
        return $script:well_known_sids[$Identifier]
    }
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
    'Network access: Allow anonymous SID/Name translation'                       = 'LSAAnonymousNameLookup'
    'Network security: Force logoff when logon hours expire'                     = 'ForceLogoffWhenHourExpire'
}
