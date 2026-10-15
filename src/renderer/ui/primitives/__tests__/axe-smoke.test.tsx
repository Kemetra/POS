import { describe, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from './axe-config';
import { Button } from '../Button/Button';
import { StatusBanner } from '../StatusBanner/StatusBanner';

// T042 — axe baseline smoke on all restyled S2 primitives.
// Zero serious or critical violations.

afterEach(cleanup);

describe('axe baseline smoke — kept primitives (T042; RT-504 retired the rest)', () => {
  // ── Button ────────────────────────────────────────────────────────────────

  it('Button primary: no axe violations', async () => {
    const { container } = render(<Button intent="primary">Save</Button>);
    await expectNoAxeViolations(container);
  });

  it('Button secondary: no axe violations', async () => {
    const { container } = render(<Button intent="secondary">Cancel</Button>);
    await expectNoAxeViolations(container);
  });

  it('Button ghost: no axe violations', async () => {
    const { container } = render(<Button intent="ghost">Back</Button>);
    await expectNoAxeViolations(container);
  });

  it('Button destructive: no axe violations', async () => {
    const { container } = render(<Button intent="destructive">Delete</Button>);
    await expectNoAxeViolations(container);
  });

  it('Button disabled: no axe violations', async () => {
    const { container } = render(
      <Button intent="primary" disabled>
        Disabled
      </Button>,
    );
    await expectNoAxeViolations(container);
  });

  it('Button loading: no axe violations', async () => {
    const { container } = render(
      <Button intent="primary" loading>
        Loading
      </Button>,
    );
    await expectNoAxeViolations(container);
  });

  it('Button lg: no axe violations', async () => {
    const { container } = render(
      <Button intent="primary" size="lg">
        Large
      </Button>,
    );
    await expectNoAxeViolations(container);
  });

  // ── StatusBanner ──────────────────────────────────────────────────────────

  it('StatusBanner online (hidden): no axe violations', async () => {
    const { container } = render(<StatusBanner state="online" />);
    await expectNoAxeViolations(container);
  });

  it('StatusBanner degraded: no axe violations', async () => {
    const { container } = render(<StatusBanner state="degraded" message="Connection degraded" />);
    await expectNoAxeViolations(container);
  });

  it('StatusBanner offline: no axe violations', async () => {
    const { container } = render(<StatusBanner state="offline" message="Offline" />);
    await expectNoAxeViolations(container);
  });

  it('StatusBanner syncing: no axe violations', async () => {
    const { container } = render(<StatusBanner state="syncing" message="Syncing..." />);
    await expectNoAxeViolations(container);
  });
});
