/**
 * RT-306 (RT-215 10901-(a), owner approval 10906) — the device token, sealed
 * together with the identity of the pairing it was issued for.
 *
 * `persist()` writes the token and the `terminal_assignment` row into two
 * stores with no shared transaction. A crash between them during a re-pair
 * would leave the new token beside the old row: a stable mismatch nothing could
 * see from outside. Sealing the binding inside the same secret makes it one
 * atomic write and needs no migration; every reader compares it with the row.
 *
 * The binding is the pairing's identity and scope, plus `paired_at`, the
 * pairing epoch, which strictly increases on every re-pair (RT-113 F4), so two
 * pairings never share a binding.
 *
 * Format: a JSON object `{ v: 1, token, binding }`. Backend-Core issues device
 * tokens as base64url, which never starts with `{`, so any other value is a
 * token sealed before RT-306 (`legacy`). It cannot be checked, and stays usable
 * until the next pairing replaces it, so an upgrade locks no terminal out.
 *
 * Security: the sealed value holds the token. Nothing here logs, and an
 * unreadable value is reported as `malformed` without its content.
 */

export interface PairingBinding {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  /** The pairing epoch (unix seconds); strictly increasing per pairing. */
  paired_at: number;
}

export type OpenedDeviceToken =
  | { kind: 'bound'; token: string; binding: PairingBinding }
  | { kind: 'legacy'; token: string }
  | { kind: 'malformed' };

const SEALED_VERSION = 1;

export function bindingOf(row: PairingBinding): PairingBinding {
  return {
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    terminal_id: row.terminal_id,
    paired_at: row.paired_at,
  };
}

export function sealDeviceToken(token: string, binding: PairingBinding): string {
  return JSON.stringify({ v: SEALED_VERSION, token, binding: bindingOf(binding) });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBinding(value: unknown): value is PairingBinding {
  return (
    isRecord(value) &&
    isNonEmptyString(value['tenant_id']) &&
    isNonEmptyString(value['branch_id']) &&
    isNonEmptyString(value['terminal_id']) &&
    Number.isSafeInteger(value['paired_at'])
  );
}

interface SealedEnvelope {
  v: typeof SEALED_VERSION;
  token: string;
  binding: PairingBinding;
}

function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  return (
    isRecord(value) &&
    value['v'] === SEALED_VERSION &&
    isNonEmptyString(value['token']) &&
    isBinding(value['binding'])
  );
}

/** `undefined` for text that is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Never throws. `sealed` is a non-empty value read from the SecretStore. */
export function openDeviceToken(sealed: string): OpenedDeviceToken {
  if (!sealed.startsWith('{')) return { kind: 'legacy', token: sealed };
  const parsed = parseJson(sealed);
  if (!isSealedEnvelope(parsed)) return { kind: 'malformed' };
  return { kind: 'bound', token: parsed.token, binding: bindingOf(parsed.binding) };
}

export function sameBinding(a: PairingBinding, b: PairingBinding): boolean {
  return (
    a.tenant_id === b.tenant_id &&
    a.branch_id === b.branch_id &&
    a.terminal_id === b.terminal_id &&
    a.paired_at === b.paired_at
  );
}

/**
 * The token to send for the pairing `row`, or null: absent or empty, malformed,
 * or bound to another pairing. A legacy (unbound) token is returned as is.
 */
export function tokenBoundTo(sealed: string | null, row: PairingBinding | null): string | null {
  if (row === null || !isNonEmptyString(sealed)) return null;
  const opened = openDeviceToken(sealed);
  if (opened.kind === 'malformed') return null;
  if (opened.kind === 'bound' && !sameBinding(opened.binding, row)) return null;
  return opened.token;
}
