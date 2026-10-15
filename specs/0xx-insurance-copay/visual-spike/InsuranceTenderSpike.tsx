/**
 * InsuranceTenderSpike.tsx — VISUAL SPIKE of the insurance / co-pay tender panel.
 *
 * ⚠️ UNWIRED DESIGN PROTOTYPE. This component:
 *   • imports NOTHING from the real payment flow (no payment-store, no bridge,
 *     no tender enum, no envelope) — it is deliberately isolated;
 *   • persists NOTHING and calls NO IPC — `onConfirm` is a console no-op;
 *   • runs on a STUBBED cart with an explicit per-line `eligible` flag, because
 *     the real cart model has no VAT/eligibility signal (the blocker).
 *
 * It exists to let the team SEE and critique the design in the production token
 * system before committing to the contract work the real feature needs. See
 * ../README.md for the BLOCKED preflight verdict.
 *
 * Aesthetic: faithful to the shipped POS-Pulse visual system —
 *   navy `--color-primary` for selection/coverage, success-green as TEXT ONLY
 *   (containment), Quiet-Edge `--color-border`, mono money, RTL, ≥44px targets.
 *   The teal `--color-accent` is intentionally NOT used (One-Accent Rule).
 *
 * Tokens referenced (all defined in src/renderer/styles/tailwind.css):
 *   --color-primary #1f4e7a · --color-primary-soft #e6eef6 · --color-success
 *   #1f8a5b · --color-success-soft · --color-text-muted · --color-border
 *   #d8dfe7 · --font-family-mono · --radius-control 10px · --radius-card 14px
 */
import { useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';

import {
  DEMO_PLANS,
  canConfirm,
  computeCoPay,
  formatMinor,
  memberIdValid,
  methodLabel,
  type InsurancePlan,
  type SpikeCartLine,
} from './copay-math.js';

/** Stubbed demo basket: 2 medicines (eligible) + 1 device (not). */
const DEMO_CART: readonly SpikeCartLine[] = [
  { display_name: 'باراسيتامول ٥٠٠ مجم', quantity: 2, unit_price_minor: 1550, eligible: true },
  { display_name: 'أموكسيسيلين ٢٥٠ مجم', quantity: 1, unit_price_minor: 8900, eligible: true },
  { display_name: 'جهاز قياس ضغط', quantity: 1, unit_price_minor: 45000, eligible: false },
];

/** Banknote roll-ups for the co-pay quick-amount buttons (minor units). */
function quickAmounts(patientDue: number): readonly { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [{ label: 'بالضبط', value: patientDue }];
  for (const note of [15000, 20000, 50000, 100000]) {
    if (note > patientDue) out.push({ label: formatMinor(note), value: note });
  }
  return out.slice(0, 4);
}

/** Arabic-Indic numeral rendering for the coverage pill (operator-facing). */
function arabicPct(pct: number): string {
  return `تغطية ${pct.toLocaleString('ar-EG')}٪`;
}

// ── token helpers (typed CSSProperties using the real custom props) ──────────
const v = (name: string): string => `var(${name})`;

export function InsuranceTenderSpike(): JSX.Element {
  const [planId, setPlanId] = useState<string | null>(null);
  const [memberId, setMemberId] = useState('');
  const [tendered, setTendered] = useState<number | null>(null);

  // Auto-focus target: the member/card-ID input. Focus is moved here when a
  // plan is selected (audit P1, cheapest hop of handoff §7's focus flow). This
  // is the ONLY focus-management implemented; the rest is documented as
  // carry-forward in README.md.
  const memberInputRef = useRef<HTMLInputElement>(null);

  const plan: InsurancePlan | null = useMemo(
    () => DEMO_PLANS.find((p) => p.id === planId) ?? null,
    [planId],
  );

  const breakdown = useMemo(
    () => computeCoPay(DEMO_CART, plan?.coverPct ?? null, tendered),
    [plan, tendered],
  );

  const memberOk = memberIdValid(memberId);
  const ready = canConfirm(plan !== null, memberId, breakdown, tendered);
  const hasEligible = breakdown.eligible > 0;

  function selectPlan(id: string): void {
    setPlanId(id);
    setTendered(null); // reset co-pay when the plan changes
    // §7 focus flow (first hop only): on selecting a plan, move focus to the
    // member field so a keyboard cashier flows straight into entry. Done in the
    // event handler (not a render effect) so focus follows the genuine action.
    // rAF defers until after React commits the now-enabled input.
    requestAnimationFrame(() => memberInputRef.current?.focus());
  }

  const shellStyle: CSSProperties = {
    direction: 'rtl',
    fontFamily: 'system-ui, "Segoe UI", sans-serif',
    color: '#1a2733',
    background: '#f4f7fa',
    padding: 24,
    maxWidth: 560,
    margin: '0 auto',
  };

  const cardStyle: CSSProperties = {
    background: '#fff',
    border: `1px solid ${v('--color-border')}`,
    borderRadius: 14,
    padding: 16,
  };

  return (
    <section
      aria-label="معاينة تصميم — تأمين / مساهمة المريض"
      data-spike="insurance-copay"
      style={shellStyle}
    >
      {/* Unwired-prototype banner — make the disposability unmistakable. */}
      <p
        style={{
          fontSize: 12,
          color: v('--color-text-muted'),
          background: '#fff7e6',
          border: '1px solid #f0d9a8',
          borderRadius: 10,
          padding: '8px 12px',
          marginBottom: 16,
        }}
      >
        معاينة تصميم فقط — غير موصولة بأي دفع أو حفظ. Visual spike, not wired.
      </p>

      <header style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: v('--color-text-muted') }}>الإجمالي المستحق</div>
        <div
          dir="ltr"
          style={{
            fontFamily: v('--font-family-mono'),
            fontSize: 28,
            fontWeight: 700,
            textAlign: 'left',
          }}
        >
          {formatMinor(breakdown.total)}
        </div>
      </header>

      {/* Plan picker — radiogroup, single-select. */}
      <div role="radiogroup" aria-label="جهة التأمين" style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
        {DEMO_PLANS.map((p) => {
          const selected = p.id === planId;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                selectPlan(p.id);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                padding: '10px 14px',
                textAlign: 'start',
                borderRadius: 14,
                cursor: 'pointer',
                background: selected ? v('--color-primary-soft') : '#fff',
                border: `1px solid ${selected ? v('--color-primary') : v('--color-border')}`,
                boxShadow: selected ? `inset 0 0 0 1px ${v('--color-primary')}` : 'none',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  display: 'grid',
                  placeItems: 'center',
                  background: v('--color-primary-soft'),
                  color: v('--color-primary'),
                  flexShrink: 0,
                }}
              >
                {/* shield-plus glyph (inline SVG — lucide-react is not a dep) */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                  <path d="M9 12h6" /><path d="M12 9v6" />
                </svg>
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{p.ar}</span>
                <span dir="ltr" style={{ display: 'block', fontSize: 12, color: v('--color-text-muted'), textAlign: 'left' }}>
                  {p.en}
                </span>
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: v('--font-family-mono'),
                  color: v('--color-primary'),
                  background: v('--color-primary-soft'),
                  borderRadius: 999,
                  padding: '3px 10px',
                  whiteSpace: 'nowrap',
                }}
              >
                {arabicPct(p.coverPct)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tender slots */}
      <div style={{ ...cardStyle, display: 'grid', gap: 12, marginBottom: 14 }}>
        {/* Member card row */}
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, color: v('--color-text-muted') }}>رقم بطاقة التأمين</span>
          <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              ref={memberInputRef}
              dir="ltr"
              value={memberId}
              onChange={(e) => {
                setMemberId(e.target.value.toUpperCase());
              }}
              aria-invalid={plan !== null && !memberOk}
              placeholder={plan ? `${plan.prefix}-00000` : 'UHI-00000'}
              style={{
                flex: 1,
                minHeight: 44,
                padding: '0 12px',
                fontFamily: v('--font-family-mono'),
                fontSize: 15,
                textTransform: 'uppercase',
                borderRadius: 10,
                border: `1px solid ${v('--color-border')}`,
                background: '#fff',
              }}
            />
            {plan !== null && memberOk && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  insetInlineEnd: 10,
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  display: 'grid',
                  placeItems: 'center',
                  background: v('--color-success-soft'),
                  color: v('--color-success'),
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                ✓
              </span>
            )}
          </span>
        </label>

        {plan !== null && (
          <>
            <Row label="الأصناف المغطّاة (أدوية)" value={formatMinor(breakdown.eligible)} />
            {breakdown.nonEligible > 0 && (
              <Row
                label="غير مغطّى (مستلزمات/عناية)"
                value={formatMinor(breakdown.nonEligible)}
                muted
                coverageNote={`تغطية ${(0).toLocaleString('ar-EG')}٪`}
              />
            )}
            <Row
              label={`يتحمّله التأمين · ${plan.coverPct.toLocaleString('ar-EG')}٪`}
              value={formatMinor(-breakdown.covered)}
              success
            />
            {!hasEligible && (
              <p style={{ fontSize: 12, color: v('--color-text-muted'), margin: 0 }}>
                لا توجد أصناف مغطّاة بالتأمين في هذه السلة.
              </p>
            )}

            {breakdown.patientDue > 0 ? (
              <>
                <div style={{ fontSize: 13, color: v('--color-text-muted'), marginTop: 4 }}>
                  مساهمة المريض نقدًا
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {quickAmounts(breakdown.patientDue).map((q) => {
                    const sel = tendered === q.value;
                    return (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => {
                          setTendered(q.value);
                        }}
                        style={{
                          minHeight: 44,
                          padding: '0 14px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          fontFamily: v('--font-family-mono'),
                          fontSize: 14,
                          background: sel ? v('--color-primary') : '#fff',
                          color: sel ? '#fff' : v('--color-primary'),
                          border: `1px solid ${sel ? v('--color-primary') : v('--color-border')}`,
                        }}
                      >
                        {q.label}
                      </button>
                    );
                  })}
                </div>
                <Row
                  label="الباقي للعميل"
                  value={formatMinor(breakdown.change)}
                  totals
                  positive={breakdown.change > 0}
                  ariaLive
                />
              </>
            ) : (
              <Row
                label="مساهمة المريض"
                value="مغطّى بالكامل — لا توجد مساهمة نقدية"
                totals
                success
              />
            )}
          </>
        )}

        {plan === null && (
          <p style={{ fontSize: 12, color: v('--color-text-muted'), margin: 0 }}>
            اختر جهة التأمين ثم أدخل رقم بطاقة العضوية لاحتساب التغطية.
          </p>
        )}
        {plan !== null && !memberOk && (
          <p style={{ fontSize: 12, color: v('--color-text-muted'), margin: 0 }}>
            أدخل رقم بطاقة التأمين لاعتماد المطالبة.
          </p>
        )}
      </div>

      {/* Confirm — strong disabled treatment when not ready. */}
      <button
        type="button"
        disabled={!ready}
        aria-disabled={ready ? undefined : 'true'}
        onClick={() => {
          // UNWIRED: prove the spike never persists. Logs the computed UI
          // result the real feature WOULD hand off — nothing leaves the page.
          console.info('[spike] confirm (no-op)', {
            methodLabel: methodLabel(breakdown),
            insurer: plan ? { ar: plan.ar, en: plan.en, coverPct: plan.coverPct } : null,
            memberId: memberId.trim(),
            covered: breakdown.covered,
            patientDue: breakdown.patientDue,
            tendered,
            change: breakdown.change,
          });
        }}
        style={{
          width: '100%',
          minHeight: 52,
          borderRadius: 10,
          fontSize: 16,
          fontWeight: 600,
          cursor: ready ? 'pointer' : 'not-allowed',
          color: ready ? '#fff' : '#9aa7b4',
          background: ready ? v('--color-primary') : '#e2e8ef',
          border: `1px solid ${ready ? v('--color-primary') : '#d2dae3'}`,
        }}
      >
        تأكيد البيع وطباعة الإيصال
      </button>
    </section>
  );
}

// ── presentational row ───────────────────────────────────────────────────────
interface RowProps {
  label: string;
  value: string;
  muted?: boolean;
  success?: boolean;
  totals?: boolean;
  positive?: boolean;
  ariaLive?: boolean;
  /**
   * Optional coverage marker rendered as a muted pill before the label.
   * Used on the non-eligible row to make "0% covered → on the patient"
   * explicit — the honest inverse of the plan coverage pills. Deliberately
   * muted grey, NOT a status color (status-containment) and NOT navy (that
   * reads as "selected/covered"); 0% is information, not a positive.
   */
  coverageNote?: string;
}

function rowValueColor({
  success,
  muted,
  positive,
}: Pick<RowProps, 'success' | 'muted' | 'positive'>): string {
  if (success) return v('--color-success');
  if (muted) return v('--color-text-muted');
  return positive ? v('--color-success') : 'inherit';
}

function Row({
  label,
  value,
  muted,
  success,
  totals,
  positive,
  ariaLive,
  coverageNote,
}: RowProps): JSX.Element {
  const valueColor = rowValueColor({ success, muted, positive });
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        paddingTop: totals ? 10 : 0,
        borderTop: totals ? `1px solid ${v('--color-border')}` : 'none',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {coverageNote !== undefined && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: v('--font-family-mono'),
              color: v('--color-text-muted'),
              background: '#eef2f6',
              border: `1px solid ${v('--color-border')}`,
              borderRadius: 999,
              padding: '2px 9px',
              whiteSpace: 'nowrap',
            }}
          >
            {coverageNote}
          </span>
        )}
        <span style={{ fontSize: 13, color: muted ? v('--color-text-muted') : 'inherit' }}>
          {label}
        </span>
      </span>
      <span
        dir={value.startsWith('EGP') || value.startsWith('−EGP') ? 'ltr' : 'rtl'}
        aria-live={ariaLive ? 'polite' : undefined}
        style={{
          fontFamily: v('--font-family-mono'),
          fontSize: 14,
          fontWeight: success || totals ? 700 : 500,
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  );
}
