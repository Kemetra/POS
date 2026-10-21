<#
.SYNOPSIS
  RT-803 (RT-322 S-E) P1 - LAB-ONLY automatic update N -> N+1 on an ephemeral GitHub-hosted Windows
  runner. Nothing is published or uploaded except a small evidence bundle.

.DESCRIPTION
  Builds two lab installers from the SAME commit that differ only in version (N and N+1), signed with
  ephemeral lab certificates. Installs N, serves N+1 from an isolated HTTPS feed on the reserved host
  rt772-lab.test (loopback, hosts entry, ephemeral TLS certificate), launches the installed N with the
  supported updater inputs in its process environment (ELECTRON_UPDATE_FEED_URL, POS_PULSE_UPDATE_CHANNEL=lab)
  and lets the real UpdateService check, download, verify and install at its app-start safe point.
  It then checks, from the app's own log (read for this session only), that N reported its version,
  went checking -> downloading -> downloaded -> installing, and that a later launch reports N+1.

  Boundaries (guarded by scripts/__tests__/lab-update-drill-workflow.test.ts):
  - signature verification, the publisher pin and TLS validation stay ON; no override of any kind;
  - the lab feed script is unchanged. Its Windows Sandbox location guard is overridden with
    -AllowOutsideSandbox ONLY after this script asserts a GitHub-hosted runner (owner decision D1);
  - it refuses to run anywhere else, because it edits LocalMachine\Root and the hosts file;
  - no key leaves the certificate store; only public certificates are copied to the evidence bundle;
  - production signing (RT-321), reboot, shift close and GUI automation are out of scope.

  Any failing check is recorded at its first failing boundary; nothing is retried or worked around.
  -Cleanup removes every trust, binding, hosts line and process this script created.
#>
[CmdletBinding()]
param(
  [string]$Evidence,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$VersionFrom = '0.1.0',
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$VersionTo = '0.1.1',
  [switch]$Cleanup
)

$ErrorActionPreference = 'Stop'
$marker = 'LAB TEST - NOT FOR PRODUCTION'
$feedHost = 'rt772-lab.test'
$feedPort = 8443
$feedOrigin = "https://${feedHost}:$feedPort/"
$hostsTag = '# RT-803-P1-LAB'
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$stepTimeoutSeconds = 420

if (-not $env:RUNNER_TEMP) {
  Write-Host 'RUNNER_TEMP is not set: this script only runs on a GitHub Actions runner'
  exit 2
}
$work = Join-Path $env:RUNNER_TEMP 'lab-p1'
$statePath = Join-Path $work 'state.json'
if (-not $Evidence) { $Evidence = Join-Path $env:RUNNER_TEMP 'evidence' }

function Get-LabState {
  if (-not (Test-Path -LiteralPath $statePath)) { return @{} }
  Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
}

# Everything that must be undone is written here BEFORE it is created, so -Cleanup can find it.
function Set-LabState([hashtable]$patch) {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $state = Get-LabState
  foreach ($key in $patch.Keys) { $state[$key] = $patch[$key] }
  $state | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statePath
}

function Remove-StoreCertificate([string]$store, [string]$thumbprint) {
  if ($thumbprint -notmatch '^[0-9A-F]{40}$') { return }
  $path = "Cert:\$store\$thumbprint"
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Remove-LabP1State {
  $state = Get-LabState
  if ($state.Count -eq 0) { return }
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($state.feedPid) { Get-Process -Id ([int]$state.feedPid) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($state.sslBound) { netsh http delete sslcert ipport=0.0.0.0:$feedPort 2>&1 | Out-Null }
  if ($state.hostsAdded -and (Test-Path -LiteralPath $hostsFile)) {
    $kept = @(Get-Content -LiteralPath $hostsFile | Where-Object { $_ -notmatch [regex]::Escape($hostsTag) })
    Set-Content -LiteralPath $hostsFile -Value $kept -Encoding ascii
  }
  Remove-StoreCertificate 'LocalMachine\Root' $state.tlsThumbprint
  Remove-StoreCertificate 'LocalMachine\My' $state.tlsThumbprint
  Remove-StoreCertificate 'LocalMachine\Root' $state.rootThumbprint
  Remove-StoreCertificate 'CurrentUser\My' $state.rootThumbprint
  Remove-StoreCertificate 'CurrentUser\My' $state.leafThumbprint
  Write-Host 'lab feed, hosts entry, TLS binding and lab certificates removed'
}

if ($Cleanup) { Remove-LabP1State; exit 0 }

# The runner assertion comes before anything is changed (certificate stores, hosts file, TLS binding).
if (-not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted')) {
  Write-Host 'refused: the P1 update drill runs only on a GitHub-hosted runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted)'
  exit 2
}

$repo = (git rev-parse --show-toplevel).Trim()
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

# True when none of the items is missing ($null, $false or empty).
function Test-AllPresent([object[]]$items) {
  return @($items | Where-Object { -not $_ }).Count -eq 0
}

function Get-RunnerFacts {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $facts = [ordered]@{
    gitSha = (git rev-parse HEAD).Trim()
    imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
    os = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version)" })
    user = $env:USERNAME; isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    sessionId = (Get-Process -Id $PID).SessionId
    explorerRunning = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
    signtool = (Find-Signtool)
    versionFrom = $VersionFrom; versionTo = $VersionTo; feedOrigin = $feedOrigin
  }
  $facts | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Evidence 'runner-facts.json')
  $ok = ($null -ne $facts.signtool) -and $facts.isAdmin -and ([version]$VersionTo -gt [version]$VersionFrom)
  Add-Result 'P1-1 runner facts' $ok "admin=$($facts.isAdmin) signtool=$($facts.signtool) session=$($facts.sessionId) explorer=$($facts.explorerRunning) image=$($env:ImageVersion) $VersionFrom -> $VersionTo"
  return $facts
}

function New-LabCertificates($ctx) {
  $certDir = Join-Path $work 'certs'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\lab\new-lab-signing-cert.ps1') -OutDir $certDir *>&1 | Tee-Object -FilePath (Join-Path $Evidence 'new-lab-cert.log') | Out-Null
  $leaf = Find-LabCertificate "CN=Kemetra POS $marker"
  $root = Find-LabCertificate "CN=Kemetra POS $marker ROOT"
  $rootCer = Join-Path $certDir 'rt772-lab-root.cer'
  if (-not (Test-AllPresent @($leaf, $root, (Test-Path -LiteralPath $rootCer)))) {
    Add-Result 'P1-2 lab certificates' $false 'leaf, root or the public root file is missing'
    return $false
  }
  Set-LabState @{ leafThumbprint = $leaf.Thumbprint; rootThumbprint = $root.Thumbprint }
  Copy-Item -LiteralPath $rootCer -Destination $Evidence
  $ctx.leaf = $leaf.Thumbprint; $ctx.rootCer = $rootCer
  Add-Result 'P1-2 lab certificates' $true "leaf=$($leaf.Thumbprint) root=$($root.Thumbprint) (public root only exported)"
  return $true
}

# One lab build from the checked-out commit; a clean tree is enforced by the build script.
function Build-LabInstaller($ctx, [string]$version, [string]$id) {
  $buildRoot = Join-Path $work 'build'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\lab\build-lab-installer.ps1') -Version $version -OutRoot $buildRoot -CertSha1 $ctx.leaf *>&1 | Tee-Object -FilePath (Join-Path $Evidence "build-$version.log") | Out-Null
  $out = Join-Path $buildRoot "out\$version"
  $build = @{
    version = $version; dir = $out
    installer = Join-Path $out "POS-Pulse-LAB-Setup-$version.exe"
    channelFile = Join-Path $out 'lab.yml'
  }
  $manifestPath = Join-Path $out 'lab-manifest.json'
  $produced = @($build.installer, $manifestPath, $build.channelFile) | ForEach-Object { Test-Path -LiteralPath $_ }
  if (-not (Test-AllPresent $produced)) {
    Add-Result $id $false 'installer, manifest or lab.yml missing'
    return $false
  }
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $Evidence "lab-manifest-$version.json")
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $build.sha256 = $m.sha256
  $ctx.builds[$version] = $build
  $clean = ($m.gitSha -eq $ctx.facts.gitSha) -and (@($m.dirtyAppInputs).Count -eq 0) -and (-not $m.labFilesUncommitted)
  Add-Result $id $clean "gitSha=$($m.gitSha) dirty=$(@($m.dirtyAppInputs).Count) sha256=$($m.sha256)"
  return $clean
}

function Invoke-SignatureCheck($build, [string]$evidenceFile) {
  $verify = Join-Path $repo 'scripts\lab\verify-lab-signature.ps1'
  $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verify -InstallerPath $build.installer -ExpectedSha256 $build.sha256 2>&1 | Out-String)
  $exit = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $Evidence $evidenceFile) -Value $text
  return $exit
}

# Authenticode: control before trust (must fail), then trust the PUBLIC root on this runner and verify both builds.
function Test-Authenticode($ctx) {
  $from = $ctx.builds[$VersionFrom]; $to = $ctx.builds[$VersionTo]
  $beforeExit = Invoke-SignatureCheck $from 'verify-before-trust.txt'
  Add-Result 'P1-4a signature refused before trust' ($beforeExit -ne 0) "exit=$beforeExit (the root is not trusted yet)"
  Import-Certificate -FilePath $ctx.rootCer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  $fromExit = Invoke-SignatureCheck $from "verify-after-trust-$VersionFrom.txt"
  $toExit = Invoke-SignatureCheck $to "verify-after-trust-$VersionTo.txt"
  $ok = ($fromExit -eq 0) -and ($toExit -eq 0)
  Add-Result 'P1-4b signature valid after trust (N and N+1)' $ok "exit N=$fromExit N+1=$toExit publisher and sha256 checked by verify-lab-signature.ps1"
  return $ok
}

# The feed's own TLS certificate: ephemeral, self-signed, SAN rt772-lab.test, key stays in the machine store
# (HTTP.sys reads it there). Only its PUBLIC part is trusted, in LocalMachine\Root, and removed by -Cleanup.
function New-FeedCertificate($ctx) {
  $tls = New-SelfSignedCertificate -DnsName $feedHost -CertStoreLocation Cert:\LocalMachine\My `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
    -NotAfter (Get-Date).AddDays(2) -FriendlyName "RT-803 P1 lab feed TLS - $marker"
  Set-LabState @{ tlsThumbprint = $tls.Thumbprint }
  $cer = Join-Path $work 'rt803-feed-tls.cer'
  Export-Certificate -Cert $tls -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Copy-Item -LiteralPath $cer -Destination $Evidence
  $ctx.tls = $tls.Thumbprint
  Add-Result 'P1-5 feed TLS certificate' $true "thumbprint=$($tls.Thumbprint) san=$feedHost (public part trusted on the runner only)"
  return $true
}

function Get-FeedLogLines([string]$path) {
  # The feed process appends to this file; an unreadable log reads as empty, which fails a check loudly.
  try { @(Get-Content -LiteralPath $path -ErrorAction Stop) } catch { @() }
}

function Test-FeedStarted([string]$log) {
  return [bool]((Get-FeedLogLines $log) -match ' START ')
}

function Wait-FeedStart([string]$log, $feed) {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not $feed.HasExited) {
    if (Test-FeedStarted $log) { return $true }
    Start-Sleep -Seconds 1
  }
  return (Test-FeedStarted $log)
}

# Feed directory = the N+1 installer and its lab.yml, nothing else (no blockmap: a full download is used).
function Start-LabFeed($ctx) {
  $to = $ctx.builds[$VersionTo]
  $feedDir = Join-Path $work 'feed'
  New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
  Copy-Item -LiteralPath $to.installer, $to.channelFile -Destination $feedDir
  $channelText = Get-Content -LiteralPath (Join-Path $feedDir 'lab.yml') -Raw
  $ctx.feedLog = Join-Path $Evidence 'feed-requests.log'

  Set-LabState @{ hostsAdded = $true }
  Add-Content -LiteralPath $hostsFile -Value "127.0.0.1 $feedHost $hostsTag" -Encoding ascii
  ipconfig /flushdns | Out-Null

  Set-LabState @{ sslBound = $true }
  $serve = Join-Path $repo 'scripts\lab\serve-lab-feed.ps1'
  $serveArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$serve`"", '-Root', "`"$feedDir`"",
    '-CertThumbprint', $ctx.tls, '-HostName', $feedHost, '-Port', "$feedPort", '-RequestLog', "`"$($ctx.feedLog)`"", '-AllowOutsideSandbox')
  $feed = Start-Process -FilePath powershell.exe -ArgumentList $serveArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Evidence 'feed-stdout.log') -RedirectStandardError (Join-Path $Evidence 'feed-stderr.log')
  Set-LabState @{ feedPid = $feed.Id }

  if (-not (Wait-FeedStart $ctx.feedLog $feed)) {
    Add-Result 'P1-6 feed serves lab.yml over HTTPS' $false "feed did not start (exited=$($feed.HasExited)); see feed-stderr.log"
    return $false
  }

  # Probe over the same trust the app uses (Windows store): TLS, name resolution and content.
  $client = [System.Net.Http.HttpClient]::new()
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $response = $client.GetAsync($feedOrigin + 'lab.yml').GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $ok = $response.IsSuccessStatusCode -and ($body -match "(?m)^version:\s*$([regex]::Escape($VersionTo))\s*$")
    Add-Result 'P1-6 feed serves lab.yml over HTTPS' $ok "status=$([int]$response.StatusCode) version=$VersionTo origin=$feedOrigin"
    return $ok
  } catch {
    Add-Result 'P1-6 feed serves lab.yml over HTTPS' $false "probe failed: $($_.Exception.Message)"
    return $false
  } finally { $client.Dispose() }
}

function Get-InstalledExe {
  $key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'POS Pulse*' } | Select-Object -First 1
  if (-not ($key -and $key.UninstallString -match '^"([^"]+)"')) { return $null }
  [pscustomobject]@{ Exe = (Join-Path (Split-Path $Matches[1] -Parent) 'POS Pulse.exe'); Version = $key.DisplayVersion }
}

# Silent per-user install of N.
function Install-LabInstaller($ctx) {
  $proc = Start-Process -FilePath $ctx.builds[$VersionFrom].installer -ArgumentList '/S' -PassThru -Wait
  Start-Sleep -Seconds 3
  # The drill starts the app itself, with the updater inputs; stop anything the installer launched.
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $app = Get-InstalledExe
  $ok = ($proc.ExitCode -eq 0) -and $app -and (Test-Path -LiteralPath $app.Exe) -and ($app.Version -eq $VersionFrom)
  Add-Result 'P1-7 silent install of N' ([bool]$ok) "exit=$($proc.ExitCode) version=$($app.Version) expected=$VersionFrom exe=$($app.Exe)"
  if ($ok) { $ctx.exe = $app.Exe }
  return [bool]$ok
}

# The app's JSON log lines of THIS session only (logs accumulate across launches), oldest first.
function Get-SessionEvents([DateTimeOffset]$since) {
  $logs = Get-ChildItem (Join-Path $env:APPDATA 'pos-pulse\logs') -Filter 'main-*.log' -ErrorAction SilentlyContinue
  $events = foreach ($log in $logs) {
    foreach ($raw in (Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) {
      # The time is taken from the raw text: ConvertFrom-Json would turn it into a local DateTime.
      if ($raw -notmatch '"time":"([^"]+)"') { continue }
      $at = [DateTimeOffset]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
      if ($at -lt $since) { continue }
      try { $obj = $raw | ConvertFrom-Json } catch { continue }
      [pscustomobject]@{ at = $at; msg = [string]$obj.msg; to = [string]$obj.to; version = [string]$obj.version; appVersion = [string]$obj.app_version; raw = $raw }
    }
  }
  @($events | Sort-Object at)
}

$requiredStates = @('checking', 'downloading', 'downloaded', 'installing')

function Test-StateOrder($events) {
  $position = 0
  foreach ($entry in @($events | Where-Object { $_.msg -eq 'update:state' })) {
    if ($position -lt $requiredStates.Count -and $entry.to -eq $requiredStates[$position]) { $position++ }
  }
  return $position -eq $requiredStates.Count
}

function Get-RefusalEvents($events) {
  @($events | Where-Object {
    $_.msg -in 'update:refused', 'update:error' -or ($_.msg -eq 'update:state' -and $_.to -in 'verify_failed', 'verify_unavailable', 'error')
  })
}

# The updater's own words, in order, for the evidence bundle.
function Save-SessionEvidence($events) {
  $keep = @($events | Where-Object { $_.msg -like 'update:*' -or $_.msg -eq 'app:ready' } | ForEach-Object { $_.raw })
  Set-Content -LiteralPath (Join-Path $Evidence 'update-session-lines.jsonl') -Value $keep
  $logs = Join-Path $env:APPDATA 'pos-pulse\logs'
  if (Test-Path -LiteralPath $logs) { Copy-Item -LiteralPath $logs -Destination (Join-Path $Evidence 'userdata-logs') -Recurse -Force }
}

function Get-RunningAppInfo {
  $proc = Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
  if (-not $proc) { return $null }
  try {
    $info = $proc.MainModule.FileVersionInfo
    return [ordered]@{ path = $proc.MainModule.FileName; fileVersion = $info.FileVersion; productVersion = $info.ProductVersion; startedUtc = $proc.StartTime.ToUniversalTime().ToString('o') }
  } catch { return [ordered]@{ error = $_.Exception.Message } }
}

# Launch N with the supported updater inputs and wait for the real UpdateService to take it to N+1.
function Invoke-UpdateDrill($ctx) {
  $since = [DateTimeOffset]::UtcNow
  $ctx.launchedAt = $since
  $env:ELECTRON_UPDATE_FEED_URL = $feedOrigin
  $env:POS_PULSE_UPDATE_CHANNEL = 'lab'
  try { Start-Process -FilePath $ctx.exe | Out-Null }
  finally { Remove-Item Env:ELECTRON_UPDATE_FEED_URL, Env:POS_PULSE_UPDATE_CHANNEL -ErrorAction SilentlyContinue }

  $deadline = (Get-Date).AddSeconds($stepTimeoutSeconds)
  do {
    Start-Sleep -Seconds 5
    $events = Get-SessionEvents $since
    $installing = $events | Where-Object { $_.msg -eq 'update:state' -and $_.to -eq 'installing' } | Select-Object -First 1
    $relaunched = if ($installing) { @($events | Where-Object { $_.msg -eq 'app:ready' -and $_.at -gt $installing.at }) } else { @() }
    $refusals = Get-RefusalEvents $events
  } until ($refusals.Count -gt 0 -or $relaunched.Count -gt 0 -or (Get-Date) -gt $deadline)
  Start-Sleep -Seconds 10
  Save-Screenshot 'shot-after-update'
  $events = Get-SessionEvents $since
  Save-SessionEvidence $events
  $app = Get-InstalledExe
  $running = Get-RunningAppInfo
  [ordered]@{ registryVersion = $app.Version; exe = $app.Exe; runningProcess = $running } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Evidence 'installed-after.json')
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  return (Confirm-UpdateEvidence $events $app $running)
}

function Confirm-UpdateEvidence($events, $app, $running) {
  if (-not (Confirm-UpdateStart $events)) { return $false }
  if (-not (Confirm-UpdateOrder $events)) { return $false }
  return (Confirm-Relaunch $events $app $running)
}

# N starts, reports its own version, and has the updater enabled.
function Confirm-UpdateStart($events) {
  $firstReady = $events | Where-Object { $_.msg -eq 'app:ready' } | Select-Object -First 1
  $enabled = $events | Where-Object { $_.msg -eq 'update:enabled' } | Select-Object -First 1
  $versionOk = $firstReady.appVersion -eq $VersionFrom
  $startOk = $versionOk -and [bool]$enabled
  Add-Result 'P1-8 installed N starts with the updater enabled' $startOk "appReadyVersion=$($firstReady.appVersion) expected=$VersionFrom updateEnabled=$([bool]$enabled)"
  return $startOk
}

function Confirm-UpdateOrder($events) {
  $refusals = Get-RefusalEvents $events
  $orderOk = (Test-StateOrder $events) -and ($refusals.Count -eq 0)
  $seen = (@($events | Where-Object { $_.msg -eq 'update:state' } | ForEach-Object { $_.to }) -join ',')
  Add-Result 'P1-9 checking, downloading, downloaded, installing in order' $orderOk "states=$seen refusals=$($refusals.Count)"
  return $orderOk
}

# Launches of the new version after the updater started the install.
function Get-RelaunchEvents($events, $installing) {
  @($events | Where-Object { $_.msg -eq 'app:ready' } | Where-Object { $_.at -gt $installing.at } | Where-Object { $_.appVersion -eq $VersionTo })
}

function Test-StartedAfter($running, $installing) {
  if (-not $running.startedUtc) { return $false }
  return [DateTimeOffset]::Parse($running.startedUtc) -gt $installing.at
}

# The app itself reports N+1 after the install, the registry agrees, and the process is a new one.
function Confirm-Relaunch($events, $app, $running) {
  $installing = $events | Where-Object { $_.msg -eq 'update:state' -and $_.to -eq 'installing' } | Select-Object -First 1
  $relaunched = @(Get-RelaunchEvents $events $installing)
  $checks = @(($relaunched.Count -gt 0), ($app.Version -eq $VersionTo), (Test-StartedAfter $running $installing))
  $ok = $checks -notcontains $false
  Add-Result 'P1-10 relaunched into N+1' $ok "relaunchReadyVersion=$($relaunched[0].appVersion) registry=$($app.Version) expected=$VersionTo process=$($running.path) fileVersion=$($running.fileVersion)"
  return $ok
}

# The feed log (requests since the app launch, so the readiness probe does not count) must show the real download.
function Test-FeedLog($ctx) {
  $installerName = "POS-Pulse-LAB-Setup-$VersionTo.exe"
  $size = (Get-Item -LiteralPath $ctx.builds[$VersionTo].installer).Length
  $lines = @(Get-FeedLogLines $ctx.feedLog | Where-Object { $_ -match ' (GET|HEAD) ' -and [DateTimeOffset]::Parse(($_ -split ' ')[0], [Globalization.CultureInfo]::InvariantCulture) -ge $ctx.launchedAt })
  $channelGet = @($lines | Where-Object { $_ -match " GET /lab\.yml 200 " }).Count
  $installerGet = @($lines | Where-Object { $_ -match " GET /$([regex]::Escape($installerName)) 200 $size$" }).Count
  $ok = ($channelGet -ge 1) -and ($installerGet -ge 1)
  Add-Result 'P1-11 feed log shows the N+1 download' $ok "since app launch: lab.yml GETs=$channelGet, installer GETs 200 with $size bytes=$installerGet"
  return $ok
}

# The bundle must hold no key material.
function Test-EvidenceBundle {
  $hits = @(Get-ChildItem -LiteralPath $Evidence -Recurse -File | Where-Object { $_.Extension -in '.log', '.txt', '.json', '.jsonl', '.cer' } |
    Select-String -Pattern 'BEGIN (RSA |EC )?PRIVATE KEY', '\.p[f]x' -List)
  Add-Result 'P1-12 evidence bundle holds no key material' ($hits.Count -eq 0) "matches=$($hits.Count)"
}

function Invoke-P1 {
  $ctx = @{ builds = @{} }
  $ctx.facts = Get-RunnerFacts
  $phases = @(
    { $results[0].result -eq 'PASS' },
    { New-LabCertificates $ctx },
    { Build-LabInstaller $ctx $VersionFrom 'P1-3a build N' },
    { Build-LabInstaller $ctx $VersionTo 'P1-3b build N+1 (same commit)' },
    { Test-Authenticode $ctx },
    { New-FeedCertificate $ctx },
    { Start-LabFeed $ctx },
    { Install-LabInstaller $ctx },
    { Invoke-UpdateDrill $ctx }
  )
  try {
    foreach ($phase in $phases) { if (-not (& $phase)) { return } }
    Test-FeedLog $ctx | Out-Null
    Test-EvidenceBundle
  } finally {
    # The feed child holds redirected handles of this step; stop it here so the step can end.
    # The binding, hosts line and certificates are left to -Cleanup (which stops it again harmlessly).
    $feedPid = (Get-LabState).feedPid
    if ($feedPid) { Get-Process -Id ([int]$feedPid) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  }
}

Invoke-P1
if ($failed) { exit 1 }
