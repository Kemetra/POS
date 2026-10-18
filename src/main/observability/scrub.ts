/**
 * RT-634 (OBS-5) — the OBS-1 privacy baseline for POS Sentry events
 * (Confluence "Observability contract", RT-629 §3). Pure and SDK-free.
 *
 * Ported from the Backend-Core reference (`packages/shared/src/observability/
 * sentry.ts`, RT-609) so every surface masks the same way:
 *
 *   - §3.1 allowlist: the outgoing event is REBUILT from a short list of safe
 *     fields. `request`, `user`, `extra`, `contexts`, breadcrumbs,
 *     `transaction`, frame `vars` and source context lines are dropped
 *     wholesale, whatever their keys are.
 *   - §3.2 masking inside exception messages: JWTs, URL userinfo/query/
 *     fragment, emails, Postgres row detail and (RT-693, contract amendment
 *     RT-682) `Bearer`/`Authorization` credentials and phone numbers. Input
 *     is capped at 2,000 chars before scanning and the output at 300; index
 *     scans only, no backtracking regex on library input. §3.5's golden
 *     vectors pin the exact output.
 *
 * POS deviations from the reference, both stricter:
 *   - `server_name` is dropped: on a till it is the Windows machine name,
 *     which often carries a person's name.
 *   - Frame `filename` loses its install/checkout prefix (`C:\Users\<name>\…`):
 *     with the SDK's path-normalising integration off, the raw path would
 *     otherwise leave the device.
 */

import { maskPhones } from './phone-mask.js';

/** Max length of an exception message that leaves the process. */
const MAX_MESSAGE_LENGTH = 300;
/** Bounds the work done on untrusted input before any scanning runs. */
const MAX_SCAN_LENGTH = 2000;
/** Bounds the other free-text strings kept (exception type, frame function/module). */
const MAX_LABEL_LENGTH = 200;

export interface SentryFrameLike {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  module?: string;
  in_app?: boolean;
  [key: string]: unknown;
}

export interface SentryExceptionValueLike {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean; [key: string]: unknown };
  stacktrace?: { frames?: SentryFrameLike[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Structural subset of a Sentry event; only what the scrubber reads or emits. */
export interface SentryEventLike {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  exception?: { values?: SentryExceptionValueLike[] };
  [key: string]: unknown;
}

/** The release configuration stamped on every event (contract §1). */
export interface ObservabilityStamp {
  readonly environment: string;
  readonly release: string;
}

/** Contract §1 `service` value for the cashier terminal. */
export const POS_SERVICE_TAG = 'pos';

const SAFE_TOP_LEVEL = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'environment',
  'release',
] as const;
const FRAME_LOCATION_KEYS = ['lineno', 'colno', 'in_app'] as const;
const MECHANISM_KEYS = ['type', 'handled'] as const;

// Postgres echoes row values after these markers ("Key (email)=(a@b.c) already
// exists.", "Failing row contains (1, a@b.c, ...)"). Values may contain
// parentheses, so everything from the marker on is masked (indexOf, no regex).
const POSTGRES_ROW_MARKERS = [
  { marker: 'Key (', mask: 'Key (...)=(...)' },
  { marker: 'Failing row contains (', mask: 'Failing row contains (...)' },
] as const;
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([`"`, "'", ')', ']', ',', ';', '.', '>']);
const REDACTED = '[redacted]';
// Characters ignored around `Bearer` and an auth-scheme word (§3.2; RT-694 adds `)]}`).
const WORD_WRAPPERS = `"'{[(,:)]}`;
const QUOTES = `"'`;
const IDENTIFIER_CHAR = /^[a-z0-9_-]$/i;
const AUTHORIZATION_KEY = 'authorization';
// After `Authorization:`, a scheme word means the credential is the word after it.
const AUTH_SCHEMES: ReadonlySet<string> = new Set([
  'bearer',
  'basic',
  'digest',
  'token',
  'apikey',
  'negotiate',
  'ntlm',
]);
// Path markers after which a frame filename is app-relative. Checked in order.
const APP_PATH_MARKERS = ['/app.asar/', '/dist/'] as const;

/** Copy only the listed keys whose value is defined. */
function pickDefined<K extends string>(
  source: Partial<Record<K, unknown>>,
  keys: readonly K[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** A string field capped to `MAX_LABEL_LENGTH`, or `undefined` when not a string. */
function label(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_LABEL_LENGTH) : undefined;
}

function maskPostgresRowValues(value: string): string {
  let out = value;
  for (const { marker, mask } of POSTGRES_ROW_MARKERS) {
    const at = out.indexOf(marker);
    if (at !== -1) out = `${out.slice(0, at)}${mask}`;
  }
  return out;
}

/**
 * How to treat the word after this one (§3.2): scrub it as usual, mask it as a
 * credential, or (after a bare `Authorization` key, RT-694) take a leading
 * `:`/`=` in it as that key's separator.
 */
type NextWord = 'scrub' | 'mask' | 'authorizationSeparator';

/** A scrubbed word, and how to treat the word after it. */
interface ScrubbedWord {
  text: string;
  next: NextWord;
}

/**
 * One whitespace-delimited token of an exception message. Secrets are masked
 * wherever they sit in it (`token=eyJ…`, `"https://u:p@host/x?api_key=…"`):
 * `Bearer` first, then URLs (userinfo and query), `Authorization` values,
 * JWTs, emails and phones. Index scans only, so the work stays linear on
 * untrusted input.
 */
class MessageToken {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scrubbed(): ScrubbedWord {
    if (this.unwrapped() === 'bearer') return { text: REDACTED, next: 'mask' };
    const url = this.withoutUrl();
    const authorization = url.maskedAuthorization();
    // The part before `authorization=` still gets the JWT/email/phone masks.
    const masked = (authorization ? new MessageToken(authorization.text) : url).withoutJwt();
    const text = masked.isEmailLike() ? '[email]' : maskPhones(masked.text);
    return { text, next: authorization?.next ?? this.nextAfterKey() };
  }

  /**
   * The word after a bare `Authorization` key (`Authorization : Basic x`,
   * RT-694): a leading `:` or `=` is that key's separator, so the rest of the
   * word is its value. `null` when the word does not start with one.
   */
  separatedValue(): ScrubbedWord | null {
    return this.isSeparator(0) ? this.valueAfter(0) : null;
  }

  /** A word ending in an `Authorization` key, quotes ignored, waits for a separator word. */
  private nextAfterKey(): NextWord {
    const key = this.keyBefore(this.text.length);
    return key.endsWith(AUTHORIZATION_KEY) ? 'authorizationSeparator' : 'scrub';
  }

  /** An auth-scheme word (`Bearer`, `'Basic`): the credential is the next word. */
  isAuthScheme(): boolean {
    return AUTH_SCHEMES.has(this.unwrapped());
  }

  /**
   * `Authorization:<value>` / `"authorization":` / `headers.authorization=`:
   * the value after the first such separator is masked, or the next word
   * when the value is empty. A scheme value (`Bearer`) means the credential
   * is the next word.
   */
  private maskedAuthorization(): ScrubbedWord | null {
    for (let sep = 0; sep < this.text.length; sep++) {
      if (this.isAuthorizationSeparator(sep)) return this.valueAfter(sep);
    }
    return null;
  }

  /** The value after the separator at `sep` masked, or the next word when it is empty. */
  private valueAfter(sep: number): ScrubbedWord {
    const value = new MessageToken(this.text.slice(sep + 1));
    if (value.text === '') return { text: this.text, next: 'mask' };
    return {
      text: `${this.text.slice(0, sep + 1)}${REDACTED}`,
      next: value.isAuthScheme() ? 'mask' : 'scrub',
    };
  }

  /** Lower-cased, without the wrapper characters around it (`'Bearer` -> `bearer`). */
  private unwrapped(): string {
    let start = 0;
    let end = this.text.length;
    while (start < end && WORD_WRAPPERS.includes(this.text.charAt(start))) start++;
    while (end > start && WORD_WRAPPERS.includes(this.text.charAt(end - 1))) end--;
    return this.text.slice(start, end).toLowerCase();
  }

  /** A `:` or `=` whose key ends in `authorization` (`Proxy-Authorization:`, `"authorization":`). */
  private isAuthorizationSeparator(sep: number): boolean {
    return this.isSeparator(sep) && this.keyBefore(sep).endsWith(AUTHORIZATION_KEY);
  }

  private isSeparator(at: number): boolean {
    const char = this.text.charAt(at);
    return char === ':' || char === '=';
  }

  /**
   * Lower-cased identifier ending at `sep`, skipping quotes. The scan stops at
   * the previous separator, so all the scans in one word stay linear.
   */
  private keyBefore(sep: number): string {
    let end = sep;
    while (end > 0 && QUOTES.includes(this.text.charAt(end - 1))) end--;
    let start = end;
    while (start > 0 && IDENTIFIER_CHAR.test(this.text.charAt(start - 1))) start--;
    return this.text.slice(start, end).toLowerCase();
  }

  /** Keep scheme + host + path; drop userinfo, query, fragment. Unparsable -> `[url]`. */
  private withoutUrl(): MessageToken {
    const sep = this.text.indexOf('://');
    const start = sep > 0 ? this.schemeStart(sep) : sep;
    if (start < 0 || start === sep) return this;
    const raw = this.text.slice(start);
    const end = new MessageToken(raw).bodyLength();
    let safe = '[url]';
    try {
      const url = new URL(raw.slice(0, end));
      safe = `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      // Unparsable: keep the `[url]` placeholder.
    }
    return new MessageToken(`${this.text.slice(0, start)}${safe}${raw.slice(end)}`);
  }

  /** Mask a JWT (operator envelope, Clerk token) and everything after it. */
  private withoutJwt(): MessageToken {
    const at = this.text.indexOf('eyJ');
    if (at === -1 || this.text.slice(at).split('.').length < 3) return this;
    return new MessageToken(`${this.text.slice(0, at)}[jwt]`);
  }

  private isEmailLike(): boolean {
    const at = this.text.indexOf('@');
    return at > 0 && this.text.includes('.', at);
  }

  /** Index where the URL scheme ending at `sep` (the `://`) starts. */
  private schemeStart(sep: number): number {
    let start = sep;
    while (start > 0 && SCHEME_CHAR.test(this.text.charAt(start - 1))) start--;
    return start;
  }

  /** Length without trailing quotes/brackets/punctuation. */
  private bodyLength(): number {
    let end = this.text.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(this.text.charAt(end - 1))) end--;
    return end;
  }
}

const NEXT_WORD_RANK: Readonly<Record<NextWord, number>> = {
  scrub: 0,
  authorizationSeparator: 1,
  mask: 2,
};

/** The stricter of two next-word states (mask, then separator, then scrub). */
function stricter(a: NextWord, b: NextWord): NextWord {
  return NEXT_WORD_RANK[a] >= NEXT_WORD_RANK[b] ? a : b;
}

/**
 * One word, scrubbed as the word before it asks (`next`). A word masked or read
 * as a separator value still passes on its own signal (`[Bearer] Authorization: x`,
 * `Authorization :a,authorization= x`), so nothing is masked less than before.
 */
function scrubWord(token: MessageToken, next: NextWord): ScrubbedWord {
  if (next === 'mask') {
    return { text: REDACTED, next: token.isAuthScheme() ? 'mask' : token.scrubbed().next };
  }
  const separated = next === 'authorizationSeparator' ? token.separatedValue() : null;
  if (separated === null) return token.scrubbed();
  return { text: separated.text, next: stricter(separated.next, token.scrubbed().next) };
}

/**
 * Scrub each word, carrying one "next word" state across words (`Bearer <x>`,
 * `Authorization: Basic <x>`, `Authorization : <x>`). Whitespace passes through.
 */
function scrubWords(parts: readonly string[]): string {
  let next: NextWord = 'scrub';
  const out: string[] = [];
  for (const part of parts) {
    if (part.trim() === '') {
      out.push(part);
    } else {
      const word = scrubWord(new MessageToken(part), next);
      next = word.next;
      out.push(word.text);
    }
  }
  return out.join('');
}

/** Contract §3.2: cap, mask secrets anywhere in the text, truncate. */
export function sanitizeMessage(value: string): string {
  const words = maskPostgresRowValues(value.slice(0, MAX_SCAN_LENGTH)).split(/(\s+)/);
  const cleaned = scrubWords(words);
  return cleaned.length > MAX_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : cleaned;
}

/**
 * App-relative frame filename. A path under the packaged asar or the `dist/`
 * build output becomes `app:///dist/…`; any other absolute path keeps only its
 * basename; scheme-less module ids (`node:internal/…`) pass through.
 */
export function relativeFrameFilename(filename: string): string {
  const path = filename.replaceAll('\\', '/');
  for (const marker of APP_PATH_MARKERS) {
    const at = path.lastIndexOf(marker);
    if (at === -1) continue;
    const rest = path.slice(at + marker.length);
    return marker === '/dist/' ? `app:///dist/${rest}` : `app:///${rest}`;
  }
  if (path.startsWith('app:///')) return path;
  const isAbsolute = path.startsWith('/') || path.startsWith('file:') || path.charAt(1) === ':';
  return isAbsolute ? path.slice(path.lastIndexOf('/') + 1) : path.slice(0, MAX_LABEL_LENGTH);
}

function scrubFrame(frame: SentryFrameLike): Record<string, unknown> {
  const out = pickDefined(frame, FRAME_LOCATION_KEYS);
  if (typeof frame.filename === 'string') out['filename'] = relativeFrameFilename(frame.filename);
  const fn = label(frame.function);
  if (fn !== undefined) out['function'] = fn;
  const mod = label(frame.module);
  if (mod !== undefined) out['module'] = mod;
  return out;
}

function scrubException(entry: SentryExceptionValueLike): SentryExceptionValueLike {
  const out: SentryExceptionValueLike = {};
  const type = label(entry.type);
  if (type !== undefined) out.type = type;
  if (typeof entry.value === 'string') out.value = sanitizeMessage(entry.value);
  if (entry.mechanism !== undefined) out.mechanism = pickDefined(entry.mechanism, MECHANISM_KEYS);
  const frames = entry.stacktrace?.frames;
  if (Array.isArray(frames)) out.stacktrace = { frames: frames.map(scrubFrame) };
  return out;
}

/**
 * `beforeSend` core: rebuild the event from allowlisted fields only, or return
 * `null` (drop) when it carries no exception. With a `stamp`, environment and
 * release are overwritten and the tags are exactly `service`/`env`/`version`;
 * without one, no tag leaves the process. Pure; does not mutate its input.
 */
export function scrubSentryEvent(
  event: SentryEventLike,
  stamp?: ObservabilityStamp,
): SentryEventLike | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  const out: SentryEventLike = pickDefined(event, SAFE_TOP_LEVEL);
  if (stamp !== undefined) {
    out.environment = stamp.environment;
    out.release = stamp.release;
    out.tags = { service: POS_SERVICE_TAG, env: stamp.environment, version: stamp.release };
  }
  out.exception = { values: values.map(scrubException) };
  return out;
}
