/**
 * RT-358 (RT-247 plan §2.1) — classify a held operator-identity JWT by its
 * `exp` claim, so main does not send a request that can only be refused.
 *
 * Classification, NOT trust: the signature is never checked here and the
 * backend stays the authority — it verifies every JWT it receives. A token
 * without a readable numeric `exp` is `unknown`, never `expired`; the request
 * is then sent and a 401 decides. Never throws. The token is never logged.
 */

export type JwtExpiry = 'expired' | 'valid' | 'unknown';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodePayload(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function readExpSeconds(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = decodePayload(parts[1] ?? '');
  if (!isRecord(payload)) return null;
  const exp = payload['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

export function jwtExpiry(jwt: string, nowMs: number): JwtExpiry {
  const exp = readExpSeconds(jwt);
  if (exp === null) return 'unknown';
  return exp * 1000 <= nowMs ? 'expired' : 'valid';
}
