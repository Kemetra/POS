'use strict';

/**
 * RT-772 slice 1 — electron-builder `win.signtoolOptions.sign` hook for the LAB
 * installer only (referenced from electron-builder.lab.yml, never from the shipped
 * config).
 *
 * It signs one file with signtool, using a lab test certificate that already sits
 * in the CurrentUser\My store (the key is non-exportable and never touches disk).
 * It does not import any certificate into a trust store and makes no timestamp
 * call unless RT772_LAB_TSA_URL is set.
 *
 *   RT772_LAB_CERT_SHA1  required  thumbprint of the lab leaf certificate
 *   RT772_SIGNTOOL       optional  path to signtool.exe (default: newest Windows SDK x64)
 *   RT772_LAB_TSA_URL    optional  https RFC 3161 url; unset = no timestamp, no outbound call
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const { assertLabSubject, buildSigntoolArgs, normalizeThumbprint } = require('./lab-sign-lib.cjs');

const SDK_BIN = String.raw`C:\Program Files (x86)\Windows Kits\10\bin`;

// An absolute path: `powershell.exe` resolved through PATH could be a planted binary.
const POWERSHELL = path.join(
  process.env.SystemRoot ?? String.raw`C:\Windows`,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function findSigntool() {
  const fromEnv = process.env.RT772_SIGNTOOL;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`RT772_SIGNTOOL does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const versions = existsSync(SDK_BIN)
    ? readdirSync(SDK_BIN)
        .filter((v) => v.startsWith('10.'))
        .sort()
        .reverse()
    : [];
  for (const version of versions) {
    const candidate = path.join(SDK_BIN, version, 'x64', 'signtool.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('signtool.exe not found: install the Windows SDK or set RT772_SIGNTOOL');
}

let verifiedThumbprint;

// Reads the subject through the .NET store API rather than the `Cert:` drive:
// electron-builder runs this hook with a cleared PSModulePath, under which the
// certificate provider (and so `Cert:`) does not load. The thumbprint is validated
// as 40 hex characters before it reaches the command line.
function certificateSubject(thumbprint) {
  const script =
    "$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser'); " +
    "$s.Open('ReadOnly'); " +
    `$c = $s.Certificates.Find('FindByThumbprint','${thumbprint}',$false); $s.Close(); ` +
    'if ($c.Count -ne 1) { exit 3 }; $c[0].Subject';
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(String.raw`lab certificate ${thumbprint} not found in Cert:\CurrentUser\My`);
  }
}

/** @param {{ path: string }} configuration */
module.exports = async function labSign(configuration) {
  const thumbprint = normalizeThumbprint(process.env.RT772_LAB_CERT_SHA1);
  if (verifiedThumbprint !== thumbprint) {
    assertLabSubject(certificateSubject(thumbprint));
    verifiedThumbprint = thumbprint;
  }
  const args = buildSigntoolArgs({
    thumbprint,
    file: configuration.path,
    tsaUrl: process.env.RT772_LAB_TSA_URL,
  });
  execFileSync(findSigntool(), args, { stdio: 'inherit' });
};
