import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-113 P2 (Codex P1, PR #535 comment 4179617256) — the composition root
 * wires the ONE sale-boundary choke point.
 *
 * `sale-boundary-guard.test.ts` proves the wrapper re-checks after every sale
 * call; this static guard proves `src/main/index.ts` actually uses it: the IPC
 * surface every sale handler registers on is wrapped, and the re-check is bound
 * to the cashier admission keeper. (Importing `index.ts` needs the Electron
 * globals, so this is a source check, like `bootstrap-wires-operator.test.ts`.)
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');

describe('main/index.ts wires the sale-boundary choke point (RT-113 P2)', () => {
  const source = readFileSync(INDEX_PATH, 'utf-8');

  it('imports createSaleBoundaryIpcMain', () => {
    expect(source).toMatch(
      /import\s+\{\s*createSaleBoundaryIpcMain\s*\}\s+from\s+'\.\/ipc\/sale-boundary-guard\.js'/,
    );
  });

  it('the guarded IPC surface is wrapped by the choke point', () => {
    expect(source).toMatch(/const guardedIpcMain = createSaleBoundaryIpcMain\(/);
  });

  it('the choke point re-checks through the cashier admission keeper', () => {
    expect(source).toMatch(
      /saleBoundaryProbe\.recheck = \(\) => \{\s*cashierAdmissionKeeper\.recheckSafePoint\(\);\s*\}/,
    );
  });

  it('the cart and payments/tender handlers register on the guarded surface', () => {
    expect(source).toMatch(/registerCartHandlers\(guardedIpcMain,/);
    expect(source).toMatch(/registerPaymentsHandlers\(guardedIpcMain,/);
  });
});
