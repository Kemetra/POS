"""Generate the RT-853 (RT-699 slice D1) manual-discount references at 1024x768 and 1280x800.

Visual DRAFT, pending owner sign-off. Same generator pattern as PK-3 and VD (gen_pk3.py,
gen_vd.py): the frozen, owner-approved g6.css is imported unchanged through d1.css, and each
state is written twice, once per width.

Authority: docs/design/vnext/28-rt699-manual-discount-contract.md (main@146673ba) with its §11
P1 close-out, and the owner decisions on RT-699 (comments 12975 and 13690). The layout follows
the shipped Direction B sale (src/renderer/v5/sale/LiveSaleCart.tsx, LiveCartParts.tsx,
sale-direction-b.css), Checkout (checkout/OrderSummary.tsx, PaymentLedger.tsx) and Completion
(checkout/CompletionPanel.tsx). The approval prompt is the RT-114 ManagerApprovalDialog
pattern, drawn as G2-CloseApproval draws it. Every amount is computed here with the §3.2
integer rule, never typed: percent = floor((gross x P + 50) / 100), round half up, once per
line on the line gross. Product names and prices are sample data only.

Usage: python -I gen_d1.py   (writes into this script's parent folder, D1-Discount/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.dont_write_bytecode = True

MINUS = "−"
CASHIER = "منى عادل"
MANAGER = "سارة عبد الحميد"
MANAGER_2 = "خالد إبراهيم"

# The seven-entry nav contract (specs/003-pos-ui-shell/contracts/shell-routes.ts). A cashier
# sees «نقطة البيع» only (RT-597).
NAV_MANAGER = ["لوحة المتابعة", "نقطة البيع", "المبيعات", "المرتجعات", "سجل المراجعة", "المخزون", "الإعدادات"]
NAV_CASHIER = ["نقطة البيع"]

ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "search": '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    "scan": '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 9v6M11 9v6M14 9v6M17 9v6"/>',
    "pause": '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    "pct": '<path d="M6 18L18 6"/><circle cx="7.5" cy="7.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


# ── Copy ────────────────────────────────────────────────────────────────────
# Shipped strings (verbatim from src/renderer on main@146673ba).
S_CART = "سلة المشتريات"  # LiveSaleCart.tsx
S_COLS = ["#", "الصنف", "الكمية", "سعر الوحدة", "الإجمالي", ""]  # LiveSaleCart.tsx
S_NOTE = "ملاحظة"  # LiveCartParts.tsx
S_DELETE = "حذف"  # LiveCartParts.tsx
S_REMOVE_DISCOUNT = "إزالة الخصم"  # LiveSaleCart.tsx (placeholder remove, D4)
S_MONEY_TITLE = "ملخص العملية"  # LiveSaleCart.tsx
S_SUBTOTAL = "المجموع الفرعي"  # LiveSaleCart.tsx
S_TAX = "الضريبة"  # LiveSaleCart.tsx
S_TAX_VALUE = "قيد الإضافة · لا تُحسب هنا"  # LiveSaleCart.tsx
S_GRAND = "الإجمالي الحالي"  # LiveSaleCart.tsx
S_PAY = "الدفع"  # LiveSaleCart.tsx, CompletionPanel.tsx
S_PARK = "تعليق البيع"  # ParkControls.tsx
S_VOID = "إلغاء البيع"  # LiveCartParts.tsx
S_SCAN_LABEL = "التقاط مسح الباركود"  # LiveProductRail.tsx
S_SCAN_PLACEHOLDER = "امسح الباركود هنا"  # LiveProductRail.tsx
S_SEARCH_PLACEHOLDER = "اسم الصنف أو الباركود"  # LiveProductRail.tsx
S_SCAN_READY = "جاهز للمسح"  # ScanStatus
S_SCAN_PAUSED = "المسح متوقف — نافذة مفتوحة"  # scan-messages.ts SCAN_PAUSED_DIALOG_STATUS
S_APPROVAL_TITLE = "موافقة المدير"  # shift-copy.ts approvalTitle (RT-114 dialog)
S_MANAGER_LEGEND = "المدير"  # shift-copy.ts managerLegend
S_PIN_LABEL = "الرقم السري للمدير"  # shift-copy.ts pinLabel
S_CANCEL = "إلغاء"  # shift-copy.ts cancel
S_ORDER = "ملخص الطلب"  # OrderSummary.tsx
S_ORDER_SUBTOTAL = "الإجمالي الفرعي"  # OrderSummary.tsx
S_SHOW_ITEMS = "عرض الأصناف"  # OrderSummary.tsx
S_TENDER = "طريقة الدفع"  # TenderPicker.tsx
S_DUE = "المبلغ المستحق"  # PaymentLedger.tsx
S_BACK = "رجوع إلى البيع"  # PaymentSurface.tsx
S_NEW_SALE = "بيع جديد"  # CompletionPanel.tsx
S_RECEIPT_PENDING = "لم يصدر إيصال بعد."  # CompletionPanel.tsx RECEIPT_COPY.pending

# Owner-decided strings (RT-699 comment 12975; doc 28 §5 and §11.2).
S_DISCOUNT = "خصم"
S_DISCOUNT_TOTAL = "إجمالي الخصم"
REASONS = [
    ("promotion", "عرض ترويجي"),
    ("loyal_or_contract_customer", "عميل دائم / تعاقد"),
    ("near_expiry_or_damaged", "قرب انتهاء / عبوة تالفة"),
    ("price_correction", "تصحيح سعر"),
]
REASON_LABEL = dict(REASONS)

# New strings, proposed here for owner approval (listed in D1-Spec.html, copy table).
N_SHEET_TITLE = "خصم على الصنف"
N_SHEET_NEEDS_APPROVAL = "يحتاج الخصم موافقة مدير قبل تطبيقه."
N_KIND = "نوع الخصم"
N_KIND_PCT = "نسبة مئوية"
N_KIND_AMT = "مبلغ ثابت"
N_VALUE = "قيمة الخصم"
N_HELP_PCT = "رقم صحيح من 1 إلى 100."
N_HELP_AMT = "حتى إجمالي الصنف: {gross}."
N_REASON = "سبب الخصم"
N_REQUIRED = "(مطلوب)"
N_PICK_REASON = "اختر سبب الخصم للمتابعة."
N_PREVIEW_GROSS = "إجمالي الصنف"
N_PREVIEW_DISCOUNT = "الخصم"
N_PREVIEW_NET = "الصافي بعد الخصم"
N_PREVIEW_NOTE = "معاينة. يُحسب المبلغ النهائي عند التطبيق."
N_REQUEST_APPROVAL = "طلب موافقة المدير"
N_APPLY = "تطبيق الخصم"
N_OVER_GROSS = "المبلغ أكبر من إجمالي الصنف."
N_APPROVAL_BODY = "لا يُطبَّق هذا الخصم إلا بموافقة مدير مسجَّل على هذا الجهاز، برقمه السري."
N_APPROVE_ITEM = "الصنف"
N_APPROVE_DISCOUNT = "الخصم"
N_APPROVE_REASON = "السبب"
N_APPROVE_COMMIT = "اعتماد الخصم"
N_APPROVAL_INVALID = "انتهت الموافقة أو لا تخص هذا الخصم. اطلب الموافقة مرة أخرى."
N_APPROVAL_STALE = "تغيّر الصنف منذ طلب الموافقة. راجع الخصم ثم اطلب الموافقة من جديد."
N_BACK_TO_SHEET = "رجوع إلى الخصم"
N_APPROVED_BY = "بموافقة: {name}"
N_LINE_DISCOUNTED = "لا يمكن تغيير كمية صنف عليه خصم. أزل الخصم أولًا ثم غيّر الكمية."
N_LINE_DISCOUNTED_HINT = "أزل الخصم لتغيير الكمية."
N_ALREADY_APPLIED = "على هذا الصنف خصم بالفعل. أزل الخصم الحالي قبل إضافة خصم آخر."
N_ZERO_DUE = "لا يوجد مبلغ مستحق: الخصم يغطي إجمالي البيع، فلا حاجة لطريقة دفع."
N_COMPLETE = "إتمام البيع"
N_ZERO_PROOF = "لا يوجد مبلغ مستحق"


# ── Money (integer minor units; doc 28 §3.2) ─────────────────────────────────
def fmt(minor: int) -> str:
    sign = MINUS if minor < 0 else ""
    m = abs(minor)
    return f"{sign}{m // 100:,}.{m % 100:02d}"


def parse_minor(raw: str) -> int:
    """A typed amount such as "5.00" to minor units, integer arithmetic only (no float for money)."""
    whole, _, frac = raw.partition(".")
    assert len(frac) <= 2 and (whole + frac).isdigit()
    return int(whole or "0") * 100 + int(frac.ljust(2, "0"))


def money(minor: int, cls: str = "money") -> str:
    return f'<span class="{cls}">{fmt(minor)} EGP</span>'


@dataclass(frozen=True)
class Discount:
    kind: str  # "pct" | "amt"
    value: int  # percent 1..100, or minor units 1..gross
    reason: str
    approver: str

    def amount(self, gross: int) -> int:
        if self.kind == "pct":
            assert 1 <= self.value <= 100
            amount = (gross * self.value + 50) // 100  # round half up, once per line
        else:
            assert 1 <= self.value <= gross
            amount = self.value
        assert 0 <= gross - amount <= gross and all(map(lambda v: v < 2**53, (gross * 100, amount)))
        return amount

    def label(self) -> str:
        # OD-28-11: «خصم 10%» for a percent; «خصم» alone for an amount.
        return f'{S_DISCOUNT} <bdi dir="ltr">{self.value}%</bdi>' if self.kind == "pct" else S_DISCOUNT


@dataclass(frozen=True)
class Line:
    name_ar: str
    name_en: str
    qty: int
    unit_minor: int
    receipt_en: str

    @property
    def gross(self) -> int:
        return self.qty * self.unit_minor


PANADOL = Line("بنادول إكسترا 500 مجم — 24 قرص", "Panadol Extra 500mg", 2, 4500, "Panadol Extra 500mg box 24 tab")
AUGMENTIN = Line("أموكسيسيلين/كلافولانيت 875/125 مجم", "Amoxicillin/Clavulanate", 1, 18750, "Augmentin 1g box 14 tab")
VOLTAREN = Line("فولتارين جل 1% — 50 جم", "Voltaren Emulgel 1%", 1, 6800, "Voltaren Emulgel 1% 50g")
CONGESTAL = Line("كونجستال أقراص", "Congestal Tablets", 1, 2950, "Congestal tab box 20")
LINES = [PANADOL, AUGMENTIN, VOLTAREN, CONGESTAL]

# The §5 example: 2 x 45.00 at 10% gives -9.00.
D_PCT = Discount("pct", 10, "promotion", MANAGER)
D_AMT = Discount("amt", 500, "near_expiry_or_damaged", MANAGER)
assert D_PCT.amount(PANADOL.gross) == 900
# A half-up case for the spec page: 29.50 at 15% = 4.425, rounds up to 4.43.
assert Discount("pct", 15, "promotion", MANAGER).amount(CONGESTAL.gross) == 443

# Zero total (OZ-1 = Z-A): a 100% line and an amount equal to the line gross.
ZERO_LINES = [CONGESTAL, VOLTAREN]
ZERO_DISCOUNTS = {
    0: Discount("pct", 100, "promotion", MANAGER),
    1: Discount("amt", VOLTAREN.gross, "near_expiry_or_damaged", MANAGER),
}


@dataclass
class Cart:
    lines: list[Line]
    discounts: dict[int, Discount] = field(default_factory=dict)
    selected: int | None = None

    def gross(self) -> int:
        return sum(line.gross for line in self.lines)

    def discount_total(self) -> int:
        return sum(d.amount(self.lines[i].gross) for i, d in self.discounts.items())

    def net(self) -> int:
        return self.gross() - self.discount_total()

    def units(self) -> int:
        return sum(line.qty for line in self.lines)


# ── Frame pieces ───────────────────────────────────────────────────────────
def nav(role: str, current: str, inert: bool) -> str:
    entries = NAV_MANAGER if role == "manager" else NAV_CASHIER
    links = "".join(
        f'<li><a href="#"{" aria-current=\"page\"" if e == current else ""}>{e}</a></li>' for e in entries
    )
    name, role_ar = (MANAGER, "مدير") if role == "manager" else (CASHIER, "كاشير")
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{" inert" if inert else ""}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{name}</b><span>{role_ar}</span><button type="button">تسجيل الخروج</button></div></nav>'
    )


def command(paused: bool) -> str:
    status = S_SCAN_PAUSED if paused else S_SCAN_READY
    glyph = icon("pause") if paused else icon("scan")
    return (
        '<section class="command" aria-label="إضافة صنف"><div class="command-fields">'
        f'<div class="cmd-field scan">{icon("scan")}<span>{S_SCAN_PLACEHOLDER}</span>'
        f'<span class="vh">{S_SCAN_LABEL}</span></div>'
        f'<div class="cmd-field">{icon("search")}<span>{S_SEARCH_PLACEHOLDER}</span></div></div>'
        f'<p class="command-status">{glyph}<b>{status}</b></p></section>'
    )


def stepper(line: Line, disabled: bool) -> str:
    dis = " disabled" if disabled else ""
    return (
        f'<div class="stepper" aria-label="الكمية {line.qty}">'
        f'<button type="button" aria-label="إنقاص كمية {line.name_ar}"{dis}>{MINUS}</button>'
        f'<span class="num">{line.qty}</span>'
        f'<button type="button" aria-label="زيادة كمية {line.name_ar}"{dis}>+</button></div>'
    )


def discount_row(line: Line, d: Discount, qty_hint: bool) -> str:
    hint = f'<span class="disc-note">{N_LINE_DISCOUNTED_HINT}</span>' if qty_hint else ""
    return (
        '<div class="disc">'
        f'<span class="what"><b>{d.label()}</b><span class="reason">{REASON_LABEL[d.reason]}</span>'
        f'<span class="by">{N_APPROVED_BY.format(name=d.approver)}</span></span>'
        f'<span class="total">{money(-d.amount(line.gross))}</span>'
        f'<span class="row-acts"><button type="button">{S_REMOVE_DISCOUNT}</button></span>{hint}</div>'
    )


def cart_lines(cart: Cart, qty_disabled: bool) -> str:
    items = []
    for i, line in enumerate(cart.lines):
        d = cart.discounts.get(i)
        cls = ' class="selected" aria-current="true"' if cart.selected == i else ""
        row = (
            f'<div class="line"><span class="idx num">{i + 1}</span>'
            f'<span class="nm">{line.name_ar}<span class="en ltr">{line.name_en}</span></span>'
            f"{stepper(line, qty_disabled and d is not None)}"
            f'<span class="unit">{money(line.unit_minor, "num")}</span>'
            f'<span class="total">{money(line.gross)}</span>'
            f'<span class="row-acts"><button type="button">{S_NOTE}</button>'
            f'<button type="button" class="rm">{S_DELETE}</button></span></div>'
        )
        if d is not None:
            row += discount_row(line, d, qty_disabled)
        items.append(f"<li{cls}>{row}</li>")
    return f'<ol class="lines" aria-label="أصناف السلة">{"".join(items)}</ol>'


def cart_section(cart: Cart, discount_enabled: bool, qty_disabled: bool) -> str:
    cols = "".join(f"<span>{c}</span>" for c in S_COLS)
    dis = "" if discount_enabled else " disabled"
    count = f"الأصناف: {len(cart.lines)} · الوحدات: {cart.units()}"
    return (
        f'<section class="cart" aria-labelledby="cart-h"><div class="cart-head"><h2 id="cart-h">{S_CART}</h2>'
        f'<span class="count">{count}</span><span class="grow"></span>'
        f'<button type="button" class="btn"{dis}>{icon("pct")}{S_DISCOUNT}</button></div>'
        f'<div class="cols" aria-hidden="true">{cols}</div>{cart_lines(cart, qty_disabled)}</section>'
    )


def money_column(cart: Cart, notice: str | None) -> str:
    rows = f"<div><dt>{S_SUBTOTAL}</dt><dd>{money(cart.gross())}</dd></div>"
    if cart.discounts:
        rows += f'<div class="disc-total"><dt>{S_DISCOUNT_TOTAL}</dt><dd>{money(-cart.discount_total())}</dd></div>'
    rows += f'<div class="tax"><dt>{S_TAX}</dt><dd>{S_TAX_VALUE}</dd></div>'
    alert = (
        f'<div class="notice notice-danger notice-inline" role="alert">{icon("warn")}<p>{notice}</p></div>'
        if notice
        else ""
    )
    return (
        f'<section class="money-col" aria-labelledby="money-h"><h2 id="money-h">{S_MONEY_TITLE}</h2>'
        f'<dl class="counts"><div><dt>الأصناف</dt><dd class="num">{len(cart.lines)}</dd></div>'
        f'<div><dt>الوحدات</dt><dd class="num">{cart.units()}</dd></div></dl>'
        f'<div class="commit"><dl class="totals" aria-label="ملخص المبالغ">{rows}</dl>'
        f'<div class="grand"><span>{S_GRAND}</span>{money(cart.net())}</div>{alert}'
        f'<button type="button" class="btn btn-primary btn-commit">{S_PAY}</button></div>'
        f'<div class="secondary"><button type="button" class="btn">{S_PARK}</button>'
        f'<button type="button" class="btn btn-void">{S_VOID}</button></div></section>'
    )


@dataclass(frozen=True)
class CartUi:
    """What the sale screen shows around the cart: the «خصم» action, the steppers, a refusal."""

    discount_enabled: bool = True
    qty_disabled: bool = False
    notice: str | None = None


def sale_screen(cart: Cart, inert: bool, ui: CartUi) -> str:
    return (
        f'<main class="screen sale"{" inert" if inert else ""}><h1 class="vh">نقطة البيع</h1>'
        f"{command(inert)}{cart_section(cart, ui.discount_enabled, ui.qty_disabled)}"
        f"{money_column(cart, ui.notice)}</main>"
    )


# ── «خصم» sheet ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Sheet:
    line: Line
    kind: str
    raw_value: str  # what the cashier typed
    reason: str | None
    role: str
    over: bool = False


def sheet_dialog(s: Sheet) -> str:
    gross = s.line.gross
    if s.over:
        amount = None
    elif s.kind == "pct":
        amount = Discount("pct", int(s.raw_value), "promotion", "").amount(gross)
    else:
        amount = Discount("amt", parse_minor(s.raw_value), "promotion", "").amount(gross)

    def kind_choice(key: str, label: str) -> str:
        on = s.kind == key
        return (
            f'<label class="choice{" checked" if on else ""}"><input type="radio" name="kind"'
            f'{" checked" if on else ""}>{label}</label>'
        )

    def reason_choice(code: str, label: str) -> str:
        on = s.reason == code
        return (
            f'<label class="choice{" checked" if on else ""}"><input type="radio" name="reason"'
            f'{" checked" if on else ""}>{label}</label>'
        )

    unit = "%" if s.kind == "pct" else "EGP"
    help_text = N_HELP_PCT if s.kind == "pct" else N_HELP_AMT.format(gross=f"{fmt(gross)} EGP")
    invalid = ' aria-invalid="true" aria-describedby="dv-err"' if s.over else ' aria-describedby="dv-help"'
    err = f'<span class="err" id="dv-err">{N_OVER_GROSS}</span>' if s.over else ""
    dash = '<span class="money">—</span>'
    preview = (
        '<dl class="preview" aria-label="معاينة الخصم">'
        f"<div><dt>{N_PREVIEW_GROSS}</dt><dd>{money(gross)}</dd></div>"
        f"<div><dt>{N_PREVIEW_DISCOUNT}</dt><dd>{dash if amount is None else money(-amount)}</dd></div>"
        f'<div class="net"><dt>{N_PREVIEW_NET}</dt><dd>{dash if amount is None else money(gross - amount)}</dd></div></dl>'
        f'<p class="preview-cap">{N_PREVIEW_NOTE}</p>'
    )
    ready = s.reason is not None and amount is not None
    primary = N_REQUEST_APPROVAL if s.role == "cashier" else N_APPLY
    needs = f'<p class="hint">{N_SHEET_NEEDS_APPROVAL}</p>' if s.role == "cashier" else ""
    slot = f'<p class="hint">{N_PICK_REASON}</p>' if s.reason is None else ""
    line_meta = f'<span class="num">{s.line.qty} × {fmt(s.line.unit_minor)} EGP</span>'
    return (
        '<div class="scrim"><div class="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="ds-h">'
        f'<div class="sheet-head"><h2 id="ds-h">{N_SHEET_TITLE}</h2>'
        f'<p class="sheet-line"><b>{s.line.name_ar}</b>{line_meta}</p>{needs}</div>'
        '<form class="fields" novalidate><div class="sheet-body"><div class="fields">'
        f'<fieldset class="choices kind"><legend>{N_KIND}</legend>{kind_choice("pct", N_KIND_PCT)}'
        f'{kind_choice("amt", N_KIND_AMT)}</fieldset>'
        f'<div class="field"><label for="dv">{N_VALUE}</label><div class="value-row">'
        f'<input id="dv" class="input" inputmode="{"numeric" if s.kind == "pct" else "decimal"}" autocomplete="off"'
        f' value="{s.raw_value}"{invalid}><span class="unit-tag" aria-hidden="true">{unit}</span></div>'
        f'<span class="help" id="dv-help">{help_text}</span>{err}</div>{preview}</div>'
        f'<fieldset class="choices reasons"><legend>{N_REASON} <span class="req">{N_REQUIRED}</span></legend>'
        f'{"".join(reason_choice(c, l) for c, l in REASONS)}</fieldset></div>'
        f'<div class="slot" role="status" aria-live="polite">{slot}</div>'
        f'<div class="dialog-actions"><button type="button" class="btn">{S_CANCEL}</button>'
        f'<button type="submit" class="btn btn-primary{" focus" if ready else ""}"{"" if ready else " disabled"}>'
        f"{primary}</button></div></form></div></div>"
    )


# ── RT-114 approval prompt (ManagerApprovalDialog pattern) ─────────────────
def approval_dialog(line: Line, d: Discount, refusal: str | None, stale: bool) -> str:
    amount = d.amount(line.gross)
    summary = (
        '<dl class="approve-what">'
        f"<div><dt>{N_APPROVE_ITEM}</dt><dd>{line.name_ar}</dd></div>"
        f'<div><dt>{N_APPROVE_DISCOUNT}</dt><dd>{d.label()} · {money(-amount)}</dd></div>'
        f"<div><dt>{N_APPROVE_REASON}</dt><dd>{REASON_LABEL[d.reason]}</dd></div></dl>"
    )
    pin_value = "" if refusal else ' value="2468"'
    slot = (
        f'<div class="notice notice-danger" role="alert">{icon("warn")}<p>{refusal}</p></div>' if refusal else ""
    )
    if stale:
        actions = (
            f'<button type="button" class="btn">{S_CANCEL}</button>'
            f'<button type="button" class="btn btn-primary focus">{N_BACK_TO_SHEET}</button>'
        )
    else:
        ready = refusal is None
        actions = (
            f'<button type="button" class="btn">{S_CANCEL}</button>'
            f'<button type="submit" class="btn btn-primary{" focus" if ready else ""}"{"" if ready else " disabled"}>'
            f"{N_APPROVE_COMMIT}</button>"
        )
    return (
        '<div class="scrim"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ap-h">'
        f'<h2 id="ap-h">{S_APPROVAL_TITLE}</h2><p class="hint">{N_APPROVAL_BODY}</p>{summary}'
        '<form class="fields" novalidate>'
        f'<fieldset class="choices"><legend>{S_MANAGER_LEGEND}</legend>'
        f'<label class="choice checked"><input type="radio" name="approver" checked>{MANAGER}</label>'
        f'<label class="choice"><input type="radio" name="approver">{MANAGER_2}</label></fieldset>'
        f'<div class="field"><label for="ap-pin">{S_PIN_LABEL}</label>'
        f'<input id="ap-pin" class="input pin{" focus" if refusal and not stale else ""}" type="password"'
        f' inputmode="numeric" maxlength="8" autocomplete="off"{pin_value}></div>'
        f'<div class="slot" role="status" aria-live="polite">{slot}</div>'
        f'<div class="dialog-actions">{actions}</div></form></div></div>'
    )


# ── Zero-total Checkout and Completion (OZ-1 = Z-A) ────────────────────────
def zero_cart() -> Cart:
    return Cart(list(ZERO_LINES), dict(ZERO_DISCOUNTS))


def order_summary(cart: Cart, w: int) -> str:
    sums = (
        f'<dl class="sums"><div><dt>{S_ORDER_SUBTOTAL}</dt><dd>{money(cart.gross())}</dd></div>'
        f'<div><dt>{S_DISCOUNT_TOTAL}</dt><dd>{money(-cart.discount_total())}</dd></div></dl>'
    )
    meta = f'<span class="meta">الأصناف <span class="num">{len(cart.lines)}</span> · القطع <span class="num">{cart.units()}</span></span>'
    if w == 1024:
        return (
            f'<section class="order" aria-labelledby="ord-h"><h2 id="ord-h">{S_ORDER}</h2>{meta}{sums}'
            f'<button type="button" class="btn">{S_SHOW_ITEMS}</button></section>'
        )
    items = []
    for i, line in enumerate(cart.lines):
        d = cart.discounts[i]
        items.append(
            f'<li><span>{line.name_ar} <span class="num">×{line.qty}</span></span>{money(line.gross)}'
            f'<span class="d"><span>{d.label()}</span>{money(-d.amount(line.gross))}</span></li>'
        )
    return (
        f'<section class="order" aria-labelledby="ord-h"><h2 id="ord-h">{S_ORDER}</h2>{meta}'
        f'<ol aria-label="أصناف السلة">{"".join(items)}</ol>{sums}</section>'
    )


def checkout_screen(w: int) -> str:
    cart = zero_cart()
    assert cart.net() == 0
    return (
        f'<main class="screen flow"><div class="titlebar"><h1>{S_PAY}</h1>'
        f'<button type="button" class="btn">{S_BACK}</button></div><div class="checkout">'
        f"{order_summary(cart, w)}"
        f'<section class="tender-panel" aria-labelledby="tp-h"><h2 id="tp-h">{S_TENDER}</h2>'
        f'<div class="notice notice-neutral">{icon("info")}<p>{N_ZERO_DUE}</p></div></section>'
        f'<section class="ledger" aria-label="{S_DUE}"><div class="due"><span>{S_DUE}</span>{money(cart.net())}</div>'
        f'<div class="actions-col"><button type="button" class="btn btn-primary btn-commit focus">{N_COMPLETE}</button></div>'
        "</section></div></main>"
    )


def completion_screen() -> str:
    cart = zero_cart()
    return (
        f'<main class="screen flow"><div class="titlebar"><h1>{S_PAY}</h1></div><div class="completion">'
        f'<div role="status" aria-live="polite"><ul class="proofs" aria-label="حالة البيع">'
        f'<li class="proof ok hero"><span class="glyph">{icon("ok")}</span><span>{N_ZERO_PROOF}</span>{money(cart.net())}</li>'
        f'<li class="proof info"><span class="glyph">{icon("info")}</span><span>{S_RECEIPT_PENDING}</span><span></span></li></ul></div>'
        f'<button type="button" class="btn btn-primary btn-commit focus">{S_NEW_SALE}</button></div></main>'
    )


# ── Receipt preview (screen only; G6P-B dialog, engine slip bands) ─────────
RULE_EQ = "=" * 42
RULE_DASH = "-" * 42


def band(text: str, d: str = "ltr", align: str = "left", extra: str = "") -> str:
    return f'<div class="band{extra}" dir="{d}" style="text-align: {align}">{text}</div>'


def disc_band(label: str, amount: int, indent: str = "   ") -> str:
    # OD-28-11: one indented row under the item: «خصم 10%  −9.00» (no currency on the row).
    return band(f"{indent}{label}  <bdi dir=\"ltr\">{fmt(-amount)}</bdi>", "rtl", "right", " disc-row")


def receipt(cart: Cart, sale_no: str, tender: tuple[int, int] | None) -> str:
    out = [f'<div class="rule">{RULE_EQ}</div>', band("صيدلية الشفاء", "rtl", "right"),
           band("الفرع الرئيسي — شارع التحرير", "rtl", "right"), band("Tax ID: 100123456789012"),
           f'<div class="rule">{RULE_DASH}</div>', band(f"Sale # {sale_no}", extra=" receipt-emph"),
           band(f"Receipt # {sale_no}"), band("Terminal: POS-03"), band(f"Cashier: {CASHIER}", "rtl", "right"),
           band("2026-10-24 11:18"), f'<div class="rule">{RULE_EQ}</div>', band("العناصر", "rtl", "right"),
           f'<div class="rule">{RULE_DASH}</div>']
    for i, line in enumerate(cart.lines):
        out.append(band(f"{line.qty}× {line.receipt_en}", "rtl", "right"))
        out.append(band(f"{fmt(line.gross)} EGP"))
        d = cart.discounts.get(i)
        if d is not None:
            out.append(disc_band(d.label(), d.amount(line.gross)))
    out.append(f'<div class="rule">{RULE_DASH}</div>')
    if cart.discounts:
        out.append(disc_band(S_DISCOUNT_TOTAL, cart.discount_total(), indent=""))
    out.append(band(f"Subtotal: {fmt(cart.net())} EGP"))
    if tender is not None:
        paid, change = tender
        out += [f'<div class="rule">{RULE_EQ}</div>', band("طريقة الدفع", "rtl", "right"),
                f'<div class="rule">{RULE_DASH}</div>', band(f"نقدًا — Cash   {fmt(paid)} EGP"),
                band(f"Change due — الباقي   {fmt(change)} EGP")]
    out += [f'<div class="rule">{RULE_EQ}</div>', band("ضريبة القيمة المضافة", "rtl", "right"),
            f'<div class="rule">{RULE_DASH}</div>', band("Tax ID: 100123456789012"), band("VAT: 0.00 EGP"),
            band(f"Subtotal (ex. VAT): {fmt(cart.net())} EGP"), band(f"Total inc. VAT: {fmt(cart.net())} EGP"),
            f'<div class="rule">{RULE_EQ}</div>', band("شكرًا لتعاملكم معنا — Thank you", align="center"),
            f'<div class="rule">{RULE_EQ}</div>']
    return '<div class="receipt" dir="rtl">\n' + "\n".join(out) + "\n</div>"


def receipt_screen(cart: Cart, sale_no: str, tender: tuple[int, int] | None) -> str:
    main = (
        '<main class="screen" inert><div class="screen-head"><h1>المبيعات</h1></div>'
        '<section class="panel hug" aria-labelledby="find-h"><div class="panel-head"><h2 id="find-h">البحث عن بيع</h2></div>'
        '<div class="panel-body"><form class="lookup" novalidate><div class="field"><label for="find-no">رقم البيع</label>'
        f'<input id="find-no" class="input code" type="text" autocomplete="off" value="{sale_no}"></div>'
        '<button type="submit" class="btn btn-primary">بحث</button></form><div class="result">'
        f'<p class="ref"><bdi class="ltr">{sale_no}</bdi></p><p class="meta"><bdi>{CASHIER}</bdi> · <bdi class="ltr">POS-03</bdi></p>'
        '<div class="buttons"><button type="button" class="btn">معاينة الإيصال</button>'
        '<button type="button" class="btn">إعادة طباعة الإيصال</button></div></div></div></section></main>'
    )
    dialog = (
        '<div class="scrim"><div class="dialog preview" role="dialog" aria-modal="true" aria-labelledby="rp-h" aria-describedby="rp-no">'
        f'<div class="preview-head"><h2 id="rp-h">معاينة الإيصال</h2><p id="rp-no" class="hint"><bdi class="ltr">{sale_no}</bdi></p></div>'
        f'<div class="well" role="region" aria-label="الإيصال" tabindex="0"><div class="slip">{receipt(cart, sale_no, tender)}</div></div>'
        '<p class="hint">تُطبع نسخة عليها «نسخة طبق الأصل».</p><div class="slot" role="status" aria-live="polite"></div>'
        '<div class="dialog-actions"><button type="button" class="btn">إعادة طباعة الإيصال</button>'
        '<button type="button" class="btn btn-primary focus">إغلاق</button></div></div></div>'
    )
    return main + nav("manager", "المبيعات", True) + dialog


# ── States ─────────────────────────────────────────────────────────────────
def base_cart(selected: int | None = 0) -> Cart:
    return Cart(list(LINES), {}, selected)


def discounted_cart(selected: int | None = 0) -> Cart:
    return Cart(list(LINES), {0: D_PCT}, selected)


def manager_cart() -> Cart:
    return Cart(list(LINES), {0: D_PCT, 2: D_AMT}, 2)


def frame_sale(role: str, cart: Cart, dialog: str = "", **ui: object) -> str:
    inert = bool(dialog)
    return sale_screen(cart, inert, CartUi(**ui)) + nav(role, "نقطة البيع", inert) + dialog


SHEET_PCT = Sheet(PANADOL, "pct", "10", "promotion", "cashier")
STATES: list[tuple[str, str, object]] = [
    ("Selected", "الكاشير: صنف محدد وزر «خصم» في رأس السلة",
     lambda w: frame_sale("cashier", base_cart())),
    ("SheetPercent", "نافذة «خصم»: نسبة 10% وسبب ومعاينة الصافي (الكاشير)",
     lambda w: frame_sale("cashier", base_cart(), sheet_dialog(SHEET_PCT))),
    ("SheetNoReason", "نافذة «خصم» بلا سبب: الزر معطّل",
     lambda w: frame_sale("cashier", base_cart(), sheet_dialog(Sheet(PANADOL, "pct", "10", None, "cashier")))),
    ("SheetOverGross", "رفض: مبلغ أكبر من إجمالي الصنف",
     lambda w: frame_sale("cashier", base_cart(), sheet_dialog(Sheet(PANADOL, "amt", "120.00", "price_correction", "cashier", over=True)))),
    ("Approval", "مسار الكاشير: موافقة المدير (نمط RT-114)",
     lambda w: frame_sale("cashier", base_cart(), approval_dialog(PANADOL, D_PCT, None, False))),
    ("ApprovalInvalid", "رفض: الموافقة غير صالحة",
     lambda w: frame_sale("cashier", base_cart(), approval_dialog(PANADOL, D_PCT, N_APPROVAL_INVALID, False))),
    ("ApprovalStale", "رفض: الموافقة قديمة (تغيّر الصنف)",
     lambda w: frame_sale("cashier", base_cart(), approval_dialog(PANADOL, D_PCT, N_APPROVAL_STALE, True))),
    ("Discounted", "السلة: سطر الخصم تحت الصنف وزر «إزالة الخصم»",
     lambda w: frame_sale("cashier", discounted_cart(), discount_enabled=False)),
    ("SheetManager", "مسار المدير: مبلغ ثابت ويُطبَّق مباشرة بلا نافذة موافقة",
     lambda w: frame_sale("manager", discounted_cart(2), sheet_dialog(Sheet(VOLTAREN, "amt", "5.00", "near_expiry_or_damaged", "manager")))),
    ("ManagerApplied", "مسار المدير: خصمان في السلة",
     lambda w: frame_sale("manager", manager_cart(), discount_enabled=False)),
    ("QtyRefused", "رفض: تغيير كمية صنف عليه خصم (بعد الضغط)",
     lambda w: frame_sale("cashier", discounted_cart(), discount_enabled=False, notice=N_LINE_DISCOUNTED)),
    ("QtyDisabled", "بديل: أزرار الكمية معطّلة على الصنف المخصوم مع السبب",
     lambda w: frame_sale("cashier", discounted_cart(), discount_enabled=False, qty_disabled=True)),
    ("SecondRefused", "رفض: خصم ثانٍ على الصنف نفسه",
     lambda w: frame_sale("cashier", discounted_cart(), notice=N_ALREADY_APPLIED)),
    ("ZeroCheckout", "إجمالي صفر: الدفع بلا طرق دفع وإجراء إتمام واحد (OZ-1 = Z-A)",
     lambda w: checkout_screen(w) + nav("cashier", "نقطة البيع", False)),
    ("ZeroCompletion", "إجمالي صفر: شاشة الإتمام",
     lambda w: completion_screen() + nav("cashier", "نقطة البيع", False)),
    ("Receipt", "معاينة الإيصال: سطر الخصم تحت كل صنف و«إجمالي الخصم»",
     lambda w: receipt_screen(manager_cart(), "TERM-01-2026-10-24-000057", (40000, 40000 - manager_cart().net()))),
    ("ReceiptZero", "معاينة الإيصال: إجمالي صفر بلا سطر دفع",
     lambda w: receipt_screen(zero_cart(), "TERM-01-2026-10-24-000058", None)),
]

STYLESHEETS = {
    "Receipt": ["d1.css", "../G6P-Receipt-Preview/g6p.css"],
    "ReceiptZero": ["d1.css", "../G6P-Receipt-Preview/g6p.css"],
}


def page(key: str, title: str, body: str, w: int) -> str:
    h = 768 if w == 1024 else 800
    links = "".join(f'<link rel="stylesheet" href="{s}">\n' for s in STYLESHEETS.get(key, ["d1.css"]))
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>DRAFT · RT-853 D1 · {title} · {w}×{h}</title>\n{links}</head>\n<body>\n"
        f'<div class="rt w{w}" data-ref="D1-{key}" data-w="{w}">\n{body}\n</div>\n</body>\n</html>\n'
    )


def main() -> None:
    out = Path(__file__).resolve().parent.parent
    for key, title, build in STATES:
        for w in (1024, 1280):
            (out / f"D1-{key}-{w}.html").write_text(page(key, title, build(w), w), encoding="utf-8", newline="\n")
    print(f"[OK] {len(STATES) * 2} frames written to {out}")


if __name__ == "__main__":
    main()
