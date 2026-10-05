/**
 * 004-operator-session — main-process JWT holder.
 *
 * Holds the Clerk session JWT keyed by the backend session id for
 * sign-out and any future authenticated bridge call. Lives entirely
 * in main process memory (Wave 1 path b: the JWT NEVER crosses the
 * preload bridge to the renderer).
 *
 * Crash = JWT lost; the operator signs in again. Durable persistence
 * is deferred — the spec's S3 / S4 work covers durable session state.
 *
 * Redaction: the JWT is held in a single closure-bound Map; the
 * `pino` redaction list (logger.ts) covers `jwt` / `clerk_jwt` /
 * `authorization` / `session_token` belt-and-braces in case any code
 * path accidentally spreads a holder reference into a log payload.
 */

export interface JwtHolder {
  set(backendSessionId: string, jwt: string): void;
  get(backendSessionId: string): string | null;
  clear(backendSessionId: string): void;
  /** RT-215 — drop every held credential (a confirmed device revocation). */
  clearAll(): void;
}

export function createJwtHolder(): JwtHolder {
  const tokens = new Map<string, string>();
  return {
    set(backendSessionId, jwt) {
      // Envelope-retention (sync-gap fix). DP-2's takeover-confirm idempotent
      // replay returns `envelope: null` for the SAME backend_session_id — it
      // means "use the one you already hold from the first confirm". Call sites
      // normalize null → '' before calling set(). An empty value must therefore
      // NOT clobber a previously-held non-empty one, or the sale-sync drain
      // loses its operator credential and silently never POSTs. A deliberate
      // removal uses clear(); an empty set is only ever the replay overwrite.
      if (jwt === '' && (tokens.get(backendSessionId) ?? '') !== '') {
        return;
      }
      tokens.set(backendSessionId, jwt);
    },
    get(backendSessionId) {
      return tokens.get(backendSessionId) ?? null;
    },
    clear(backendSessionId) {
      tokens.delete(backendSessionId);
    },
    clearAll() {
      tokens.clear();
    },
  };
}
