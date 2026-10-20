import { readFileSync } from 'node:fs';

import { UPDATE_CHANNELS } from './update-types.js';
import type { UpdateChannel } from './update-types.js';

/**
 * RT-772 slice 2 — the updater's three inputs (constitution v1.6.0).
 *
 *   origin   `ELECTRON_UPDATE_FEED_URL`  a configured HTTPS origin, never code
 *   channel  `POS_PULSE_UPDATE_CHANNEL`  set at provisioning: lab | canary | stable
 *   pins     `publisherName` in the `app-update.yml` electron-builder bakes into the build
 *
 * The origin confers NO trust: authenticity is the pinned publisher signature.
 * electron-updater skips signature verification entirely when no publisher is
 * pinned, so the service refuses to run without one (see update-service.ts).
 */

export interface ResolvedUpdateConfig {
  readonly origin: string | undefined;
  /** `null` when the variable holds a value that is not a known channel. */
  readonly channel: UpdateChannel | null;
}

const DEFAULT_CHANNEL: UpdateChannel = 'stable';

function isChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function resolveUpdateConfig(env: NodeJS.ProcessEnv): ResolvedUpdateConfig {
  const origin = env.ELECTRON_UPDATE_FEED_URL?.trim();
  const rawChannel = env.POS_PULSE_UPDATE_CHANNEL;
  const channel =
    rawChannel === undefined || rawChannel === ''
      ? DEFAULT_CHANNEL
      : isChannel(rawChannel)
        ? rawChannel
        : null;
  return { origin: origin === undefined || origin === '' ? undefined : origin, channel };
}

const KEY_LINE = /^publisherName:\s*(.*)$/;
const LIST_ITEM = /^\s+-\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return (quoted === null ? trimmed : (quoted[2] ?? '')).trim();
}

/** The publisher names electron-builder wrote to `app-update.yml`, scalar or list form. */
export function parsePublisherPins(yml: string): string[] {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((line) => KEY_LINE.test(line));
  if (start === -1) return [];
  const inline = unquote(KEY_LINE.exec(lines[start] ?? '')?.[1] ?? '');
  if (inline !== '') return [inline];
  const pins: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = LIST_ITEM.exec(line);
    if (item === null) break;
    pins.push(unquote(item[1] ?? ''));
  }
  return pins.filter((pin) => pin !== '');
}

/** An unreadable or missing file means no pin (the service then fails closed). */
export function readPublisherPins(file: string): string[] {
  try {
    return parsePublisherPins(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
