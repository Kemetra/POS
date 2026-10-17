/**
 * RT-603 (VN-S6 S6-2, doc 24 §3.1, §3.2) — `terminalStatus:get` IPC registration.
 *
 * One read-only invoke. It accepts exactly `{}` (INP-1, A4-2); anything else —
 * no argument, a key, a non-plain object, an extra argument — gets `INVALID`
 * and never reaches the reader. Scope comes from main, never from the renderer.
 *
 * Registered at app start on the guarded ipcMain (sender guard, A4-1), not in a
 * paired-only starter, so an unpaired terminal is answered (A4-5). It is not
 * session-gated and not on the locked-session allowlist (A4-6, D-6-10). The
 * `terminalStatus:changed` push is sent by `TerminalStatusPublisher`.
 */
import type { IpcMain } from 'electron';

import {
  TERMINAL_STATUS_INVALID,
  TERMINAL_STATUS_IPC_CHANNELS,
  type TerminalStatusInvalid,
  type TerminalStatusSnapshot,
} from '../../shared/terminal-status/types.js';

export interface TerminalStatusHandlerDeps {
  /** The publisher's cached read (A4-7). */
  read: () => Promise<TerminalStatusSnapshot>;
}

/** A plain object with no own keys — nothing else is a valid request. */
function isEmptyObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  // An array's prototype is Array.prototype, so the check below refuses it too.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).length === 0;
}

export function registerTerminalStatusHandlers(
  ipcMain: IpcMain,
  deps: TerminalStatusHandlerDeps,
): void {
  ipcMain.handle(
    TERMINAL_STATUS_IPC_CHANNELS.GET,
    (_event, ...args: unknown[]): Promise<TerminalStatusSnapshot> | TerminalStatusInvalid =>
      args.length === 1 && isEmptyObject(args[0]) ? deps.read() : TERMINAL_STATUS_INVALID,
  );
}
