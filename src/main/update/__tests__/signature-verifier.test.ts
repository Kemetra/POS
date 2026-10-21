import { describe, expect, it, vi } from 'vitest';

import { VERIFIER_UNAVAILABLE_MARKER, createFailClosedVerifier } from '../signature-verifier.js';
import type { SignatureProbe } from '../signature-verifier.js';

/**
 * RT-772 slice 2 — the replacement for electron-updater's Windows verifier.
 *
 * electron-updater 6.8.10 resolves `null` ("valid") whenever its PowerShell check cannot run
 * (old Windows, `ConvertTo-Json` unusable, a missing `Path`). ADR-0006 requires the opposite:
 * an inability to verify is never an install. So this verifier returns `null` ONLY on positive
 * proof, and every other outcome is a non-null string; a tool failure carries a fixed marker so
 * the service can tell "could not verify" from "verified and refused".
 */

const FILE = 'C:\\Users\\pos\\AppData\\Local\\pos-pulse-updater\\pending\\Setup.exe';
const PIN = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION';

const GOOD = {
  Status: 0,
  StatusMessage: 'Signature verified.',
  Path: FILE,
  SignerCertificate: { Subject: `CN=${PIN}` },
};

/** `value` without `key`. */
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const probeOf =
  (output: unknown): SignatureProbe =>
  () =>
    Promise.resolve({ kind: 'ok', stdout: JSON.stringify(output) });

const verify = (
  output: unknown,
  pins: string[] = [PIN],
  file: string = FILE,
): Promise<string | null> => createFailClosedVerifier(probeOf(output))(pins, file);

describe('the fail-closed verifier accepts only positive proof', () => {
  it('returns null for a valid signature by the pinned publisher at the expected path', async () => {
    await expect(verify(GOOD)).resolves.toBeNull();
  });

  it('compares the path case-insensitively and across separator styles', async () => {
    await expect(
      verify({ ...GOOD, Path: FILE.toUpperCase().replaceAll('\\', '/') }),
    ).resolves.toBeNull();
  });

  it('accepts any pinned publisher in the list', async () => {
    await expect(verify(GOOD, ['Other Corp', PIN])).resolves.toBeNull();
  });
});

describe('publisher matching', () => {
  const subjectOf = (subject: string): unknown => ({
    ...GOOD,
    SignerCertificate: { Subject: subject },
  });

  it('a CN-only pin must equal the CN exactly, never a prefix or substring', async () => {
    expect(await verify(subjectOf('CN=Acme Evil Corp'), ['Acme'])).not.toBeNull();
    expect(await verify(subjectOf('CN=Acme'), ['Acme Evil Corp'])).not.toBeNull();
    expect(await verify(subjectOf('CN=Acme'), ['Acme'])).toBeNull();
  });

  it('a full-DN pin needs every named key to match', async () => {
    const subject = 'CN=Acme, O=Acme Ltd, C=EG';
    expect(await verify(subjectOf(subject), ['CN=Acme, O=Acme Ltd'])).toBeNull();
    expect(await verify(subjectOf(subject), ['CN=Acme, O=Someone Else'])).not.toBeNull();
    expect(await verify(subjectOf(subject), ['CN=Acme, L=Cairo'])).not.toBeNull();
  });

  it('handles a quoted value that contains a comma', async () => {
    const subject = 'CN="Acme, Inc", C=EG';
    expect(await verify(subjectOf(subject), ['CN="Acme, Inc"'])).toBeNull();
    expect(await verify(subjectOf(subject), ['CN=Acme'])).not.toBeNull();
  });

  it('fails when no pin is given, and never runs the tool for it', async () => {
    const probe = vi.fn<SignatureProbe>();
    const result = await createFailClosedVerifier(probe)([], FILE);
    expect(result).not.toBeNull();
    expect(await createFailClosedVerifier(probe)(['  ', ''], FILE)).not.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('an inability to verify is reported, with the marker, and is never a pass', () => {
  it('reports a probe that could not run', async () => {
    const probe: SignatureProbe = () => Promise.resolve({ kind: 'failed', reason: 'spawn EPERM' });
    const result = await createFailClosedVerifier(probe)([PIN], FILE);
    expect(result).toContain(VERIFIER_UNAVAILABLE_MARKER);
    expect(result).toContain('spawn EPERM');
  });

  it('reports a probe that throws or rejects', async () => {
    const throwing: SignatureProbe = () => {
      throw new Error('boom');
    };
    const rejecting: SignatureProbe = () => Promise.reject(new Error('nope'));
    expect(await createFailClosedVerifier(throwing)([PIN], FILE)).toContain(
      VERIFIER_UNAVAILABLE_MARKER,
    );
    expect(await createFailClosedVerifier(rejecting)([PIN], FILE)).toContain(
      VERIFIER_UNAVAILABLE_MARKER,
    );
  });

  it('reports output that is not JSON', async () => {
    const probe: SignatureProbe = () => Promise.resolve({ kind: 'ok', stdout: 'Get-Auth: oops' });
    expect(await createFailClosedVerifier(probe)([PIN], FILE)).toContain(
      VERIFIER_UNAVAILABLE_MARKER,
    );
  });

  it.each([null, [], 'text', 42, true])('reports JSON that is not an object: %j', async (value) => {
    expect(await verify(value)).toContain(VERIFIER_UNAVAILABLE_MARKER);
  });

  it('reports a missing or non-numeric Status', async () => {
    expect(await verify(without(GOOD, 'Status'))).toContain(VERIFIER_UNAVAILABLE_MARKER);
    expect(await verify({ ...GOOD, Status: '0' })).toContain(VERIFIER_UNAVAILABLE_MARKER);
  });

  it('reports a missing Path (the library tolerates this; we do not)', async () => {
    expect(await verify(without(GOOD, 'Path'))).toContain(VERIFIER_UNAVAILABLE_MARKER);
  });
});

describe('a signature that was checked and refused is a plain refusal', () => {
  it.each([1, 2, 3, 5])('refuses signature status %i', async (status) => {
    const result = await verify({ ...GOOD, Status: status, StatusMessage: 'bad' });
    expect(result).not.toBeNull();
    expect(result).not.toContain(VERIFIER_UNAVAILABLE_MARKER);
  });

  it('refuses a path that differs from the file that was downloaded', async () => {
    const result = await verify({ ...GOOD, Path: 'C:\\somewhere\\else.exe' });
    expect(result).not.toBeNull();
    expect(result).not.toContain(VERIFIER_UNAVAILABLE_MARKER);
  });

  it('refuses a missing signer certificate or subject', async () => {
    expect(await verify(without(GOOD, 'SignerCertificate'))).not.toBeNull();
    expect(await verify({ ...GOOD, SignerCertificate: {} })).not.toBeNull();
    expect(await verify({ ...GOOD, SignerCertificate: { Subject: 7 } })).not.toBeNull();
  });

  it('refuses a wrong publisher without the unavailable marker', async () => {
    const result = await verify({ ...GOOD, SignerCertificate: { Subject: 'CN=Other Publisher' } }, [
      PIN,
    ]);
    expect(result).not.toBeNull();
    expect(result).not.toContain(VERIFIER_UNAVAILABLE_MARKER);
  });
});
