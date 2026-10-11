/**
 * RT-358 — an unsigned test JWT carrying only an `exp` claim (seconds).
 * Main reads `exp` for classification only, so no signature is needed.
 */
export function jwtWithExp(expSeconds: number): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ sub: 'user_1', exp: Math.floor(expSeconds) })}.sig`;
}
