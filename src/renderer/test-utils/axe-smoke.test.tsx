import { describe, it, afterEach, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from './axe-config';

// T042 — axe baseline smoke for the shared helper. RT-606 retired the last 007
// primitives it used to render, so it now pins the helper itself: a clean tree
// passes, a real violation fails, and a caller can switch a rule off.

afterEach(cleanup);

describe('expectNoAxeViolations — shared axe helper', () => {
  it('passes for an accessible tree', async () => {
    const { container } = render(
      <button type="button" dir="rtl" lang="ar">
        حفظ
      </button>,
    );
    await expectNoAxeViolations(container);
  });

  it('throws with the rule id when a violation is found', async () => {
    const { container } = render(<button type="button" />);
    await expect(expectNoAxeViolations(container)).rejects.toThrow(/\[button-name\]/);
  });

  it('lets a caller disable a rule on top of the defaults', async () => {
    const { container } = render(<button type="button" />);
    await expectNoAxeViolations(container, { rules: { 'button-name': { enabled: false } } });
  });
});
