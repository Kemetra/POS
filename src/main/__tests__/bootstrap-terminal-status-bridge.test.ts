import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-603 (VN-S6 S6-2, doc 24 A4-1, A4-5) — composition-root guard for the
 * terminal status bridge:
 *   • `terminalStatus:get` is registered at app start on the guarded ipcMain,
 *     NOT inside a paired-only starter, so an unpaired terminal is answered;
 *   • the push goes to the app windows only and is stopped on quit;
 *   • the sync reader is bound by the paired sale-sync starter.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

describe('main/index.ts wires the terminal status bridge (RT-603)', () => {
  it('registers terminalStatus:get on the guarded ipcMain before any paired-only starter', () => {
    const register = source.indexOf('registerTerminalStatusHandlers(guardedIpcMain,');
    const firstPairedStarter = source.indexOf('pairedWorkersLatch.register(');
    expect(register).toBeGreaterThan(0);
    expect(firstPairedStarter).toBeGreaterThan(0);
    expect(register).toBeLessThan(firstPairedStarter);
  });

  it('pushes terminalStatus:changed to the app windows and stops the publisher on quit', () => {
    const start = source.indexOf('createTerminalStatusPublisher({');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, source.indexOf('registerTerminalStatusHandlers(', start));
    expect(block).toContain('BrowserWindow.getAllWindows()');
    expect(block).toContain('TERMINAL_STATUS_IPC_CHANNELS.CHANGED');
    expect(block).toContain("workerRegistry.register('terminal status push'");
  });

  it('binds the sync reader inside the paired sale-sync starter', () => {
    const starter = source.indexOf(
      "pairedWorkersLatch.register('finalize listener + sale-sync engine'",
    );
    const bind = source.indexOf('terminalStatusPublisher.setSyncReader(');
    expect(starter).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(starter);
  });
});
