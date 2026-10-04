/**
 * RT-217 — drive a registered client call and judge it against the contract index.
 * Pure apart from the client under test, so the judgement itself is unit-tested
 * (`conformance.test.ts`) on fixture contracts.
 */
import { SENTINEL, type ClientCall, type FetchLike } from './client-registry.js';
import type { ContractOperation, CredentialKind } from './openapi-index.js';

export interface ObservedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

export interface Observation {
  readonly call: ClientCall;
  readonly requests: readonly ObservedRequest[];
}

export type SentCredential = CredentialKind | `unrecognised (${string})`;

/** The part of a violation that identifies it; `KnownViolation` entries share it. */
export interface ViolationIdentity {
  readonly call: string;
  readonly kind: 'credential-mismatch' | 'endpoint-missing';
  readonly sent?: SentCredential;
  /** The contract's accepted credentials, sorted (credential mismatches only). */
  readonly requires?: readonly CredentialKind[];
}

export interface Violation extends ViolationIdentity {
  readonly detail: string;
}

// ─── recording ───────────────────────────────────────────────────────────────

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const fromRequest = input instanceof Request ? input.method : 'GET';
  return (init?.method ?? fromRequest).toLowerCase();
}

/** A `fetch` that records every request and answers `200 {}`. */
export function recordingFetch(): { fetch: FetchLike; requests: ObservedRequest[] } {
  const requests: ObservedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    requests.push({
      method: methodOf(input, init),
      url: urlOf(input),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };
  return { fetch, requests };
}

export async function observe(call: ClientCall): Promise<Observation> {
  const { fetch, requests } = recordingFetch();
  await call.invoke(fetch);
  return { call, requests };
}

// ─── judging ─────────────────────────────────────────────────────────────────

const SENTINEL_KINDS = Object.keys(SENTINEL) as Array<keyof typeof SENTINEL>;

/** Which sentinel credential a request carries as `Authorization: Bearer <token>`. */
export function sentCredential(request: { readonly headers: Headers }): SentCredential {
  const auth = request.headers.get('authorization');
  if (auth === null) return 'none';
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  const kind = SENTINEL_KINDS.find((k) => SENTINEL[k] === token);
  return kind ?? `unrecognised (${auth.split(' ')[0] ?? ''})`;
}

/** Sorted, so the same accepted set always yields the same identity. */
export function canonicalCredentials(kinds: Iterable<CredentialKind>): CredentialKind[] {
  return [...kinds].sort();
}

function contractOperation(
  obs: Observation,
  ops: readonly ContractOperation[],
): ContractOperation | undefined {
  return ops.find((op) => op.method === obs.call.method && op.path === obs.call.pathTemplate);
}

function credentialViolations(obs: Observation, op: ContractOperation): Violation[] {
  const label = `${obs.call.method.toUpperCase()} ${obs.call.pathTemplate}`;
  const requires = canonicalCredentials(op.accepts);
  return [...new Set(obs.requests.map(sentCredential))]
    .filter((sent) => !op.accepts.has(sent as CredentialKind))
    .map((sent) => ({
      call: obs.call.id,
      kind: 'credential-mismatch' as const,
      sent,
      requires,
      detail: `${label} sends ${sent}; ${op.file} (${op.operationId}) requires ${requires.join(' | ')}`,
    }));
}

export function violationsFor(obs: Observation, ops: readonly ContractOperation[]): Violation[] {
  const op = contractOperation(obs, ops);
  if (op !== undefined) return credentialViolations(obs, op);
  const label = `${obs.call.method.toUpperCase()} ${obs.call.pathTemplate}`;
  return [
    {
      call: obs.call.id,
      kind: 'endpoint-missing',
      detail: `${label} is not in the pinned Backend-Core contracts`,
    },
  ];
}

/**
 * The identity of a violation: the call, the kind, what the client sends and what
 * the contract requires. Including `requires` means a re-pin that changes a route's
 * security no longer matches an existing known entry (Codex P1, PR #538).
 */
export function violationKey(v: ViolationIdentity): string {
  const sent = v.sent === undefined ? '' : ` | sends ${v.sent}`;
  const requires =
    v.requires === undefined ? '' : ` | requires ${canonicalCredentials(v.requires).join(', ')}`;
  return `${v.call} | ${v.kind}${sent}${requires}`;
}

export interface KnownDiff {
  /** Observed but not listed: new violations. */
  readonly unexpected: readonly string[];
  /** Listed but not observed: stale entries. */
  readonly stale: readonly string[];
}

/** Compare observed violations with the known list; both must be empty to pass. */
export function diffAgainstKnown(
  found: readonly Violation[],
  known: readonly ViolationIdentity[],
): KnownDiff {
  const foundKeys = new Set(found.map(violationKey));
  const knownKeys = new Set(known.map(violationKey));
  return {
    unexpected: found
      .filter((v) => !knownKeys.has(violationKey(v)))
      .map((v) => `${violationKey(v)} — ${v.detail}`),
    stale: known.map(violationKey).filter((key) => !foundKeys.has(key)),
  };
}
