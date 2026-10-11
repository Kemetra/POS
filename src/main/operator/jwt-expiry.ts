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

function readExpSeconds(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const exp = (payload as Record<string, unknown>)['exp'];
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

export function jwtExpiry(jwt: string, nowMs: number): JwtExpiry {
  const exp = readExpSeconds(jwt);
  if (exp === null) return 'unknown';
  return exp * 1000 <= nowMs ? 'expired' : 'valid';
}
