"""Generate the RT-660 G-6 Returns content references (visual DRAFT, pending owner approval).

The G-6 pack (RT-478, G6-Manager/) drew Returns as a frame stand-in only. This pack draws the
Returns *content* on the shared G-6 controls: the frozen g6.css is imported unchanged, and
g6r.css adds only what Returns needs (stepper, table, total, state pill, payout region).

Behaviour authority: RT-15 as shipped on main (src/renderer/returns/*). Every product string is
copied verbatim from returns-messages.ts or the Returns components; nothing here adds a state,
a call or a capability. Sample data (names, numbers, times) is illustrative only.

Usage: python -I gen_g6r.py   (writes into this script's parent folder, G6-Returns/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

MANAGER = "سارة عبد الحميد"
SALE_NO = "TERM-01-2026-10-15-000042"
RETURN_REF = "RET-000318"

# The seven-entry nav contract (specs/003-pos-ui-shell/contracts/shell-routes.ts), in order.
NAV = [
    ("dashboard", "لوحة المتابعة"),
    ("cart", "نقطة البيع"),
    ("sales", "المبيعات"),
    ("returns", "المرتجعات"),
    ("audit", "سجل المراجعة"),
    ("inventory", "المخزون"),
    ("settings", "الإعدادات"),
]

ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "stop": '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "help": '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5"/><path d="M12 17v.01"/>',
    "cash": '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def money(minor: int) -> str:
    # formatHumanMoney: grouped thousands, two decimals, EGP after (UX-12).
    major, cents = divmod(minor, 100)
    return f"{major:,}.{cents:02d} EGP"


def num(text: str, cls: str = "num") -> str:
    return f'<bdi class="{cls}">{text}</bdi>'


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-660 G-6 Returns · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g6r.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def aria_current(key: str) -> str:
    return ' aria-current="page"' if key == "returns" else ""


def nav() -> str:
    links = "".join(f'<li><a href="#"{aria_current(key)}>{label}</a></li>' for key, label in NAV)
    return (
        '<nav class="nav" aria-label="التنقل الرئيسي">'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{MANAGER}</b><span>مدير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def screen(content: str) -> str:
    # ReturnsRoute: ScreenSection «المرتجعات», then the flow step above the journal.
    return f'<main class="screen"><div class="screen-head"><h1>المرتجعات</h1></div>{content}</main>{nav()}'


# Each tone has its own glyph; refusals keep the shipped danger tone (RD-2).
TONE_GLYPH = {"success": "ok", "neutral": "info", "warning": "warn", "danger": "stop"}


def notice(kind: str, lines: list[str], role: str = "alert") -> str:
    text = "".join(f"<p>{line}</p>" for line in lines)
    r = f' role="{role}"' if role else ""
    return f'<div class="notice notice-{kind}"{r}>{icon(TONE_GLYPH[kind])}<div class="notice-text">{text}</div></div>'


def btn(label: str, kind: str = "", attrs: str = "") -> str:
    cls = f"btn {kind}".strip()
    return f'<button type="button" class="{cls}"{attrs}>{label}</button>'


@dataclass(frozen=True)
class Head:
    """A panel's heading: its text, its id, the panel class and anything beside the heading."""

    title: str
    hid: str
    cls: str = "panel hug"
    bar: str = ""


def panel(head: Head, body: str) -> str:
    return (
        f'<section class="{head.cls}" aria-labelledby="{head.hid}">'
        f'<div class="panel-head"><h2 id="{head.hid}" tabindex="-1">{head.title}</h2>{head.bar}</div>{body}</section>'
    )


FOCUSED = "panel hug focus-head"  # a step whose heading takes focus on mount


def actions(*buttons: str) -> str:
    return '<div class="flow-actions">' + "".join(buttons) + "</div>"


# ── step 1: lookup (SaleLookup) ──────────────────────────────────────
def lookup(value: str = "", note: str = "", focus: bool = True) -> str:
    f = " focus" if focus else ""
    form = (
        '<form class="lookup" novalidate>'
        '<div class="field"><label for="ret-no">رقم البيع</label>'
        f'<input id="ret-no" class="input code{f}" type="text" dir="ltr" maxlength="64" autocomplete="off" value="{value}"></div>'
        '<button type="submit" class="btn btn-primary">بحث</button>'
        "</form>"
    )
    return panel(Head("البحث عن بيع", "ret-lookup"), f'<div class="panel-body">{form}{note}</div>')


# ── the journal (ReturnsHistory) ─────────────────────────────────────
STATE = {
    # ReturnState → (label from stateLabel(), pill tone, glyph)
    "pending": ("قيد الإرسال", "pending", "clock"),
    "confirmed": ("مسجَّل على الخادم", "ok", "ok"),
    "paid_out": ("صُرف نقدًا", "ok", "cash"),
    "refused": ("مرفوض", "danger", "stop"),
    "unknown": ("غير مؤكد", "danger", "help"),
}

ACTION = {"pay": "صرف", "complete": "إكمال الصرف", "reprint": "طباعة نسخة"}


@dataclass(frozen=True)
class Row:
    sale: str
    time: str
    iso: str
    state: str
    minor: int
    ref: str = "—"
    action: str = ""
    reason: str = ""


ROWS_SHORT = [
    Row("TERM-01-2026-10-17-000031", "17 أكتوبر 2026، 10:02", "2026-10-17T10:02", "paid_out", 9000, "RET-000317", "reprint"),
    Row("TERM-01-2026-10-16-000118", "16 أكتوبر 2026، 18:47", "2026-10-16T18:47", "paid_out", 6800, "RET-000309", "reprint"),
]

ROWS_ALL = [
    Row("TERM-01-2026-10-17-000044", "17 أكتوبر 2026، 11:58", "2026-10-17T11:58", "unknown", 2950),
    Row("TERM-01-2026-10-17-000040", "17 أكتوبر 2026، 11:20", "2026-10-17T11:20", "confirmed", 18750, "RET-000318", "pay"),
    Row("TERM-01-2026-10-17-000036", "17 أكتوبر 2026، 10:44", "2026-10-17T10:44", "confirmed", 4500, "RET-000316", "complete"),
    Row("TERM-01-2026-10-17-000031", "17 أكتوبر 2026، 10:02", "2026-10-17T10:02", "paid_out", 9000, "RET-000317", "reprint"),
    Row(
        "TERM-01-2026-10-16-000121", "16 أكتوبر 2026، 19:15", "2026-10-16T19:15", "refused", 37500,
        reason="الكمية المطلوبة تتجاوز ما بقي قابلًا للإرجاع على الخادم. لم يُسجَّل المرتجع.",
    ),
]


def state_cell(row: Row) -> str:
    label, tone, glyph = STATE[row.state]
    reason = f'<span class="reason">{row.reason}</span>' if row.reason else ""
    return f'<span class="status status-{tone}">{icon(glyph)}{label}</span>{reason}'


def action_cell(row: Row) -> str:
    if not row.action:
        return ""
    label = ACTION[row.action]
    return btn(label, attrs=f' aria-label="{label} {row.sale}"')


def journal_row(row: Row) -> str:
    return (
        f'<tr data-state="{row.state}">'
        f"<td>{num(row.sale, 'num code')}</td>"
        f'<td><time datetime="{row.iso}">{row.time}</time></td>'
        f'<td class="state">{state_cell(row)}</td>'
        f"<td>{num(money(row.minor))}</td>"
        f"<td>{num(row.ref, 'num code')}</td>"
        f"<td>{action_cell(row)}</td>"
        "</tr>"
    )


def journal_table(rows: list[Row]) -> str:
    heads = ["رقم البيع", "الوقت", "الحالة", "المبلغ", "مرجع الخادم", "إجراء"]
    th = "".join(f'<th scope="col">{h}</th>' for h in heads)
    body = "".join(journal_row(r) for r in rows)
    return (
        '<div class="table-scroll"><table class="tbl journal" aria-labelledby="ret-history">'
        f"<thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>"
    )


@dataclass(frozen=True)
class History:
    rows: list[Row] = field(default_factory=list)
    note: str = ""
    failed: bool = False


def history(h: History) -> str:
    unresolved = any(r.state in ("pending", "unknown") for r in h.rows)
    bar = btn("تحقّق من غير المؤكدة") if unresolved else ""
    if h.failed:
        body = notice("danger", ["تعذّر إكمال الطلب على هذا الجهاز. حاول مرة أخرى."]) + '<div>' + btn("إعادة تحميل السجل") + "</div>"
        inner = f'<div class="panel-body">{body}</div>'
    elif h.rows:
        inner = (f'<div class="panel-body slim">{h.note}</div>' if h.note else "") + journal_table(h.rows)
    else:
        empty = notice("neutral", ["لا توجد مرتجعات مسجَّلة على هذا الجهاز."], role="")
        inner = f'<div class="panel-body">{empty}</div>'
    return panel(Head("سجل المرتجعات على هذا الجهاز", "ret-history", "panel journal-panel", bar), inner)


# ── step 2: line selection (LinePicker) ──────────────────────────────
@dataclass(frozen=True)
class Line:
    name: str
    sold: int
    returned: int
    unit: int
    picked: int = 0

    @property
    def returnable(self) -> int:
        return self.sold - self.returned


LINES = [
    Line("بنادول إكسترا 500 مجم — 24 قرص", 2, 0, 4500),
    Line("أموكسيسيلين/كلافولانيت 875/125 مجم", 1, 0, 18750),
    Line("فولتارين جل 1% — 50 جم", 1, 1, 6800),
    Line("كونجستال أقراص", 3, 0, 2950),
]
PICKED = {0: 1, 1: 1}


def stepper(line: Line, i: int, locked: bool) -> str:
    dec = " disabled" if locked or line.picked <= 0 else ""
    inc = " disabled" if locked or line.picked >= line.returnable else ""
    return (
        '<div class="stepper">'
        f'<button type="button" class="step" aria-label="إنقاص {line.name}"{dec}>−</button>'
        f'<output class="num qty" aria-label="كمية {line.name}">{line.picked}</output>'
        f'<button type="button" class="step" aria-label="زيادة {line.name}"{inc}>+</button>'
        "</div>"
    )


def line_row(line: Line, i: int, locked: bool) -> str:
    meta = (
        f"مباع {num(str(line.sold))} · مُرجع سابقًا {num(str(line.returned))} · "
        f"سعر الوحدة {num(money(line.unit))}"
    )
    if line.returnable > 0:
        control = stepper(line, i, locked)
    else:
        control = f'<span class="status status-none">{icon("ok")}أُرجع بالكامل</span>'
    done = "" if line.returnable > 0 else ' data-returnable="false"'
    return (
        f'<li class="line"{done}><div class="line-text"><span class="name">{line.name}</span>'
        f'<span class="meta">{meta}</span></div>{control}</li>'
    )


def sale_meta() -> str:
    return f'<p class="meta">بيع رقم {num(SALE_NO, "num code")}</p>'


@dataclass(frozen=True)
class Select:
    picked: dict[int, int] = field(default_factory=dict)
    note: str = ""
    locked: bool = False


def select(s: Select) -> str:
    lines = [Line(l.name, l.sold, l.returned, l.unit, s.picked.get(i, 0)) for i, l in enumerate(LINES)]
    rows = "".join(line_row(l, i, s.locked) for i, l in enumerate(lines))
    nothing = not any(l.picked for l in lines)
    quote_attrs = " disabled" if nothing or s.locked else ""
    busy = ' aria-busy="true"' if s.locked else ""
    body = (
        f'<div class="panel-body">{sale_meta()}<ul class="lines">{rows}</ul>{s.note}'
        + actions(
            btn("بحث عن بيع آخر", "btn-ghost", " disabled" if s.locked else ""),
            btn("احسب مبلغ الاسترداد", "btn-primary", quote_attrs + busy),
        )
        + "</div>"
    )
    return panel(Head("اختر الأصناف المرتجعة", "ret-select", FOCUSED), body)


# ── step 3: quote (RefundSummary) ────────────────────────────────────
QUOTE = [(LINES[0].name, 1, 4500), (LINES[1].name, 1, 18750)]
QUOTE_TOTAL = 23250


def total(label: str, minor: int) -> str:
    return f'<div class="total"><span>{label}</span>{num(money(minor), "num amount")}</div>'


def quote() -> str:
    rows = "".join(
        f"<tr><td>{name}</td><td>{num(str(q))}</td><td>{num(money(m))}</td></tr>" for name, q, m in QUOTE
    )
    table = (
        '<table class="tbl quote"><thead><tr><th scope="col">الصنف</th><th scope="col">الكمية</th>'
        f'<th scope="col">المبلغ</th></tr></thead><tbody>{rows}</tbody></table>'
    )
    body = (
        f'<div class="panel-body">{sale_meta()}{table}{total("إجمالي الاسترداد", QUOTE_TOTAL)}'
        '<p class="meta">طريقة الاسترداد: نقدًا فقط.</p>'
        + actions(btn("تعديل الكميات"), btn("تأكيد الإرجاع", "btn-primary"))
        + "</div>"
    )
    return panel(Head("ملخص الاسترداد", "ret-summary", FOCUSED), body)


# ── step 4: outcome (ReturnOutcome) and payout (PayoutPanel) ─────────
def facts(confirmed: bool, ref: bool = True) -> str:
    label = "مبلغ الاسترداد النقدي" if confirmed else "المبلغ المطلوب"
    ref_row = f"<dt>مرجع الخادم</dt><dd>{num(RETURN_REF, 'num code')}</dd>" if ref else ""
    return (
        '<dl class="facts">'
        f"<dt>رقم البيع</dt><dd>{num(SALE_NO, 'num code')}</dd>"
        f"<dt>{label}</dt><dd>{num(money(QUOTE_TOTAL))}</dd>"
        f"{ref_row}</dl>"
    )


@dataclass(frozen=True)
class Payout:
    """One PayoutPanel phase: the region's tone and lines, its buttons, and an optional start time."""

    tone: str
    lines: list[str]
    buttons: list[str]
    started: str = ""


def payout(p: Payout) -> str:
    started = (
        f'<p class="meta">بدأ الصرف: <time datetime="2026-10-17T11:21">{p.started}</time></p>' if p.started else ""
    )
    region = (
        f'<div class="notice notice-{p.tone}" aria-live="polite" aria-atomic="true">'
        f'{icon(TONE_GLYPH[p.tone])}<div class="notice-text">{"".join(f"<p>{l}</p>" for l in p.lines)}</div></div>'
    )
    return (
        '<section class="payout" aria-labelledby="ret-payout">'
        '<h3 id="ret-payout">صرف النقد</h3>'
        f'{total("المبلغ المستحق للعميل", QUOTE_TOTAL)}{started}{region}'
        f'<div class="flow-actions start">{"".join(p.buttons)}</div></section>'
    )


@dataclass(frozen=True)
class Outcome:
    """What main answered for the submit, as ReturnOutcome draws it."""

    tone: str
    lines: list[str]
    confirmed: bool = False
    ref: bool = True
    facts: bool = True
    check_again: bool = False
    payout: Payout | None = None


def outcome(o: Outcome) -> str:
    role = "status" if o.confirmed else "alert"
    announce = notice(o.tone, o.lines, role=role)
    left = announce + (facts(o.confirmed, o.ref) if o.facts else "")
    if o.payout:
        content = f'<div class="outcome-grid"><div class="col">{left}</div>{payout(o.payout)}</div>'
    else:
        content = left
    check = [btn("تحقّق مجددًا", "btn-primary")] if o.check_again else []
    new_kind = "" if o.confirmed or o.check_again else "btn-primary"
    body = f'<div class="panel-body">{content}' + actions(*check, btn("مرتجع جديد", new_kind)) + "</div>"
    return panel(Head("نتيجة المرتجع", "ret-outcome", FOCUSED), body)


CONFIRMED = ["تم تسجيل المرتجع على الخادم."]


def confirmed_with(p: Payout) -> str:
    return outcome(Outcome("success", CONFIRMED, confirmed=True, payout=p))


START = btn("افتح الدرج واصرف النقد", "btn-primary")
REPRINT = btn("طباعة نسخة من الإيصال")
REFRESH = btn("تحديث الحالة")

PAYOUTS = {
    "PayoutReady": Payout("neutral", ["يُفتح الدرج، ثم يُسجَّل الصرف ويُطبع إيصال المرتجع."], [START]),
    "PayoutOpening": Payout(
        "neutral",
        ["يُفتح الدرج، ثم يُسجَّل الصرف ويُطبع إيصال المرتجع.", "جارٍ فتح الدرج…"],
        [btn("افتح الدرج واصرف النقد", "btn-primary", ' disabled aria-busy="true"')],
    ),
    "PayoutPaid": Payout(
        "success", ["سُجّل صرف المبلغ نقدًا.", "الدرج مفتوح: سلّم العميل المبلغ.", "طُبع إيصال المرتجع."], [REPRINT]
    ),
    "PayoutNoDrawer": Payout(
        "success",
        ["سُجّل صرف المبلغ نقدًا.", "لا يوجد درج نقود موصول بهذا الجهاز: سلّم العميل المبلغ.", "طُبع إيصال المرتجع."],
        [REPRINT],
    ),
    "PayoutSlipFailed": Payout(
        "warning",
        ["سُجّل صرف المبلغ نقدًا.", "الدرج مفتوح: سلّم العميل المبلغ.", "لم يُطبع إيصال المرتجع. الصرف مسجَّل، ويمكنك طباعة نسخة."],
        [REPRINT],
    ),
    "PayoutDrawerFailed": Payout(
        "warning",
        ["لم يُفتح الدرج، ولم يُسجَّل أي صرف.", "لم تستطع الطابعة فتح الدرج."],
        [btn("صرفتُ المبلغ يدويًا"), btn("حاول فتح الدرج مجددًا", "btn-primary")],
        started="17 أكتوبر 2026، 11:21",
    ),
    "PayoutDrawerUnknown": Payout(
        "warning",
        [
            "لا يُعرف هل فُتح الدرج، ولم يُسجَّل أي صرف. عُدّ النقد في الدرج، وإن سلّمت العميل المبلغ فسجّل الصرف يدويًا.",
            "لم يردّ الدرج في الوقت المحدد.",
        ],
        [btn("صرفتُ المبلغ يدويًا", "btn-primary")],
        started="17 أكتوبر 2026، 11:21",
    ),
    "PayoutConfirmManual": Payout(
        "warning",
        ["هل سلّمت العميل المبلغ نقدًا من درج فتحته يدويًا؟ سيُسجَّل الصرف باسمك ولا يمكن التراجع عنه."],
        [btn("إلغاء", "focus"), btn("نعم، سجّل الصرف", "btn-primary")],
        started="17 أكتوبر 2026، 11:21",
    ),
    "PayoutInterrupted": Payout(
        "warning",
        [
            "بدأ صرف هذا المرتجع ولم يكتمل.",
            "ربما فُتح الدرج من قبل. تأكّد هل استلم العميل المبلغ قبل المتابعة، ولا تصرفه مرتين.",
        ],
        [btn("استلمه العميل: سجّل الصرف"), btn("لم يستلمه: افتح الدرج واصرف")],
        started="17 أكتوبر 2026، 11:21",
    ),
    "PayoutWait": Payout(
        "warning",
        ["يجري صرف مرتجع آخر على هذا الجهاز الآن، فلم يُنفَّذ شيء. انتظر حتى ينتهي ثم حدّث الحالة."],
        [REFRESH],
    ),
    "PayoutRefused": Payout("danger", ["صُرف نقد هذا المرتجع من قبل. لا تصرفه مرة ثانية."], []),
    "PayoutUnknown": Payout("danger", ["لم تُعرف نتيجة الصرف. حدّث حالة المرتجع قبل أي محاولة جديدة."], [REFRESH]),
    "PayoutReprintFailed": Payout(
        "warning",
        [
            "سُجّل صرف المبلغ نقدًا.",
            "الدرج مفتوح: سلّم العميل المبلغ.",
            "طُبع إيصال المرتجع.",
            "لم تُطبع النسخة. تحقّق من الطابعة ثم حاول مجددًا.",
        ],
        [REPRINT],
    ),
}


# ── the states ───────────────────────────────────────────────────────
def two(flow: str, h: History) -> str:
    return screen(flow + history(h))


SHORT = History(ROWS_SHORT)


def st_lookup_empty() -> str:
    return two(lookup(), SHORT)


def st_lookup_blank() -> str:
    return two(lookup(note=notice("danger", ["أدخل رقم البيع."])), SHORT)


def st_lookup_not_found() -> str:
    note = notice("danger", ["لا يوجد بيع بهذا الرقم على هذا الجهاز."])
    return two(lookup("TERM-01-2026-10-15-000999", note), SHORT)


def st_lookup_refused() -> str:
    note = notice("danger", ["دُفع هذا البيع ببطاقة كليًا أو جزئيًا، والاسترداد هنا نقدي فقط."])
    return two(lookup("TERM-01-2026-10-15-000057", note), SHORT)


def st_lookup_offline() -> str:
    note = notice("danger", ["تعذّر الوصول إلى الخادم. المرتجعات تحتاج اتصالًا مباشرًا."])
    return two(lookup(SALE_NO, note), SHORT)


def st_found() -> str:
    return two(select(Select()), SHORT)


def st_select_picked() -> str:
    return two(select(Select(PICKED)), SHORT)


def st_select_quoting() -> str:
    return two(select(Select(PICKED, locked=True)), SHORT)


def st_select_refused() -> str:
    note = notice("danger", ["إحدى الكميات خارج المسموح الآن. ابحث عن البيع من جديد لرؤية الكميات الحالية."])
    return two(select(Select(PICKED, note)), SHORT)


def st_quote() -> str:
    return two(quote(), SHORT)


def st_outcome_unconfirmed() -> str:
    o = Outcome("danger", ["النتيجة غير مؤكدة. لا تعتبر المرتجع مكتملًا حتى يتأكد."], ref=False, check_again=True)
    return two(outcome(o), SHORT)


def st_outcome_refused() -> str:
    o = Outcome("danger", ["الكمية المطلوبة تتجاوز ما بقي قابلًا للإرجاع على الخادم. لم يُسجَّل المرتجع."], ref=False)
    return two(outcome(o), SHORT)


def st_outcome_failed() -> str:
    lines = ["لم تُعرف نتيجة الطلب. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة."]
    return two(outcome(Outcome("danger", lines, facts=False)), SHORT)


def st_outcome_may_be_recorded() -> str:
    # A refusal that may follow the send, with no journal row (mayBeRecorded): two lines.
    lines = [
        "تغيّرت جلسة التشغيل أثناء الطلب، فلم تُعرض النتيجة.",
        "قد يكون المرتجع سُجّل. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة.",
    ]
    return two(outcome(Outcome("danger", lines, facts=False)), SHORT)


def st_history_empty() -> str:
    return two(lookup(), History())


def st_history_rows() -> str:
    return two(lookup(focus=False), History(ROWS_ALL))


def st_history_reprint_failed() -> str:
    note = notice("danger", ["لم تُطبع النسخة. تحقّق من الطابعة ثم حاول مجددًا."], role="")
    return two(lookup(focus=False), History(ROWS_ALL, note=note))


def st_history_failed() -> str:
    return two(lookup(focus=False), History(failed=True))


def st_disabled() -> str:
    # ReturnsRoute's fail-closed gate: an <output>, no call is made.
    body = '<div class="page-state">' + notice("neutral", ["المرتجعات غير مفعّلة على هذا الجهاز."], role="") + "</div>"
    return screen(body)


def payout_state(key: str):
    def build() -> str:
        return two(confirmed_with(PAYOUTS[key]), SHORT)

    return build


STATES = [
    ("LookupEmpty", "البحث عن بيع", st_lookup_empty),
    ("LookupBlank", "لم يُدخل رقم البيع", st_lookup_blank),
    ("LookupNotFound", "لا يوجد بيع بهذا الرقم", st_lookup_not_found),
    ("LookupRefused", "رفض عند البحث: دفع بالبطاقة", st_lookup_refused),
    ("LookupOffline", "رفض عند البحث: بلا اتصال", st_lookup_offline),
    ("Found", "تم العثور على البيع: لم يُختر شيء", st_found),
    ("SelectPicked", "اختيار الأصناف", st_select_picked),
    ("SelectQuoting", "جارٍ حساب المبلغ", st_select_quoting),
    ("SelectRefused", "رفض الكميات", st_select_refused),
    ("Quote", "ملخص الاسترداد", st_quote),
    ("OutcomeUnconfirmed", "النتيجة غير مؤكدة", st_outcome_unconfirmed),
    ("OutcomeRefused", "رفض الخادم المرتجع", st_outcome_refused),
    ("OutcomeFailed", "لم تُعرف نتيجة الطلب", st_outcome_failed),
    ("OutcomeMayBeRecorded", "قد يكون المرتجع سُجّل", st_outcome_may_be_recorded),
    ("PayoutReady", "صرف النقد: جاهز", payout_state("PayoutReady")),
    ("PayoutOpening", "صرف النقد: جارٍ فتح الدرج", payout_state("PayoutOpening")),
    ("PayoutPaid", "صُرف النقد وطُبع الإيصال", payout_state("PayoutPaid")),
    ("PayoutNoDrawer", "صُرف النقد بلا درج", payout_state("PayoutNoDrawer")),
    ("PayoutSlipFailed", "صُرف النقد ولم يُطبع الإيصال", payout_state("PayoutSlipFailed")),
    ("PayoutReprintFailed", "لم تُطبع النسخة", payout_state("PayoutReprintFailed")),
    ("PayoutDrawerFailed", "لم يُفتح الدرج", payout_state("PayoutDrawerFailed")),
    ("PayoutDrawerUnknown", "لا يُعرف هل فُتح الدرج", payout_state("PayoutDrawerUnknown")),
    ("PayoutConfirmManual", "تأكيد الصرف اليدوي", payout_state("PayoutConfirmManual")),
    ("PayoutInterrupted", "صرف بدأ ولم يكتمل", payout_state("PayoutInterrupted")),
    ("PayoutWait", "صرف آخر جارٍ", payout_state("PayoutWait")),
    ("PayoutRefused", "رفض الصرف: صُرف من قبل", payout_state("PayoutRefused")),
    ("PayoutUnknown", "لم تُعرف نتيجة الصرف", payout_state("PayoutUnknown")),
    ("HistoryEmpty", "السجل فارغ", st_history_empty),
    ("HistoryRows", "السجل: كل حالات الصفوف", st_history_rows),
    ("HistoryReprintFailed", "السجل: لم تُطبع النسخة", st_history_reprint_failed),
    ("HistoryFailed", "تعذّر تحميل السجل", st_history_failed),
    ("Disabled", "المرتجعات غير مفعّلة", st_disabled),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6r.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, fn in STATES:
        body = fn()
        for w in (1024, 1280):
            (out / f"G6R-{key}-{w}.html").write_text(page(title, w, body, f"G6R-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
