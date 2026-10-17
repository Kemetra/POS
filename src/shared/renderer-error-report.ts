/**
 * RT-634 (OBS-5) — the renderer's error report, sent over `app:report-error`.
 *
 * Deliberately narrow: an error's class name, message and stack, nothing
 * else. Main treats every field as untrusted (validated, capped,
 * rate-limited) and scrubs the result through the OBS-1 allowlist before
 * anything leaves the device. Never put business data, ids or payloads here.
 */
export interface RendererErrorReport {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}
