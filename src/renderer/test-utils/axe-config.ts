import axe from 'axe-core';
import type { RunOptions as AxeRunOptions } from 'axe-core';

/**
 * T024 — First-party axe helper.
 *
 * Calls axe.run(container, mergedOptions) from axe-core ^4.10.0 and
 * asserts violations.length === 0.
 *
 * Disabled rules (with rationale):
 *  - color-contrast: happy-dom does not compute layout color accurately;
 *    manual review against the Figma file is the substitute.
 *  - meta-viewport: N/A in an Electron renderer (no viewport meta tag).
 *
 * Adding a new disabled rule REQUIRES a rationale comment here; otherwise
 * the guard test fails (contracts/shared-components.md §"axe rule pass").
 *
 * Signature is frozen per contracts/shared-components.md:
 *   expectNoAxeViolations(container: HTMLElement, options?: AxeRunOptions): Promise<void>
 */

const DEFAULT_DISABLED_RULES: AxeRunOptions = {
  rules: {
    'color-contrast': { enabled: false },
    'meta-viewport': { enabled: false },
  },
};

export async function expectNoAxeViolations(
  container: HTMLElement,
  options?: AxeRunOptions,
): Promise<void> {
  const merged: AxeRunOptions = {
    ...DEFAULT_DISABLED_RULES,
    ...options,
    rules: {
      ...DEFAULT_DISABLED_RULES.rules,
      ...options?.rules,
    },
  };

  const results = await axe.run(container, merged);

  if (results.violations.length > 0) {
    const summary = results.violations
      .map((v) => `[${v.id}] ${v.description}: ${v.nodes.map((n) => n.html).join(', ')}`)
      .join('\n');
    throw new Error(`axe violations found:\n${summary}`);
  }
}
