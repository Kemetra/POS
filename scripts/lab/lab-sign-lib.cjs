'use strict';

/**
 * RT-772 slice 1 — pure helpers for the lab-only signing hook.
 *
 * The lab installer is signed with a self-signed TEST certificate whose subject
 * carries LAB_SUBJECT_MARKER. A production publisher pin can therefore never match
 * it, and the hook refuses to sign with any certificate that lacks the marker.
 * Nothing here talks to the network: a timestamp is added only when a TSA url is
 * passed explicitly (an owner decision, RT-772 preflight).
 */

const LAB_SUBJECT_MARKER = 'LAB TEST - NOT FOR PRODUCTION';

const THUMBPRINT_PATTERN = /^[0-9A-F]{40}$/;

function assertLabSubject(subject) {
  if (typeof subject !== 'string' || !subject.includes(LAB_SUBJECT_MARKER)) {
    throw new Error(
      `refusing to sign: certificate subject is not a lab test certificate (must contain "${LAB_SUBJECT_MARKER}")`,
    );
  }
}

function normalizeThumbprint(value) {
  const normalized = (value ?? '').replaceAll(/\s+/g, '').toUpperCase();
  if (!THUMBPRINT_PATTERN.test(normalized)) {
    throw new Error('lab certificate thumbprint must be 40 hex characters (RT772_LAB_CERT_SHA1)');
  }
  return normalized;
}

function buildSigntoolArgs({ thumbprint, file, tsaUrl }) {
  const args = ['sign', '/fd', 'sha256', '/s', 'My', '/sha1', normalizeThumbprint(thumbprint)];
  if (tsaUrl !== undefined && tsaUrl !== '') {
    if (!tsaUrl.startsWith('https://')) {
      throw new Error('timestamp url must be https (RT772_LAB_TSA_URL)');
    }
    args.push('/tr', tsaUrl, '/td', 'sha256');
  }
  args.push(file);
  return args;
}

module.exports = { LAB_SUBJECT_MARKER, assertLabSubject, normalizeThumbprint, buildSigntoolArgs };
