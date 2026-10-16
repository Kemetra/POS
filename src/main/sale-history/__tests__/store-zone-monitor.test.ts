/**
 * RT-553 (RT-545 S4) — the store-zone mismatch detector and its once-only,
 * in-memory flag. The zone the POS uses never changes; the monitor only reports.
 */
import { describe, expect, it, vi } from 'vitest';

import { STORE_TIME_ZONE, businessDayOf } from '../../../shared/time/business-day.js';
import { classifyStoreZone, createStoreZoneMonitor } from '../store-zone-monitor.js';

describe('RT-553 classifyStoreZone', () => {
  it.each(['Africa/Cairo', 'africa/cairo', 'AFRICA/CAIRO'])('%s matches the fixed zone', (zone) => {
    expect(classifyStoreZone(zone)).toBe('match');
  });

  it.each(['UTC', 'Europe/London', 'Asia/Riyadh'])('%s is a mismatch', (zone) => {
    expect(classifyStoreZone(zone)).toBe('mismatch');
  });

  it.each(['Not/AZone', 'Cairo time', ' Africa/Cairo', 'Africa/Cairo\n', 'x'.repeat(500)])(
    'the invalid zone %j is a mismatch (it cannot be confirmed as Cairo)',
    (zone) => {
      expect(classifyStoreZone(zone)).toBe('mismatch');
    },
  );

  it.each([undefined, '', null, 3])('%j is absent, never a mismatch', (zone) => {
    expect(classifyStoreZone(zone as string | undefined)).toBe('absent');
  });
});

function setup() {
  const logger = { warn: vi.fn() };
  const monitor = createStoreZoneMonitor({ logger });
  return { logger, monitor };
}

describe('RT-553 store zone monitor', () => {
  it('starts unknown: nothing read yet (offline) raises nothing', () => {
    const { monitor, logger } = setup();
    expect(monitor.status()).toEqual({
      status: 'unknown',
      expected: 'Africa/Cairo',
      reported: null,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a matching zone is a match and logs nothing', () => {
    const { monitor, logger } = setup();
    monitor.observe('Africa/Cairo');
    expect(monitor.status().status).toBe('match');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a UTC page raises the flag and logs exactly once across repeated pages', () => {
    const { monitor, logger } = setup();
    monitor.observe('UTC');
    monitor.observe('UTC');
    monitor.observe('UTC');
    expect(monitor.status()).toEqual({
      status: 'mismatch',
      expected: 'Africa/Cairo',
      reported: 'UTC',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { expected: 'Africa/Cairo', reported: 'UTC' },
      'sale_history:store_timezone_mismatch',
    );
  });

  it('a later matching page clears the flag; a new mismatch logs again', () => {
    const { monitor, logger } = setup();
    monitor.observe('UTC');
    monitor.observe('Africa/Cairo');
    expect(monitor.status().status).toBe('match');
    expect(monitor.status().reported).toBeNull();
    monitor.observe('UTC');
    expect(monitor.status().status).toBe('mismatch');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('a different mismatching zone logs again', () => {
    const { monitor, logger } = setup();
    monitor.observe('UTC');
    monitor.observe('Europe/London');
    expect(monitor.status().reported).toBe('Europe/London');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('an absent zone leaves the flag as it was, in either direction', () => {
    const { monitor, logger } = setup();
    monitor.observe(undefined);
    expect(monitor.status().status).toBe('unknown');
    monitor.observe('UTC');
    monitor.observe(undefined);
    expect(monitor.status().status).toBe('mismatch');
    monitor.observe('Africa/Cairo');
    monitor.observe(undefined);
    expect(monitor.status().status).toBe('match');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('an invalid zone is flagged but never echoed to the log or the bridge', () => {
    const { monitor, logger } = setup();
    monitor.observe('<script>alert(1)</script>');
    expect(monitor.status()).toEqual({
      status: 'mismatch',
      expected: 'Africa/Cairo',
      reported: null,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('script');
    expect(logger.warn).toHaveBeenCalledWith(
      { expected: 'Africa/Cairo', reported: 'invalid' },
      'sale_history:store_timezone_mismatch',
    );
  });

  it('never changes the zone the business day uses', () => {
    const { monitor } = setup();
    const instant = '2026-10-16T22:30:00.000Z';
    const before = businessDayOf(instant);
    monitor.observe('UTC');
    expect(STORE_TIME_ZONE).toBe('Africa/Cairo');
    expect(businessDayOf(instant)).toBe(before);
    expect(before).toBe('2026-10-17');
  });
});
