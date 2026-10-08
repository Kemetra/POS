import type { JSX } from 'react';
import { V5Icon } from './V5Icon';

/**
 * Status roles (freeze 15 §4): success = proven only · warning = degraded ·
 * danger = destructive, blocking or UNKNOWN · info = pending or recorded but
 * not proven.
 */
export type Tone = 'info' | 'success' | 'warning' | 'danger';

/** The tone's own glyph, so a tone is never told by colour alone (P8). */
export function ToneIcon({ tone }: { tone: Tone }): JSX.Element {
  return (
    <span className="v5-tone-icon" data-icon={tone}>
      <V5Icon name={`status-${tone}`} size={20} />
    </span>
  );
}

/** Danger interrupts; everything else is announced politely. */
export function toneRole(tone: Tone): 'alert' | 'status' {
  return tone === 'danger' ? 'alert' : 'status';
}
