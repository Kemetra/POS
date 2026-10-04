/**
 * RT-217 — contract violations that exist on POS `main` today and are tracked by
 * a ticket. The suite requires the observed violations to equal this list EXACTLY:
 *   - a violation not listed here fails the suite (a new bug);
 *   - a listed violation that no longer occurs also fails the suite, so the entry
 *     is deleted by the PR that fixes it (the list can never go stale).
 * Nothing here is skipped: every call is still driven and checked on every run.
 */
import type { CredentialKind } from './openapi-index.js';

export interface KnownViolation {
  /** `ClientCall.id` from the registry. */
  readonly call: string;
  readonly kind: 'credential-mismatch' | 'endpoint-missing';
  /** For `credential-mismatch`: what the client sends today. */
  readonly sent?: CredentialKind;
  /** Jira key(s), or `TODO-ticket` when none is filed yet. */
  readonly tickets: readonly string[];
  readonly note: string;
}

export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  {
    call: 'backendClient.listRoster',
    kind: 'credential-mismatch',
    sent: 'none',
    tickets: ['RT-214', 'RT-182'],
    note:
      'GET /operators/roster requires operator-identity (+ RT-150 manager role); the client sends ' +
      'no Authorization. Callers: manager PIN provisioning (RT-214) and the cashier picker ' +
      '(RT-182, moving to the device-auth cashier-admissions roster in RT-113 P2 / POS #535).',
  },
  {
    call: 'backendClient.getActiveSession',
    kind: 'credential-mismatch',
    sent: 'none',
    tickets: ['RT-182'],
    note:
      'GET /operators/active-session requires operator-identity; the cashier PIN path sends no ' +
      'Authorization. RT-113 P2 (POS #535) replaces it with the device-auth cashier admission.',
  },
  {
    call: 'validateVoucher',
    kind: 'credential-mismatch',
    sent: 'none',
    tickets: ['TODO-ticket'],
    note:
      'POST /vouchers/validate declares operator-identity; the client sends no Authorization. ' +
      'Contract V-A is x-runtime-status: contract-only (no Backend-Core route yet) and the voucher ' +
      'tender is off for the pilot (RT-103).',
  },
  {
    call: 'redeemVoucher',
    kind: 'credential-mismatch',
    sent: 'none',
    tickets: ['TODO-ticket'],
    note: 'Same as validateVoucher: POST /vouchers/redeem declares operator-identity.',
  },
  {
    call: 'reverseVoucher',
    kind: 'credential-mismatch',
    sent: 'none',
    tickets: ['TODO-ticket'],
    note: 'Same as validateVoucher: POST /vouchers/reverse declares operator-identity.',
  },
];
