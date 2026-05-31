<#
.SYNOPSIS
Signs a single file with Azure Artifact Signing via the Windows SDK signtool.

.DESCRIPTION
Invoked by Tauri's bundle.windows.signCommand with the target file as the
sole argument. Resolves signtool from PATH or the installed Windows 10 SDK,
then signs and timestamps the file. The signing dlib and the account
metadata file are supplied through the AZURE_SIGN_DLIB and AZURE_SIGN_METADATA
environment variables, so the same command works on a developer machine and
on a CI runner. Authentication is handled by the dlib's DefaultAzureCredential
chain (az login locally, OIDC federation in CI).
#>
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = 'Stop'

# Temporary diagnostic: Tauri swallows this command's output on failure, so
# record the resolved file argument to a log the CI workflow dumps afterward.
if ($env:GITHUB_WORKSPACE) {
    Add-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'sign-debug.log') `
        -Value "invoked with file=[$File] cwd=$((Get-Location).Path)"
}

$signtool = $null
$onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($onPath) {
    $signtool = $onPath.Source
}
else {
    $candidate = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1
    if ($candidate) {
        $signtool = $candidate.FullName
    }
}
if (-not $signtool) {
    throw 'signtool.exe not found on PATH or under the Windows 10 SDK.'
}

& $signtool sign /v /fd SHA256 `
    /tr http://timestamp.acs.microsoft.com /td SHA256 `
    /dlib $env:AZURE_SIGN_DLIB /dmdf $env:AZURE_SIGN_METADATA $File
if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
}
