/**
 * 004-operator-session — canonical `end_cause` union for operator sessions.
 *
 * Mirrors data-model.md §"Entity 2 — OperatorSession" end_cause enum.
 * Used by SessionManager (in-memory) and the future `operator_sessions`
 * SQL table (§A3 / T065). Keep these values in sync with the migration.
 */
export type SessionEndCause =
  | 'signed_out'
  | 'inactivity_timeout'
  | 'superseded_by_takeover'
  | 'terminal_session_terminated'
  | 'account_disabled_mid_session'
  // RT-444 (RT-116 S3, §2.2) — a different operator's admitted sign-in ended
  // the locked session explicitly, before the new session was created.
  | 'superseded_at_lock';
