/**
 * RT-693 — OBS-1 §3.2 phone rule (Confluence 42926084, amended by RT-682),
 * ported from the Backend-Core reference (`PhoneMasker`, Backend-Core#833).
 *
 * A maximal run of ASCII digits inside one word, with no ASCII letter or
 * digit on either side, becomes `[phone]` when it is:
 *   - E.164: `+` (not glued to a letter or digit) then 8–15 digits not
 *     starting with 0; the `+` is masked too;
 *   - an Egyptian mobile: `0`, `20` or `0020`, then `1[0125]` and 8 digits.
 * One left-to-right pass over the word; no regex runs on the word itself.
 */

const PHONE = '[phone]';
const ASCII_ALNUM = /^[a-z0-9]$/i;
const ASCII_DIGIT = /^\d$/;
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;
// Egyptian mobile `1[0125]` + 8 digits behind a national (`0`) or country (`20`, `0020`) prefix.
const EGYPT_MOBILE_PREFIX_BY_LENGTH: ReadonlyMap<number, string> = new Map([
  [11, '0'],
  [12, '20'],
  [14, '0020'],
]);
const EGYPT_MOBILE_OPERATORS: ReadonlySet<string> = new Set(['10', '11', '12', '15']);

/** A span `[start, end)` inside one word. */
interface Span {
  start: number;
  end: number;
}

type PhoneKind = 'e164' | 'national' | null;

class PhoneMasker {
  private readonly word: string;

  constructor(word: string) {
    this.word = word;
  }

  masked(): string {
    const out: string[] = [];
    let at = 0;
    while (at < this.word.length) {
      const run = this.digitRunAt(at);
      if (run.end === at) {
        out.push(this.word.charAt(at));
        at += 1;
        continue;
      }
      const kind = this.phoneKind(run);
      if (kind === 'e164') out.pop(); // the `+` just pushed
      out.push(kind === null ? this.word.slice(run.start, run.end) : PHONE);
      at = run.end;
    }
    return out.join('');
  }

  /** The maximal digit run starting at `start`; empty when no digit is there. */
  private digitRunAt(start: number): Span {
    let end = start;
    while (ASCII_DIGIT.test(this.word.charAt(end))) end += 1;
    return { start, end };
  }

  /** Verdict for one digit run: `e164`, `national` or not a phone. */
  private phoneKind(run: Span): PhoneKind {
    if (this.isAlnumAt(run.end)) return null;
    if (this.hasLonePlusBefore(run) && this.isE164(run)) return 'e164';
    if (this.isAlnumAt(run.start - 1)) return null;
    return this.isEgyptianMobile(run) ? 'national' : null;
  }

  /** True when the character at `index` is an ASCII letter or digit (false off the word). */
  private isAlnumAt(index: number): boolean {
    return ASCII_ALNUM.test(this.word.charAt(index));
  }

  /** A `+` directly before the run, not itself glued to a letter or digit. */
  private hasLonePlusBefore(run: Span): boolean {
    return this.word.charAt(run.start - 1) === '+' && !this.isAlnumAt(run.start - 2);
  }

  /** 8–15 digits, not starting with 0 (the `+` is checked by the caller). */
  private isE164({ start, end }: Span): boolean {
    const digits = end - start;
    return (
      this.word.charAt(start) !== '0' && digits >= E164_MIN_DIGITS && digits <= E164_MAX_DIGITS
    );
  }

  /** `0`, `20` or `0020`, then `1[0125]` and 8 more digits. */
  private isEgyptianMobile({ start, end }: Span): boolean {
    const run = this.word.slice(start, end);
    const prefix = EGYPT_MOBILE_PREFIX_BY_LENGTH.get(run.length);
    if (prefix === undefined || !run.startsWith(prefix)) return false;
    return EGYPT_MOBILE_OPERATORS.has(run.slice(prefix.length, prefix.length + 2));
  }
}

/** Mask every phone number in one whitespace-free word (OBS-1 §3.2). */
export function maskPhones(word: string): string {
  return new PhoneMasker(word).masked();
}
