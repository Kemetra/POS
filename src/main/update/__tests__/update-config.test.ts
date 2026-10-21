import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parsePublisherPins, readPublisherPins, resolveUpdateConfig } from '../update-config.js';

/**
 * RT-772 slice 2 — where the updater's three inputs come from.
 *   origin   ELECTRON_UPDATE_FEED_URL   (constitution: a configured origin, not code)
 *   channel  POS_PULSE_UPDATE_CHANNEL   (set at provisioning; lab | canary | stable)
 *   pins     `publisherName` in the app-update.yml electron-builder bakes into the build
 * The origin confers NO trust; authenticity is the pinned publisher signature.
 */

describe('resolveUpdateConfig', () => {
  it('reads the origin and channel from the environment', () => {
    expect(
      resolveUpdateConfig({
        ELECTRON_UPDATE_FEED_URL: 'https://updates.example/lab',
        POS_PULSE_UPDATE_CHANNEL: 'lab',
      }),
    ).toEqual({ origin: 'https://updates.example/lab', channel: 'lab' });
  });

  it('has no origin when the variable is unset or blank', () => {
    expect(resolveUpdateConfig({}).origin).toBeUndefined();
    expect(resolveUpdateConfig({ ELECTRON_UPDATE_FEED_URL: '   ' }).origin).toBeUndefined();
  });

  it('trims the origin', () => {
    expect(resolveUpdateConfig({ ELECTRON_UPDATE_FEED_URL: ' https://u.example/x ' }).origin).toBe(
      'https://u.example/x',
    );
  });

  it('defaults the channel to stable when unset', () => {
    expect(resolveUpdateConfig({}).channel).toBe('stable');
  });

  it.each(['lab', 'canary', 'stable'])('accepts channel %s', (channel) => {
    expect(resolveUpdateConfig({ POS_PULSE_UPDATE_CHANNEL: channel }).channel).toBe(channel);
  });

  it('marks an unknown channel invalid (null), never silently stable', () => {
    expect(resolveUpdateConfig({ POS_PULSE_UPDATE_CHANNEL: 'beta' }).channel).toBeNull();
    expect(resolveUpdateConfig({ POS_PULSE_UPDATE_CHANNEL: 'LAB ' }).channel).toBeNull();
  });
});

describe('parsePublisherPins', () => {
  it('reads the list form electron-builder writes', () => {
    const yml = [
      'provider: generic',
      'url: https://updates.example/lab',
      'channel: lab',
      'publisherName:',
      '  - Kemetra POS LAB TEST - NOT FOR PRODUCTION',
      'updaterCacheDirName: pos-pulse-updater',
      '',
    ].join('\n');
    expect(parsePublisherPins(yml)).toEqual(['Kemetra POS LAB TEST - NOT FOR PRODUCTION']);
  });

  it('reads several list entries', () => {
    expect(parsePublisherPins('publisherName:\n  - A Corp\n  - B Corp\nother: x\n')).toEqual([
      'A Corp',
      'B Corp',
    ]);
  });

  it('reads the scalar form, with or without quotes', () => {
    expect(parsePublisherPins('publisherName: Acme Ltd\n')).toEqual(['Acme Ltd']);
    expect(parsePublisherPins('publisherName: "Acme Ltd"\n')).toEqual(['Acme Ltd']);
    expect(parsePublisherPins("publisherName: 'Acme Ltd'\r\n")).toEqual(['Acme Ltd']);
  });

  it('has no pin when the key is absent, empty or blank', () => {
    expect(parsePublisherPins('provider: generic\n')).toEqual([]);
    expect(parsePublisherPins('publisherName:\nurl: x\n')).toEqual([]);
    expect(parsePublisherPins('publisherName: ""\n')).toEqual([]);
    expect(parsePublisherPins('publisherName:\n  - ""\n  -   \n')).toEqual([]);
    expect(parsePublisherPins('')).toEqual([]);
  });

  it('ignores a commented-out pin', () => {
    expect(parsePublisherPins('# publisherName: Evil\nprovider: generic\n')).toEqual([]);
  });
});

describe('readPublisherPins', () => {
  it('reads pins from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rt772-pins-'));
    try {
      const file = path.join(dir, 'app-update.yml');
      writeFileSync(file, 'publisherName:\n  - Acme Ltd\n');
      expect(readPublisherPins(file)).toEqual(['Acme Ltd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no pins when the file is missing (so the service fails closed)', () => {
    expect(
      readPublisherPins(path.join(tmpdir(), 'rt772-does-not-exist', 'app-update.yml')),
    ).toEqual([]);
  });
});
