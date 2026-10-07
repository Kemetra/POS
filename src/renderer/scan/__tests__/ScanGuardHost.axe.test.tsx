/**
 * RT-239 (VNext A2) — the scan notice is a new surface: axe must be clean.
 * Kept apart from the timing tests because axe needs real timers.
 */
import { act, cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config.js';
import { ScanGuardHost, resetScanGuardForTests } from '../ScanGuardHost.js';
import { SCAN_REFUSED_MESSAGE } from '../scan-messages.js';
import { useScanNoticeStore } from '../scan-notice-store.js';

beforeEach(() => {
  resetScanGuardForTests();
});

afterEach(() => {
  cleanup();
});

describe('ScanGuardHost accessibility', () => {
  it('no notice: no axe violations', async () => {
    const { container } = render(<ScanGuardHost />);
    await expectNoAxeViolations(container);
  });

  it.each(Object.values(SCAN_REFUSED_MESSAGE))(
    'notice "%s": no axe violations',
    async (message) => {
      const { container } = render(<ScanGuardHost />);
      act(() => {
        useScanNoticeStore.getState().show(message);
      });
      await expectNoAxeViolations(container);
    },
  );
});
