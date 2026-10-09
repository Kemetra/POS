/**
 * RT-320 — operator-facing text for the SchemaAheadGuard refusal (ADR-0006
 * rule 2): this POS build is older than the database it was started on. The
 * fix is to run the current release again, never to install an older one.
 */

export interface SchemaAheadRefusal {
  title: string;
  body: string;
}

/**
 * Right-to-left mark. The native dialog lays each paragraph out LTR, so a
 * trailing RLM keeps an Arabic line's sentence-final "." inside the RTL run.
 */
const RLM = '‏';

export function describeSchemaAheadRefusal(
  unknownMigrations: readonly string[],
): SchemaAheadRefusal {
  return {
    title: 'إصدار نقطة البيع أقدم من بياناتها',
    body: [
      `قاعدة بيانات هذا الجهاز حدّثها إصدار أحدث من نقطة البيع، ولا يستطيع هذا الإصدار العمل عليها.${RLM}`,
      `لم يُحذف أو يُغيَّر أي شيء. اتصل بمسؤول النظام لتثبيت الإصدار الحالي من نقطة البيع.${RLM}`,
      '',
      'This POS build is older than its local database, which a newer release has already ' +
        'migrated. Nothing was changed. Install the current release again.',
      `Unknown migrations: ${unknownMigrations.join(', ')}`,
    ].join('\n'),
  };
}
