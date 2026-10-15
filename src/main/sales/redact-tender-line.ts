/**
 * The redacted shape of one tender line, as it appears in sale audit payloads
 * and in the persisted `tender_lines_summary_json` (card references masked).
 * Key order is part of the persisted contract: type, amount, change, reference.
 */

interface RedactableTenderLine {
  tender_type: string;
  amount_applied_minor: number;
  change_due_minor?: number | undefined;
  external_reference?: string | undefined;
}

export function redactTenderLine(line: RedactableTenderLine): Record<string, unknown> {
  const out: Record<string, unknown> = {
    tender_type: line.tender_type,
    amount_applied_minor: line.amount_applied_minor,
  };
  if (line.tender_type === 'cash' && line.change_due_minor !== undefined) {
    out.change_due_minor = line.change_due_minor;
  }
  if (line.tender_type === 'external_card_terminal' && line.external_reference !== undefined) {
    out.external_reference = '*****';
  }
  return out;
}
