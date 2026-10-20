import path from 'node:path';

// electron-updater's own parser for this (builder-util-runtime is CommonJS: default import), so a
// pin is read exactly as the library's verifier reads it; only the failure handling differs.
import builderUtilRuntime from 'builder-util-runtime';

/**
 * RT-772 slice 2 — a fail-closed replacement for electron-updater's Windows signature verifier.
 *
 * electron-updater 6.8.10 resolves `null` ("valid") whenever its own PowerShell check cannot run
 * (old Windows, `ConvertTo-Json` unusable, a missing `Path` in the output). ADR-0006 requires the
 * opposite: an inability to verify is never an install. This verifier returns `null` ONLY on
 * positive proof, and every other outcome is a non-null string:
 *
 *   - a tool failure or unreadable output carries `VERIFIER_UNAVAILABLE_MARKER`, so the service can
 *     tell "could not verify" (`verify_unavailable`) from "verified and refused" (`verify_failed`);
 *   - a signature that was checked and refused is a plain description.
 *
 * It is installed through `autoUpdater.verifyUpdateCodeSignature`. electron-updater only calls it
 * when the build bakes a publisher pin into `app-update.yml`; the service refuses to start without
 * one (the library skips verification entirely when there is none).
 */

/** The shape electron-updater expects: `null` accepts the file, any string refuses it. */
export type VerifyUpdateCodeSignature = (
  publisherNames: string[],
  filePath: string,
) => Promise<string | null>;

export type ProbeResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** Runs `Get-AuthenticodeSignature` on the file and returns its JSON output, or why it could not. */
export type SignatureProbe = (filePath: string) => Promise<ProbeResult>;

export const VERIFIER_UNAVAILABLE_MARKER = 'signature verification unavailable';

const { parseDn } = builderUtilRuntime;

const MAX_DETAIL_LENGTH = 120;

/** `null` = this check passed; otherwise the reason, and whether it was an inability to verify. */
type Refusal = { readonly unavailable: boolean; readonly message: string } | null;

/** What a check looks at: the parsed PowerShell output, the file, and the pinned publishers. */
interface Evidence {
  readonly data: Record<string, unknown>;
  readonly filePath: string;
  readonly pins: string[];
}

/** A full-DN pin needs every named key to match; a bare pin must equal the CN exactly. */
function matchesPin(subject: Map<string, string>, pin: string): boolean {
  const wanted = parseDn(pin);
  if (wanted.size > 0) return [...wanted].every(([key, value]) => subject.get(key) === value);
  return pin.trim() !== '' && subject.get('CN') === pin.trim();
}

function asObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function checkStatus({ data }: Evidence): Refusal {
  const status = data.Status;
  if (typeof status !== 'number') {
    return { unavailable: true, message: 'the check returned no signature status' };
  }
  if (status === 0) return null;
  const detail = typeof data.StatusMessage === 'string' ? data.StatusMessage : '';
  return {
    unavailable: false,
    message: `signature is not valid (status ${String(status)}: ${detail.slice(0, MAX_DETAIL_LENGTH)})`,
  };
}

function checkPath({ data, filePath }: Evidence): Refusal {
  const reported = data.Path;
  if (typeof reported !== 'string') {
    return { unavailable: true, message: 'the check did not report the file path' };
  }
  const normalise = (value: string): string => path.win32.normalize(value).toLowerCase();
  if (normalise(reported) === normalise(filePath)) return null;
  return { unavailable: false, message: 'the verified file is not the downloaded file' };
}

function checkPublisher({ data, pins }: Evidence): Refusal {
  const signer = data.SignerCertificate;
  const subject =
    typeof signer === 'object' && signer !== null
      ? (signer as Record<string, unknown>).Subject
      : null;
  if (typeof subject !== 'string' || subject === '') {
    return { unavailable: false, message: 'the file has no signer certificate' };
  }
  const parsed = parseDn(subject);
  if (pins.some((pin) => matchesPin(parsed, pin))) return null;
  return {
    unavailable: false,
    message: `signed by an unexpected publisher (${subject.slice(0, MAX_DETAIL_LENGTH)})`,
  };
}

/** The library's contract: `null` accepts, any string refuses. Our marker tags "could not verify". */
function toResult(refusal: Refusal): string | null {
  if (refusal === null) return null;
  return refusal.unavailable
    ? `${VERIFIER_UNAVAILABLE_MARKER}: ${refusal.message}`
    : refusal.message;
}

async function verifyAgainst(
  probe: SignatureProbe,
  pins: string[],
  filePath: string,
): Promise<Refusal> {
  const probed = await probe(filePath);
  if (probed.kind === 'failed') return { unavailable: true, message: probed.reason };
  const data = asObject(probed.stdout);
  if (data === null) return { unavailable: true, message: 'the check returned no usable result' };
  const evidence: Evidence = { data, filePath, pins };
  // The first check that refuses wins; `null` from every check is the only way to accept.
  return checkStatus(evidence) ?? checkPath(evidence) ?? checkPublisher(evidence);
}

export function createFailClosedVerifier(probe: SignatureProbe): VerifyUpdateCodeSignature {
  return async (publisherNames, filePath) => {
    const pins = publisherNames.filter((name) => name.trim() !== '');
    if (pins.length === 0) return 'no publisher is pinned';
    try {
      return toResult(await verifyAgainst(probe, pins, filePath));
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unexpected error';
      return toResult({ unavailable: true, message: why });
    }
  };
}
