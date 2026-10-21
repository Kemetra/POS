<#
.SYNOPSIS
  RT-772 slice 1 - create the LAB-ONLY self-signed code-signing certificates.

.DESCRIPTION
  Creates (or reuses) a lab root CA and a code-signing leaf in Cert:\CurrentUser\My
  with NON-EXPORTABLE keys, and exports ONLY the public root to OutDir so it can be
  imported on the disposable lab device (Windows Sandbox / VM) by its owner.

  This script never imports anything into a trust store (Root, TrustedPublisher),
  on this machine or any other. The subject carries "LAB TEST - NOT FOR PRODUCTION",
  so a production publisher pin can never match it. No private key is written to disk.

  Prints the leaf thumbprint; pass it to build-lab-installer.ps1 (or set
  RT772_LAB_CERT_SHA1).
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'D:\rt772-lab\certs',
  [int]$LeafDays = 90,
  [int]$RootDays = 180
)

$ErrorActionPreference = 'Stop'

$marker = 'LAB TEST - NOT FOR PRODUCTION'
$rootSubject = "CN=Kemetra POS $marker ROOT"
$leafSubject = "CN=Kemetra POS $marker"
$store = 'Cert:\CurrentUser\My'
$minRemaining = (Get-Date).AddDays(7)

function Find-Valid([string]$subject) {
  Get-ChildItem $store | Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt $minRemaining -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
}

# True only when $leaf was issued by exactly $root (not merely by a root with the same name) and
# outlives neither it: a leaf from an earlier root must never be reused under a new one.
function Test-IssuedBy($leaf, $root) {
  if ($leaf.NotAfter -gt $root.NotAfter) { return $false }
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    # The lab root is deliberately untrusted here; only the issuer link is being checked.
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
    if (-not $chain.Build($leaf)) { return $false }
    return ($chain.ChainElements.Count -ge 2) -and ($chain.ChainElements[1].Certificate.Thumbprint -eq $root.Thumbprint)
  } finally {
    $chain.Reset()
  }
}

$root = Find-Valid $rootSubject
if (-not $root) {
  $root = New-SelfSignedCertificate -Type Custom -Subject $rootSubject `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable -CertStoreLocation $store `
    -NotAfter (Get-Date).AddDays($RootDays) `
    -TextExtension @('2.5.29.19={critical}{text}CA=true&pathlength=0')
  Write-Host "created lab root  $($root.Thumbprint)"
} else {
  Write-Host "reusing lab root  $($root.Thumbprint) (expires $($root.NotAfter.ToString('yyyy-MM-dd')))"
}

$leaf = Find-Valid $leafSubject
if (-not $leaf -or -not (Test-IssuedBy $leaf $root)) {
  # A leaf never outlives its root.
  $leafNotAfter = (Get-Date).AddDays($LeafDays)
  if ($leafNotAfter -gt $root.NotAfter) { $leafNotAfter = $root.NotAfter }
  $leaf = New-SelfSignedCertificate -Type CodeSigningCert -Subject $leafSubject -Signer $root `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable -CertStoreLocation $store `
    -NotAfter $leafNotAfter
  Write-Host "created lab leaf  $($leaf.Thumbprint)"
} else {
  Write-Host "reusing lab leaf  $($leaf.Thumbprint) (expires $($leaf.NotAfter.ToString('yyyy-MM-dd')))"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$rootCer = Join-Path $OutDir 'rt772-lab-root.cer'
Export-Certificate -Cert $root -FilePath $rootCer -Force | Out-Null

Write-Host ''
Write-Host "RT772_LAB_CERT_SHA1 = $($leaf.Thumbprint)"
Write-Host "public lab root    = $rootCer"
Write-Host 'Import the public root ONLY on the disposable lab device. It is not trusted on this machine.'
