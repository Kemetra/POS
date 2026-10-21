<#
.SYNOPSIS
  RT-772 slice 1 - build ONE signed per-user NSIS LAB installer.

.DESCRIPTION
  Local only. Builds from a clean checkout (or a clean checkout plus the single
  throwaway fixture migration, see -LabFixtureMigration), signs with the lab test
  certificate from Cert:\CurrentUser\My, and writes the installer and a manifest
  (version, SHA-256, git SHA, signer) under OutRoot, OUTSIDE the repository.

  It never publishes, uploads, tags or commits anything, never imports a
  certificate into a trust store, and makes no timestamp call unless
  RT772_LAB_TSA_URL is set (an explicit owner decision).

  The shipped `electron-builder.yml` and the `dir` package are not used or changed.

.PARAMETER Version
  Build-time version stamped into the packaged app (extraMetadata); package.json is not edited.

.PARAMETER LabFixtureMigration
  Allow exactly one untracked file, migrations/9999_rt772_lab_fixture.sql, so a
  0.1.1 lab build can carry a schema step that 0.1.0 does not know (snapshot and
  SchemaAheadGuard drill). The file is never committed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$OutRoot = 'D:\rt772-lab',
  [string]$CertSha1 = $env:RT772_LAB_CERT_SHA1,
  [switch]$LabFixtureMigration,
  [switch]$AllowDirtyAppInputs
)

$ErrorActionPreference = 'Stop'
$marker = 'LAB TEST - NOT FOR PRODUCTION'
$fixtureRel = 'migrations/9999_rt772_lab_fixture.sql'

$repo = (git rev-parse --show-toplevel).Trim()
Set-Location $repo
if (-not (Test-Path 'electron-builder.lab.yml')) { throw 'run from a checkout that contains electron-builder.lab.yml' }

# 1. The packaged app must be exactly the recorded commit: nothing that ends up in
#    the app (src, migrations, manifests, the shipped builder config) may differ from
#    HEAD. The lab scripts and docs themselves may be uncommitted. The one allowed
#    extra is the throwaway fixture migration, on request.
$appPaths = '^..\s+(src/|migrations/|package(-lock)?\.json|electron-builder\.yml|vite\.|tsconfig|postcss|tailwind)'
$dirty = @(git status --porcelain -uall | Where-Object { $_ -match $appPaths })
if ($LabFixtureMigration) {
  if (-not (Test-Path $fixtureRel)) { throw "-LabFixtureMigration needs $fixtureRel to exist" }
  $dirty = @($dirty | Where-Object { $_ -notmatch [regex]::Escape($fixtureRel) })
} elseif (Test-Path $fixtureRel) {
  throw "$fixtureRel exists but -LabFixtureMigration was not given"
}
# -AllowDirtyAppInputs builds work that is not committed yet. It is never silent: the
# manifest records the blob id of every differing file, so the exact app content can be
# reproduced or checked against a later commit (`git hash-object <path>`).
$dirtyInputs = @()
if ($dirty.Count -gt 0) {
  if (-not $AllowDirtyAppInputs) { throw "app inputs differ from HEAD (use -AllowDirtyAppInputs to record them):`n$($dirty -join "`n")" }
  $dirtyInputs = @($dirty | ForEach-Object {
    $rel = ($_.Substring(3).Trim('"') -split ' -> ')[-1]
    $blob = if (Test-Path -LiteralPath $rel) { (git hash-object -- $rel).Trim() } else { 'DELETED' }
    [ordered]@{ path = $rel; status = $_.Substring(0, 2).Trim(); blob = $blob }
  })
}
$gitSha = (git rev-parse HEAD).Trim()
$labFilesUncommitted = @(git status --porcelain -- scripts/lab electron-builder.lab.yml docs/runbook | Where-Object { $_ }).Count -gt 0

# 2. Lab certificate must exist and carry the lab marker.
if (-not $CertSha1) { throw 'set -CertSha1 or RT772_LAB_CERT_SHA1 (see new-lab-signing-cert.ps1)' }
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertSha1"
if ($cert.Subject -notlike "*$marker*") { throw "certificate subject is not a lab certificate: $($cert.Subject)" }
$env:RT772_LAB_CERT_SHA1 = $cert.Thumbprint

# A stray production signing variable must never reach this build.
foreach ($name in 'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD') {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

# 3. Build and package.
$label = if ($LabFixtureMigration) { "$Version-fixture" } else { $Version }
$out = Join-Path $OutRoot "out\$label"
New-Item -ItemType Directory -Force -Path $out | Out-Null

npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
npx electron-builder --win --config electron-builder.lab.yml --publish never `
  "-c.extraMetadata.version=$Version" "-c.directories.output=$out"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

# 4. Record the artifact. Status is NOT required to be Valid here: this machine
#    does not trust the lab root. It must be signed by the lab certificate, though.
$installer = Get-ChildItem -LiteralPath $out -Filter "POS-Pulse-LAB-Setup-$Version.exe" | Select-Object -First 1
if (-not $installer) { throw "installer not found in $out" }
$sig = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
  throw "installer is not signed by the lab certificate (status $($sig.Status))"
}
if ($sig.Status -eq 'HashMismatch') { throw 'signature hash mismatch' }

$manifest = [ordered]@{
  version          = $Version
  installer        = $installer.Name
  sha256           = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash
  sizeBytes        = $installer.Length
  gitSha           = $gitSha
  labFilesUncommitted = $labFilesUncommitted
  dirtyAppInputs   = $dirtyInputs
  fixtureMigration = [bool]$LabFixtureMigration
  signerSubject    = $sig.SignerCertificate.Subject
  signerThumbprint = $sig.SignerCertificate.Thumbprint
  signatureStatusOnBuildMachine = [string]$sig.Status
  timestamped      = [bool]$sig.TimeStamperCertificate
  builtAtUtc       = (Get-Date).ToUniversalTime().ToString('o')
}
$manifestPath = Join-Path $out 'lab-manifest.json'
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $manifestPath
Write-Host ''
Write-Host "installer : $($installer.FullName)"
Write-Host "sha256    : $($manifest.sha256)"
Write-Host "manifest  : $manifestPath"
Write-Host "status on build machine: $($sig.Status) (expected NotTrusted/UnknownError: the lab root is trusted only on the lab device)"
