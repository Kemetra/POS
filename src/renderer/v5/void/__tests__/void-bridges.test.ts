/**
 * RT-530 — the void screen reads both bridges from `window.api`, and only when
 * the preload exposes both (no half-wired screen).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { windowVoidBridges } from '../void-bridges';
import { fakeBridges } from './__helpers__/void-fixtures';

type ApiWindow = { api?: Record<string, unknown> };

afterEach(() => {
  delete (window as unknown as ApiWindow).api;
});

describe('windowVoidBridges', () => {
  it('returns the void and approval bridges when the preload exposes both', () => {
    const { saleVoid, approval } = fakeBridges();
    (window as unknown as ApiWindow).api = { saleVoid, approval };
    expect(windowVoidBridges()).toEqual({ saleVoid, approval });
  });

  it('is null without a preload api', () => {
    expect(windowVoidBridges()).toBeNull();
  });

  it('is null when either bridge is missing', () => {
    const { saleVoid, approval } = fakeBridges();
    (window as unknown as ApiWindow).api = { saleVoid };
    expect(windowVoidBridges()).toBeNull();
    (window as unknown as ApiWindow).api = { approval };
    expect(windowVoidBridges()).toBeNull();
  });
});
