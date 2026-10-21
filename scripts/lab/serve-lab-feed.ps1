<#
.SYNOPSIS
  RT-772 slice 2 - a LAB-ONLY static HTTPS update feed, for the disposable Windows Sandbox.

.DESCRIPTION
  Serves the files under -Root over HTTPS on https://<HostName>:<Port>/ so the packaged lab
  POS can be pointed at it with ELECTRON_UPDATE_FEED_URL. It is a plain static file server:
  GET and HEAD only, no directory listing, no Range support (so electron-updater falls back
  to a full download), and every request is logged.

  It refuses to run anywhere but inside the Windows Sandbox (user WDAGUtilityAccount) unless
  -AllowOutsideSandbox is given, and only for a reserved ".test" host, so a lab TLS feed can
  not be stood up by accident on a real machine or under a real domain.

  Prerequisite (done by the Sandbox driver, inside the Sandbox only): a TLS server
  certificate for the host name, trusted in the Sandbox's own store, and a hosts entry
  mapping the name to 127.0.0.1. The certificate is bound to the port here with netsh.
  Compatible with Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$CertThumbprint,
  [string]$HostName = 'rt772-lab.test',
  [int]$Port = 8443,
  [string]$RequestLog,
  [switch]$AllowOutsideSandbox
)

$ErrorActionPreference = 'Stop'

function Assert-LabFeedAllowed {
  if ($HostName -notlike '*.test') { throw 'the lab feed only serves a reserved .test host name' }
  if (-not $AllowOutsideSandbox -and $env:USERNAME -ne 'WDAGUtilityAccount') {
    throw 'the lab feed runs only inside the Windows Sandbox (pass -AllowOutsideSandbox to override)'
  }
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "feed root not found: $Root" }
}

function Write-Request([string]$method, [string]$path, [int]$status, [long]$bytes) {
  if (-not $RequestLog) { return }
  ('{0} {1} {2} {3} {4}' -f (Get-Date).ToString('o'), $method, $path, $status, $bytes) |
    Out-File -FilePath $RequestLog -Append -Encoding utf8
}

# Bind the certificate to the port (idempotent).
function Connect-Certificate {
  $appId = '{b7a9d8e2-5c1f-4c1e-9a77-7727721ab001}'
  netsh http delete sslcert ipport=0.0.0.0:$Port 2>&1 | Out-Null
  $bind = netsh http add sslcert ipport=0.0.0.0:$Port certhash=$CertThumbprint appid=$appId 2>&1 | Out-String
  if ($bind -notmatch 'successfully') { throw "could not bind the TLS certificate: $bind" }
}

# The file a request path names, or $null when it is absent or escapes the root.
function Resolve-FeedFile([string]$rootFull, [string]$urlPath) {
  $relative = [Uri]::UnescapeDataString($urlPath).TrimStart('/') -replace '/', '\'
  $fullPath = [IO.Path]::GetFullPath((Join-Path $rootFull $relative))
  $inside = $fullPath.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
  if ($inside -and (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return $fullPath }
  return $null
}

# Answers one request. Returns the status code and the number of body bytes sent.
function Send-Response($req, $res, [string]$rootFull) {
  if ($req.HttpMethod -notin @('GET', 'HEAD')) { return @{ Status = 405; Bytes = 0 } }
  $file = Resolve-FeedFile $rootFull $req.Url.AbsolutePath
  if ($null -eq $file) { return @{ Status = 404; Bytes = 0 } }
  $length = (Get-Item -LiteralPath $file).Length
  $res.ContentType = 'application/octet-stream'
  $res.ContentLength64 = $length
  if ($req.HttpMethod -eq 'HEAD') { return @{ Status = 200; Bytes = 0 } }
  $in = [IO.File]::OpenRead($file)
  try { $in.CopyTo($res.OutputStream) } finally { $in.Dispose() }
  return @{ Status = 200; Bytes = $length }
}

function Invoke-Feed {
  Assert-LabFeedAllowed
  $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
  Connect-Certificate
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("https://${HostName}:$Port/")
  $listener.Start()
  Write-Request 'START' "https://${HostName}:$Port/" 0 0
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $answer = @{ Status = 500; Bytes = 0 }
    try { $answer = Send-Response $ctx.Request $ctx.Response $rootFull } catch { $answer = @{ Status = 499; Bytes = 0 } }
    try { $ctx.Response.StatusCode = $answer.Status } catch { }
    try { $ctx.Response.Close() } catch { }
    Write-Request $ctx.Request.HttpMethod $ctx.Request.Url.AbsolutePath $answer.Status $answer.Bytes
  }
}

Invoke-Feed
