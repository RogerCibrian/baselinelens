# Reads device identity and management state from the local machine and
# emits a single compact JSON object on stdout:
#   { hostname, osName, osVersion, osBuild, managedBy: { intune, groupPolicy } }
#
# Designed to be invoked standalone (Rust 'get_device_info' command on
# the onboarding screen) and dot-sourced by audit.ps1 (which adds the
# NDJSON 'type' tag and emits via its own sink helper).
#
# Best-effort throughout: any field we can't read falls back to an empty
# string / false rather than throwing.

[CmdletBinding()]
param(
    # Emit the device-info JSON on stdout. The standalone onboarding
    # invocation passes this; the audit launcher dot-sources this file
    # only for Get-BlDeviceInfo and leaves it off, so no stray line
    # reaches the NDJSON stream.
    [switch]$Emit
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-BlDeviceInfo {
    # OS identity comes from two sources:
    #   - osName from Win32_OperatingSystem.Caption (CIM), the string
    #     Microsoft keeps current. ProductName in the registry still
    #     reads "Windows 10 Pro" on Win11 because MS abandoned it.
    #   - DisplayVersion ("24H2") and UBR (patch revision) from
    #     HKLM:\...\CurrentVersion. Build major comes from [Environment].
    $cv = $null
    try { $cv = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop } catch {}

    # Intune-enrolled devices have a client certificate in
    # LocalMachine\My issued by "Microsoft Intune MDM Device CA".
    $intune = $false
    try {
        $intune = [bool](Get-ChildItem -Path 'Cert:\LocalMachine\My' -ErrorAction Stop |
            Where-Object { $_.Issuer -match 'Microsoft Intune MDM Device CA' })
    } catch {}

    # `dsregcmd /status` reports DomainJoined (on-prem AD),
    # AzureAdJoined, and EnterpriseJoined. We read DomainJoined -- "YES"
    # means the device is joined to an AD domain, where Group Policy
    # applies.
    $gp = $false
    try {
        $dsregcmd = Join-Path $env:SystemRoot 'System32\dsregcmd.exe'
        $line = (& $dsregcmd /status | Select-String 'DomainJoined').ToString()
        $gp = ($line.Split(':')[1].Trim()) -eq 'YES'
    } catch {}

    $build_major = [Environment]::OSVersion.Version.Build
    $build_ubr = if ($cv -and $cv.PSObject.Properties['UBR']) { $cv.UBR } else { 0 }

    # Caption returns "Microsoft Windows 11 Pro" -- strip the prefix to
    # match the design's "Windows 11 Pro" form. Fall back to the
    # registry ProductName if CIM fails (rare on a healthy box).
    $os_name = ''
    try {
        $caption = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption
        $os_name = $caption -replace '^Microsoft ', ''
    } catch {
        if ($cv -and $cv.PSObject.Properties['ProductName']) { $os_name = [string]$cv.ProductName }
    }

    [ordered]@{
        hostname  = $env:COMPUTERNAME
        osName    = $os_name
        osVersion = if ($cv -and $cv.PSObject.Properties['DisplayVersion']) { [string]$cv.DisplayVersion } else { '' }
        osBuild   = "$build_major.$build_ubr"
        managedBy = [ordered]@{ intune = $intune; groupPolicy = $gp }
    }
}

if ($Emit) {
    Get-BlDeviceInfo | ConvertTo-Json -Compress -Depth 4
}
