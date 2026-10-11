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
 *
 * RT-358 (RT-247 plan §2.4) — a JWT stored by a successful re-auth (or a
 * manager online unlock) carries a one-shot "just re-authenticated" mark with
 * the monotonic time it was set. The next `operator-identity` request consumes
 * it BEFORE it is sent; a 401 on that request means the person's authority is
 * gone at the backend, not that the JWT is stale. The mark is bound to the
 * session id, cleared with the JWT, valid for `REAUTH_MARK_TTL_MS` only, and
 * never carried by IPC.
 */

/** How long a "just re-authenticated" mark stays valid (monotonic ms). */
export const REAUTH_MARK_TTL_MS = 60_000;

export interface JwtSetOptions {
  /** Monotonic time (`performance.now()`) of the re-auth that minted this JWT. */
  reauthenticatedAtMs?: number;
}

export interface JwtHolder {
  set(backendSessionId: string, jwt: string, options?: JwtSetOptions): void;
  get(backendSessionId: string): string | null;
  clear(backendSessionId: string): void;
  /** RT-215 — drop every held credential (a confirmed device revocation). */
  clearAll(): void;
  /** RT-358 — whether the session's JWT carries a fresh mark (does not consume it). */
  hasFreshMark(backendSessionId: string, monoNowMs: number): boolean;
  /** RT-358 — drop the session's mark; true when it was fresh. */
  consumeMark(backendSessionId: string, monoNowMs: number): boolean;
}

export interface CreateJwtHolderOptions {
  /**
   * RT-215 / Codex P1 4181556645 — while this returns true (the device is
   * revoked), every write is dropped, so a sign-in that completes late can
   * never repopulate a credential. A throwing predicate refuses (fail closed).
   */
  refuseWhile?: () => boolean;
}

function refuses(options: CreateJwtHolderOptions): boolean {
  if (options.refuseWhile === undefined) return false;
  try {
    return options.refuseWhile();
  } catch {
    return true;
  }
}

function isFresh(markedAtMs: number | undefined, monoNowMs: number): boolean {
  if (markedAtMs === undefined) return false;
  const age = monoNowMs - markedAtMs;
  return age >= 0 && age < REAUTH_MARK_TTL_MS;
}

export function createJwtHolder(options: CreateJwtHolderOptions = {}): JwtHolder {
  const tokens = new Map<string, string>();
  const marks = new Map<string, number>();
  return {
    set(backendSessionId, jwt, setOptions) {
      if (refuses(options)) return;
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
      // A JWT not minted by a re-auth never inherits an earlier one's mark.
      const markedAt = setOptions?.reauthenticatedAtMs;
      if (markedAt === undefined) marks.delete(backendSessionId);
      else marks.set(backendSessionId, markedAt);
    },
    get(backendSessionId) {
      return tokens.get(backendSessionId) ?? null;
    },
    clear(backendSessionId) {
      tokens.delete(backendSessionId);
      marks.delete(backendSessionId);
    },
    clearAll() {
      tokens.clear();
      marks.clear();
    },
    hasFreshMark(backendSessionId, monoNowMs) {
      return isFresh(marks.get(backendSessionId), monoNowMs);
    },
    consumeMark(backendSessionId, monoNowMs) {
      const fresh = isFresh(marks.get(backendSessionId), monoNowMs);
      marks.delete(backendSessionId);
      return fresh;
    },
  };
}
