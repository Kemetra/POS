<#
.SYNOPSIS
  RT-803 (RT-322 S-E) P0 spike - build, sign, trust, install and launch ONE lab NSIS installer on an
  ephemeral GitHub Actions Windows runner. LAB ONLY: nothing is published or uploaded except a small
  evidence bundle (logs, manifest, public root certificate, one screenshot).

.DESCRIPTION
  It proves only that the runner can do what the Windows Sandbox drill needs: find signtool, create the
  lab certificates in CurrentUser\My (non-exportable, subject marker `LAB TEST - NOT FOR PRODUCTION`), build
  the lab installer with `build-lab-installer.ps1`, trust the PUBLIC lab root on the runner, verify the
  Authenticode signature the way electron-updater does, install silently and launch the packaged app.
  It does not run any of the eight RT-322 S-D cases. Any failing check is recorded at its first failing
  boundary; nothing is retried or worked around.

  No secret is used and no key is written to disk. `-Cleanup` removes the lab certificates again.
#>
[CmdletBinding()]
param(
  [string]$Evidence = (Join-Path $env:RUNNER_TEMP 'evidence'),
  [string]$Version = '0.1.0',
  [switch]$Cleanup
)

$ErrorActionPreference = 'Stop'
$marker = 'LAB TEST - NOT FOR PRODUCTION'
$work = Join-Path $env:RUNNER_TEMP 'lab-spike'
$statePath = Join-Path $work 'state.json'
$repo = (git rev-parse --show-toplevel).Trim()

function Remove-LabTrust {
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($path in @("Cert:\LocalMachine\Root\$($state.rootThumbprint)", "Cert:\CurrentUser\My\$($state.rootThumbprint)", "Cert:\CurrentUser\My\$($state.leafThumbprint)")) {
    if ($path -notmatch '\\[0-9A-F]{40}$') { continue }
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  Write-Host 'lab certificates removed from LocalMachine\Root and CurrentUser\My'
}

if ($Cleanup) { Remove-LabTrust; exit 0 }

New-Item -ItemType Directory -Force -Path $Evidence, $work | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$failed = $false

function Add-Result([string]$id, [bool]$ok, [string]$detail) {
  $results.Add([pscustomobject]@{ id = $id; result = $(if ($ok) { 'PASS' } else { 'FAIL' }); detail = $detail })
  Write-Host ("[{0}] {1}: {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $id, $detail)
  if (-not $ok) { $script:failed = $true }
  $results | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Evidence 'results.json')
}

function Save-Screenshot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Evidence "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "screenshot $name failed: $($_.Exception.Message)" }
}

function Find-Signtool {
  $bin = 'C:\Program Files (x86)\Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $bin)) { return $null }
  Get-ChildItem -LiteralPath $bin -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}

function Find-LabCertificate([string]$subject) {
  Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject } | Sort-Object NotAfter -Descending | Select-Object -First 1
}

# Each phase returns $true to continue, or $false after recording its first failing boundary.

# Runner facts (read-only).
function Get-RunnerFacts {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $sac = try { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState } catch { 'absent' }
  $facts = [ordered]@{
    gitSha = (git rev-parse HEAD).Trim()
    imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
    os = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version)" })
    user = $env:USERNAME; isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    sessionId = (Get-Process -Id $PID).SessionId
    explorerRunning = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
    smartAppControlState = "$sac"
    signtool = (Find-Signtool)
  }
  $facts | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Evidence 'runner-facts.json')
  Add-Result 'P0-1 runner facts' ($null -ne $facts.signtool) "signtool=$($facts.signtool) admin=$($facts.isAdmin) session=$($facts.sessionId) explorer=$($facts.explorerRunning) SAC=$sac image=$($env:ImageVersion)"
  return $facts
}

# Ephemeral lab certificates (existing script; non-exportable keys; only the public root leaves the store).
function New-LabCertificates($ctx) {
  $certDir = Join-Path $work 'certs'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\lab\new-lab-signing-cert.ps1') -OutDir $certDir *>&1 | Tee-Object -FilePath (Join-Path $Evidence 'new-lab-cert.log')
  $leaf = Find-LabCertificate "CN=Kemetra POS $marker"
  $root = Find-LabCertificate "CN=Kemetra POS $marker ROOT"
  $rootCer = Join-Path $certDir 'rt772-lab-root.cer'
  $haveRootFile = Test-Path -LiteralPath $rootCer
  $haveCerts = ($null -ne $leaf) -and ($null -ne $root)
  if (-not $haveCerts) {
    Add-Result 'P0-2 lab certificates' $false 'leaf or root certificate missing from CurrentUser\My'
    return $false
  }
  if (-not $haveRootFile) {
    Add-Result 'P0-2 lab certificates' $false 'public root file was not exported'
    return $false
  }
  @{ leafThumbprint = $leaf.Thumbprint; rootThumbprint = $root.Thumbprint } | ConvertTo-Json | Set-Content -LiteralPath $statePath
  Copy-Item -LiteralPath $rootCer -Destination $Evidence
  $ctx.leaf = $leaf.Thumbprint; $ctx.rootCer = $rootCer
  Add-Result 'P0-2 lab certificates' $true "leaf=$($leaf.Thumbprint) root=$($root.Thumbprint) (public root only exported)"
  return $true
}

# Build and sign the lab installer from the checked-out commit (a clean tree is enforced by the script).
function Build-LabInstaller($ctx) {
  $buildRoot = Join-Path $work 'build'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\lab\build-lab-installer.ps1') -Version $Version -OutRoot $buildRoot -CertSha1 $ctx.leaf *>&1 | Tee-Object -FilePath (Join-Path $Evidence 'build.log')
  $out = Join-Path $buildRoot "out\$Version"
  $ctx.installer = Join-Path $out "POS-Pulse-LAB-Setup-$Version.exe"
  $manifestPath = Join-Path $out 'lab-manifest.json'
  if (-not ((Test-Path -LiteralPath $ctx.installer) -and (Test-Path -LiteralPath $manifestPath))) {
    Add-Result 'P0-3 build' $false 'installer or manifest missing'
    return $false
  }
  Copy-Item -LiteralPath $manifestPath -Destination $Evidence
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $ctx.sha256 = $m.sha256
  $clean = ($m.gitSha -eq $ctx.facts.gitSha) -and (@($m.dirtyAppInputs).Count -eq 0) -and (-not $m.labFilesUncommitted)
  Add-Result 'P0-3 build' $clean "gitSha=$($m.gitSha) dirty=$(@($m.dirtyAppInputs).Count) sha256=$($m.sha256)"
  return $clean
}

function Invoke-SignatureCheck($ctx, [string]$evidenceFile) {
  $verify = Join-Path $repo 'scripts\lab\verify-lab-signature.ps1'
  $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verify -InstallerPath $ctx.installer -ExpectedSha256 $ctx.sha256 2>&1 | Out-String)
  $exit = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $Evidence $evidenceFile) -Value $text
  return $exit
}

# Authenticode: control before trust (must fail), then trust the PUBLIC root on this runner and verify.
function Test-Authenticode($ctx) {
  $beforeExit = Invoke-SignatureCheck $ctx 'verify-before-trust.txt'
  Add-Result 'P0-4a signature refused before trust' ($beforeExit -ne 0) "exit=$beforeExit (the root is not trusted yet)"
  Import-Certificate -FilePath $ctx.rootCer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  $afterExit = Invoke-SignatureCheck $ctx 'verify-after-trust.txt'
  Add-Result 'P0-4b signature valid after trust' ($afterExit -eq 0) "exit=$afterExit publisher and sha256 checked by verify-lab-signature.ps1"
  return ($afterExit -eq 0)
}

function Get-InstalledExe {
  $key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'POS Pulse*' } | Select-Object -First 1
  if (-not ($key -and $key.UninstallString -match '^"([^"]+)"')) { return $null }
  [pscustomobject]@{ Exe = (Join-Path (Split-Path $Matches[1] -Parent) 'POS Pulse.exe'); Version = $key.DisplayVersion }
}

# Silent per-user install.
function Install-LabInstaller($ctx) {
  $proc = Start-Process -FilePath $ctx.installer -ArgumentList '/S' -PassThru -Wait
  Start-Sleep -Seconds 3
  $app = Get-InstalledExe
  $ok = ($proc.ExitCode -eq 0) -and $app -and (Test-Path -LiteralPath $app.Exe)
  Add-Result 'P0-5 silent install' ([bool]$ok) "exit=$($proc.ExitCode) version=$($app.Version) exe=$($app.Exe)"
  if ($ok) { $ctx.exe = $app.Exe }
  return [bool]$ok
}

function Read-MainLogs([string]$userData) {
  $logs = Get-ChildItem (Join-Path $userData 'logs') -Filter 'main-*.log' -ErrorAction SilentlyContinue
  if (-not $logs) { return '' }
  ($logs | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
}

# Launch the packaged app and read its own log (no update origin is set, so update:disabled no_origin is expected).
function Start-LabApp($ctx) {
  $ud = Join-Path $env:APPDATA 'pos-pulse'
  Start-Process -FilePath $ctx.exe | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  $logText = ''
  while ((Get-Date) -lt $deadline -and $logText -notmatch '"msg":"app:ready"') {
    Start-Sleep -Seconds 3
    $logText = Read-MainLogs $ud
  }
  Start-Sleep -Seconds 5
  Save-Screenshot 'shot-launch'
  $running = [bool](Get-Process 'POS Pulse' -ErrorAction SilentlyContinue)
  $ready = [bool]($logText -match '"msg":"app:ready"')
  $updateLines = @(($logText -split "`n") | Where-Object { $_ -match '"msg":"update:' })
  if (Test-Path (Join-Path $ud 'logs')) { Copy-Item (Join-Path $ud 'logs') (Join-Path $Evidence 'userdata-logs') -Recurse -Force }
  Set-Content -LiteralPath (Join-Path $Evidence 'update-lines.txt') -Value $updateLines
  Add-Result 'P0-6 packaged app launches' ($running -and $ready) "running=$running appReady=$ready updateLines=$($updateLines.Count)"
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# The bundle must hold no key material.
function Test-EvidenceBundle {
  $hits = @(Get-ChildItem -LiteralPath $Evidence -Recurse -File | Where-Object { $_.Extension -in '.log', '.txt', '.json', '.cer' } |
    Select-String -Pattern 'BEGIN (RSA |EC )?PRIVATE KEY', '\.p[f]x' -List)
  Add-Result 'P0-7 evidence bundle holds no key material' ($hits.Count -eq 0) "matches=$($hits.Count)"
}

function Invoke-Spike {
  $ctx = @{}
  $ctx.facts = Get-RunnerFacts
  $phases = @(
    { $null -ne $ctx.facts.signtool },
    { New-LabCertificates $ctx },
    { Build-LabInstaller $ctx },
    { Test-Authenticode $ctx },
    { Install-LabInstaller $ctx }
  )
  foreach ($phase in $phases) { if (-not (& $phase)) { return } }
  Start-LabApp $ctx
  Test-EvidenceBundle
}

Invoke-Spike
if ($failed) { exit 1 }
