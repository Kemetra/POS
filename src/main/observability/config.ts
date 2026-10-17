import type { ObservabilityStamp } from './scrub.js';

/**
 * RT-634 (OBS-5) — where POS Sentry gets its DSN and release configuration.
 *
 * All three values are runtime environment variables of the launched exe, read
 * in MAIN only, on the same route as `VITE_API_BASE_URL` and
 * `CLERK_PUBLISHABLE_KEY` (the lab launcher feeds them through `op run` from
 * 1Password). Nothing is baked into the asar or inlined into the renderer
 * bundle, and the DSN never crosses the bridge.
 *
 *   - `SENTRY_DSN`              — unset or blank: inert (contract §5). Must be an
 *                                 https EU-ingest DSN (`*.ingest.de.sentry.io`,
 *                                 the allowed egress, contract §6); anything
 *                                 else is refused and never echoed.
 *   - `DEPLOYMENT_ENVIRONMENT`  — the `env` tag (same name as Backend-Core).
 *   - `POS_PULSE_RELEASE`       — the release commit; `version` tag and Sentry
 *                                 `release` = its first 12 hex chars (SHA12).
 *
 * A missing or malformed env/release does not disable reporting: it is
 * stamped `unknown` and reported once as a warning code (never the value).
 */

const ALLOWED_INGEST_SUFFIX = '.ingest.de.sentry.io';
// Linear patterns: a single bounded character class each, no nesting.
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RELEASE_PATTERN = /^[0-9a-f]{12,40}$/i;
const PROJECT_ID_PATTERN = /^\d+$/;
const UNKNOWN = 'unknown';

export type ObservabilityDisabledReason = 'unset' | 'malformed' | 'egress_not_allowed';

export type ObservabilityStampWarning =
  | 'environment_missing'
  | 'environment_invalid'
  | 'release_missing'
  | 'release_invalid';

export type ObservabilityConfig =
  | { readonly kind: 'disabled'; readonly reason: ObservabilityDisabledReason }
  | {
      readonly kind: 'enabled';
      readonly dsn: string;
      readonly stamp: ObservabilityStamp;
      readonly warnings: readonly ObservabilityStampWarning[];
    };

type EnvBag = Record<string, string | undefined>;

function trimmed(env: EnvBag, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** An https DSN with a public key (username) and a numeric project id. */
function hasDsnShape(url: URL): boolean {
  const projectId = url.pathname.split('/').pop() ?? '';
  const hasKey = url.username.length > 0;
  return url.protocol === 'https:' && hasKey && PROJECT_ID_PATTERN.test(projectId);
}

function checkDsn(dsn: string): ObservabilityDisabledReason | null {
  const url = parseUrl(dsn);
  if (url === null || !hasDsnShape(url)) return 'malformed';
  return url.hostname.endsWith(ALLOWED_INGEST_SUFFIX) ? null : 'egress_not_allowed';
}

interface StampField {
  readonly value: string;
  readonly warning?: ObservabilityStampWarning;
}

function resolveEnvironment(raw: string | undefined): StampField {
  if (raw === undefined) return { value: UNKNOWN, warning: 'environment_missing' };
  return ENVIRONMENT_PATTERN.test(raw)
    ? { value: raw }
    : { value: UNKNOWN, warning: 'environment_invalid' };
}

function resolveRelease(raw: string | undefined): StampField {
  if (raw === undefined) return { value: UNKNOWN, warning: 'release_missing' };
  return RELEASE_PATTERN.test(raw)
    ? { value: raw.slice(0, 12).toLowerCase() }
    : { value: UNKNOWN, warning: 'release_invalid' };
}

/** Read and validate the observability settings. Never returns a bad DSN. */
export function resolveObservabilityConfig(env: EnvBag): ObservabilityConfig {
  const dsn = trimmed(env, 'SENTRY_DSN');
  if (dsn === undefined) return { kind: 'disabled', reason: 'unset' };
  const refused = checkDsn(dsn);
  if (refused !== null) return { kind: 'disabled', reason: refused };

  // Raw (untrimmed) values: a stray newline or space is a malformed value.
  const environment = resolveEnvironment(env['DEPLOYMENT_ENVIRONMENT'] || undefined);
  const release = resolveRelease(env['POS_PULSE_RELEASE'] || undefined);
  const warnings = [environment.warning, release.warning].filter(
    (w): w is ObservabilityStampWarning => w !== undefined,
  );
  return {
    kind: 'enabled',
    dsn,
    stamp: { environment: environment.value, release: release.value },
    warnings,
  };
}
