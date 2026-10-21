<#
.SYNOPSIS
  RT-772 slice 1 - check a lab installer the way electron-updater will.

.DESCRIPTION
  electron-updater (Windows) runs Get-AuthenticodeSignature on the downloaded
  installer, requires Status == Valid (numeric 0), and matches the signer
  certificate's CN against the pinned publisherName. This script performs the same
  two checks, plus an optional SHA-256 comparison against the recorded manifest.

  Run it ON THE LAB DEVICE after importing the public lab root. On the build
  machine, where the root is not trusted, it is expected to FAIL (status is not
  Valid): that is the proof the trust is confined to the lab device.

  Compatible with Windows PowerShell 5.1 (the Windows Sandbox default).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [string]$ExpectedPublisher = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION',
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'

$sig = Get-AuthenticodeSignature -LiteralPath $InstallerPath
$subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
$cn = ''
if ($subject -match '(?:^|,\s*)CN=([^,]+)') { $cn = $Matches[1].Trim() }
$actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath).Hash

$checks = [ordered]@{
  status_valid     = ($sig.Status -eq 'Valid')
  publisher_match  = ($cn -ceq $ExpectedPublisher)
  sha256_match     = if ($ExpectedSha256) { $actualSha -eq $ExpectedSha256.ToUpper() } else { $null }
}

[pscustomobject]@{
  Installer     = $InstallerPath
  Status        = [string]$sig.Status
  StatusMessage = $sig.StatusMessage
  SignerSubject = $subject
  SignerThumb   = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { '' }
  Timestamped   = [bool]$sig.TimeStamperCertificate
  Sha256        = $actualSha
  Checks        = ($checks.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
} | Format-List | Out-String | Write-Host

$failed = $checks.GetEnumerator() | Where-Object { $_.Value -eq $false }
if ($failed) {
  Write-Host 'RESULT: FAIL (an updater would refuse this file)'
  exit 1
}
Write-Host 'RESULT: PASS (signature valid, publisher matches)'
exit 0
