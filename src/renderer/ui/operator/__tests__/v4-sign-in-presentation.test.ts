import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { SIGN_IN_REFUSAL_COPY, EMPTY_INPUT_MESSAGE } from '../messages';

/**
 * 022 US1 T054 (PARTIAL) — Arabic-first sign-in presentation.
 *
 * SCOPE NOTE — why this file covers only part of T054:
 *
 * T054 asks for Arabic-first sign-in copy AND v4.0 token presentation. The
 * token half and the refusal-copy half are done and asserted here. The
 * form/control LABELS (`Email or username`, `Password`, `Cashier roster`,
 * `PIN entry`, `Delete`, `Enter`) are NOT, because T053 in the same phase
 * requires `cashier-walling.test.tsx` and `operator-route-guard.test.tsx` to
 * pass UNMODIFIED — and those suites query by exactly those label strings
 * (`getByLabelText(/email or username/i)`, `aria-label="Cashier roster"`, …).
 *
 * The tempting workaround — Arabic visible text with English aria-labels —
 * is rejected on purpose: it breaks WCAG 2.5.3 (Label in Name) by creating a
 * visible-text/accessible-name mismatch, which is a worse defect than the
 * inconsistency being fixed.
 *
 * So the label pass is escalated as a scoped follow-up that is ALLOWED to
 * re-point those queries. T054 stays unticked until it lands.
 */

const STYLES = readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf-8');
const SIGN_IN_ROUTE = readFileSync(resolve(__dirname, '../../../routes/sign-in.tsx'), 'utf-8');

const ARABIC = /[؀-ۿ]/u;

describe('022 T054 — sign-in refusal copy is Arabic-first', () => {
  it('every refusal category resolves to Arabic copy', () => {
    for (const [category, copy] of Object.entries(SIGN_IN_REFUSAL_COPY)) {
      expect(copy, `${category} copy is not Arabic: "${copy}"`).toMatch(ARABIC);
    }
  });

  it('the empty-input prompt is Arabic', () => {
    expect(EMPTY_INPUT_MESSAGE).toMatch(ARABIC);
  });

  it('preserves P11: one generic message per category, no interpolation', () => {
    const values = Object.values(SIGN_IN_REFUSAL_COPY);
    // Distinct categories may share wording, but none may carry a template
    // placeholder — interpolated user input is what P11 forbids.
    for (const copy of values) {
      expect(copy).not.toMatch(/\$\{|\{\{|%s/);
    }
    // No category leaks WHICH factor failed (the whole point of P11).
    expect(SIGN_IN_REFUSAL_COPY.invalid_input).not.toMatch(/password|كلمة السر|اسم المستخدم/i);
  });
});

describe('022 T054 — sign-in presentation resolves through v4.0 tokens', () => {
  it('the sign-in route introduces no inline style literals', () => {
    // The whole surface must re-theme from :root alone. `token-guard.test.ts`
    // enforces this across src/renderer/ui/**; this pins the route file too,
    // which lives outside that tree.
    expect(SIGN_IN_ROUTE).not.toMatch(/style=\{\{/);
  });

  it('the roster + pin-pad classes resolve colour through tokens, not literals', () => {
    for (const selector of ['.roster-list__item-btn', '.pin-pad__key']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = STYLES.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(body.length, `${selector} not found in stylesheet`).toBeGreaterThan(0);
      expect(body, `${selector} pins a raw colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});
