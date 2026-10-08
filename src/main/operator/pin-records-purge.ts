import type { DatabaseHandle } from '../db/client.js';

/**
 * RT-215 decision 5 — on a re-pair, delete the `cashier_pin_records` that
 * belong to a different terminal than the one just paired.
 *
 * A re-pair always yields a new terminal_id (RT-138 L5), and every PIN lookup
 * is keyed on the current terminal_id, so those rows can never be used again.
 * Only PIN rows are touched: sales, the sale-sync outbox and every other table
 * are left exactly as they are (rows from the previous pairing are HELD, not
 * replayed — RT-221).
 *
 * Returns the number of rows deleted. Throws on an empty terminal id (which
 * would otherwise match every row) or on a database error; the caller logs.
 */
export function purgeOtherTerminalPinRecords(
  db: Pick<DatabaseHandle, 'prepare'>,
  currentTerminalId: string,
): number {
  if (currentTerminalId.length === 0) {
    throw new Error('purgeOtherTerminalPinRecords: terminal id is required');
  }
  const stmt = db.prepare('DELETE FROM cashier_pin_records WHERE terminal_id <> ?') as {
    run(terminalId: string): { changes: number };
  };
  return stmt.run(currentTerminalId).changes;
}
