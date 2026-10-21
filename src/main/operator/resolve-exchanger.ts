/**
 * RT-792 — choose the manager/admin credential exchanger.
 *
 * `OPERATOR_IDENTITY_PROVIDER` selects `clerk` (the default when unset or
 * empty) or `descope`. The Clerk branch is the pre-RT-792 behaviour, moved
 * here unchanged from `index.ts` so the selection is testable (index.ts runs
 * `app.whenReady()` at import and cannot load under vitest).
 *
 * Any missing or malformed setting logs ONE structured warning (never the raw
 * value) and returns an exchanger that refuses generically without a network
 * call, so the app still launches and `/sign-in` renders. An unknown provider
 * also refuses: it never falls back to Clerk silently. Rollback from Descope is
 * setting the variable back to `clerk`.
 */

import {
  createClerkExchanger,
  decodeFrontendApiBaseUrl,
  type ClerkExchanger,
} from './clerk-client.js';
import {
  createDescopeExchanger,
  isDescopeProjectId,
  isRegionalDescopeProjectId,
} from './descope-client.js';

export interface ResolveOperatorExchangerDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: { warn(payload: object, msg: string): void };
}

const refusingExchanger: ClerkExchanger = {
  exchange: () => Promise.resolve({ kind: 'refused' as const }),
};

function refuseWith(
  logger: ResolveOperatorExchangerDeps['logger'],
  event: string,
  msg: string,
): ClerkExchanger {
  logger.warn({ event }, msg);
  return refusingExchanger;
}

export function resolveOperatorExchanger(deps: ResolveOperatorExchangerDeps): ClerkExchanger {
  const provider = (deps.env['OPERATOR_IDENTITY_PROVIDER'] ?? '').trim().toLowerCase();
  if (provider === '' || provider === 'clerk') return resolveClerk(deps);
  if (provider === 'descope') return resolveDescope(deps);
  return refuseWith(
    deps.logger,
    'operator.identity.unknown_provider',
    'OPERATOR_IDENTITY_PROVIDER is not clerk or descope; sign-in will refuse generically until corrected.',
  );
}

/**
 * Decodes the Clerk Frontend API host from `CLERK_PUBLISHABLE_KEY`. The
 * publishable key is NOT a secret — it identifies the Clerk instance.
 */
function resolveClerk(deps: ResolveOperatorExchangerDeps): ClerkExchanger {
  const { logger } = deps;
  const pk = deps.env['CLERK_PUBLISHABLE_KEY'];
  if (typeof pk !== 'string' || pk.length === 0) {
    return refuseWith(
      logger,
      'operator.clerk.missing_publishable_key',
      'CLERK_PUBLISHABLE_KEY unset; sign-in will refuse generically until configured.',
    );
  }
  const fapi = decodeFrontendApiBaseUrl(pk);
  if (fapi === null) {
    return refuseWith(
      logger,
      'operator.clerk.malformed_publishable_key',
      'CLERK_PUBLISHABLE_KEY malformed; sign-in will refuse generically until corrected.',
    );
  }
  return createClerkExchanger({ frontendApiBaseUrl: fapi, fetch: deps.fetch });
}

/** The Descope project id is a public client identifier, not a secret. */
function resolveDescope(deps: ResolveOperatorExchangerDeps): ClerkExchanger {
  const { logger } = deps;
  const projectId = (deps.env['DESCOPE_PROJECT_ID'] ?? '').trim();
  if (projectId.length === 0) {
    return refuseWith(
      logger,
      'operator.descope.missing_project_id',
      'DESCOPE_PROJECT_ID unset; sign-in will refuse generically until configured.',
    );
  }
  if (!isDescopeProjectId(projectId)) {
    return refuseWith(
      logger,
      'operator.descope.malformed_project_id',
      'DESCOPE_PROJECT_ID malformed; sign-in will refuse generically until corrected.',
    );
  }
  if (isRegionalDescopeProjectId(projectId)) {
    return refuseWith(
      logger,
      'operator.descope.regional_project_unsupported',
      'DESCOPE_PROJECT_ID is a regional project; only the api.descope.com region is supported.',
    );
  }
  return createDescopeExchanger({ projectId, fetch: deps.fetch });
}
