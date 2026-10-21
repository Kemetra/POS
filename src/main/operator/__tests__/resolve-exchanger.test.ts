import { describe, expect, it, vi } from 'vitest';

import type { ClerkExchangeResult } from '../clerk-client.js';
import { resolveOperatorExchanger } from '../resolve-exchanger.js';

/**
 * RT-792 — choosing the manager/admin credential exchanger.
 *
 * `OPERATOR_IDENTITY_PROVIDER` selects Clerk (default) or Descope. Any missing
 * or malformed setting logs one structured warning and yields an exchanger that
 * refuses generically WITHOUT a network call, exactly like the Clerk key
 * handling has always done.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const CLERK_HOST = 'clerk.example.com';
const CLERK_PK = `pk_test_${Buffer.from(`${CLERK_HOST}$`).toString('base64')}`;

function setup(env: Record<string, string | undefined>) {
  const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
  const warn = vi.fn();
  const exchanger = resolveOperatorExchanger({ env, fetch: fetchImpl, logger: { warn } });
  return { exchanger, fetchImpl, warn };
}

async function exchange(env: Record<string, string | undefined>) {
  const ctx = setup(env);
  const result = await ctx.exchanger.exchange({ identifier: 'i', password: 'p' });
  return { ...ctx, result };
}

function calledUrl(fetchImpl: ReturnType<typeof setup>['fetchImpl']): string {
  const call = fetchImpl.mock.calls[0] as unknown as [string] | undefined;
  return call?.[0] ?? '';
}

function warnedEvent(warn: ReturnType<typeof setup>['warn']): unknown {
  const call = warn.mock.calls[0] as unknown as [{ event: string }] | undefined;
  return call?.[0].event;
}

describe('resolveOperatorExchanger — default Clerk', () => {
  it.each([undefined, '', 'clerk', ' Clerk '])(
    'uses Clerk when the provider is %j',
    async (provider) => {
      const { fetchImpl, warn } = await exchange({
        OPERATOR_IDENTITY_PROVIDER: provider,
        CLERK_PUBLISHABLE_KEY: CLERK_PK,
        DESCOPE_PROJECT_ID: PROJECT_ID,
      });
      expect(calledUrl(fetchImpl)).toBe(`https://${CLERK_HOST}/v1/client/sign_ins`);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('refuses generically when the Clerk key is unset (unchanged behaviour)', async () => {
    const { result, fetchImpl, warn } = await exchange({});
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.clerk.missing_publishable_key');
  });

  it('refuses generically when the Clerk key is malformed (unchanged behaviour)', async () => {
    const { result, fetchImpl, warn } = await exchange({ CLERK_PUBLISHABLE_KEY: 'sk_live_x' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.clerk.malformed_publishable_key');
  });
});

describe('resolveOperatorExchanger — Descope', () => {
  it.each(['descope', 'DESCOPE', ' descope '])(
    'uses Descope when the provider is %j',
    async (p) => {
      const { fetchImpl, warn } = await exchange({
        OPERATOR_IDENTITY_PROVIDER: p,
        DESCOPE_PROJECT_ID: PROJECT_ID,
        CLERK_PUBLISHABLE_KEY: CLERK_PK,
      });
      expect(calledUrl(fetchImpl)).toBe('https://api.descope.com/v1/auth/password/signin');
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('accepts a project id with surrounding whitespace', async () => {
    const { fetchImpl } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: ` ${PROJECT_ID}\n`,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${PROJECT_ID}`);
  });

  it('refuses generically when the project id is unset', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      CLERK_PUBLISHABLE_KEY: CLERK_PK,
    });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.missing_project_id');
  });

  it('refuses generically when the project id is malformed, without logging it', async () => {
    const bad = 'P2abc/../evil';
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: bad,
    });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.malformed_project_id');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
  });
});

describe('resolveOperatorExchanger — regional Descope project', () => {
  it('refuses a regional project id (its API host is not api.descope.com)', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: `Peuc1${'a'.repeat(27)}`,
    });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.regional_project_unsupported');
  });
});

describe('resolveOperatorExchanger — unknown provider', () => {
  it('fails closed (no fallback to Clerk) and does not log the raw value', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'okta-secret-ish',
      CLERK_PUBLISHABLE_KEY: CLERK_PK,
      DESCOPE_PROJECT_ID: PROJECT_ID,
    });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.identity.unknown_provider');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('okta-secret-ish');
  });
});
