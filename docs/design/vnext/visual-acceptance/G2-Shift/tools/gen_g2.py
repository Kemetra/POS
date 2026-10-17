"""Generate the RT-658 G-2 shift family references (visual DRAFT, pending owner approval).

Behaviour authority: the shipped RT-17 screens on main (src/renderer/v5/shift/: V5ShiftRoute,
CloseShiftPanel, CashMovementDialog, ManagerApprovalDialog, V5ShiftManagerRoute,
ManagerPinEnrollment) and the PK-3 parked-blocked close (RT-445, PK3-ShiftClose). Nothing here
adds data, a call or a capability. Every string is SHIFT_COPY / MOVEMENT_REASON_LABELS /
PARK_COPY verbatim (see G2-Spec.html); the vocabulary is G-6's page header, cards and dialog.

Usage: python -I gen_g2.py   (writes into this script's parent folder, G2-Shift/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

CASHIER = "منى عادل"
MANAGER = "سارة عبد الحميد"

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
CASHIER_NAV = {"cart"}  # OD-6 / RT-241: the cashier sees the Sale only
ROLE_AR = {"manager": "مدير", "cashier": "كاشير"}

ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "retry": '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "lock": '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def money(minor: int) -> str:
    """formatHumanMoney: grouped Western digits, two decimals, U+2212 minus, «EGP»."""
    sign = "−" if minor < 0 else ""
    major, cents = divmod(abs(minor), 100)
    return f'<span class="num">{sign}{major:,}.{cents:02d} EGP</span>'


def when(iso: str, shown: str) -> str:
    """formatHumanDateTime (ar-EG, Western digits): Arabic words, so Dubai, never mono."""
    return f'<time datetime="{iso}">{shown}</time>'


OPENED_AT = when("2026-10-17T08:05", "17 أكتوبر، 08:05")


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-658 G-2 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g2.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


@dataclass(frozen=True)
class View:
    """The frame around a screen: who is signed in, the current nav entry, and whether the
    whole background is inert behind a dialog."""

    role: str = "cashier"
    current: str | None = None
    inert: bool = False


def nav(view: View) -> str:
    i = " inert" if view.inert else ""
    who = CASHIER if view.role == "cashier" else MANAGER
    entries = [e for e in NAV if view.role != "cashier" or e[0] in CASHIER_NAV]
    cur = ' aria-current="page"'
    links = "".join(
        f'<li><a href="#"{cur if key == view.current else ""}>{label}</a></li>' for key, label in entries
    )
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{i}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{who}</b><span>{ROLE_AR[view.role]}</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def screen(title: str, content: str, view: View = View()) -> str:
    i = " inert" if view.inert else ""
    head = f'<div class="screen-head"><h1>{title}</h1></div>'
    return f'<main class="screen"{i}>{head}{content}</main>{nav(view)}'


NOTICE = {"success": ("ok", "status"), "neutral": ("info", "status"), "warning": ("warn", "alert")}


def notice(kind: str, text: str, action: str = "") -> str:
    glyph, role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role}">{icon(glyph)}<p>{text}</p>{action}</div>'


def panel(title: str, body: str, hid: str, head_extra: str = "") -> str:
    return (
        f'<section class="panel" aria-labelledby="{hid}">'
        f'<div class="panel-head"><h2 id="{hid}">{title}</h2>{head_extra}</div>'
        f'<div class="panel-body">{body}</div></section>'
    )


def btn(label: str, kind: str = "", glyph: str = "", state: str = "") -> str:
    """A button; `state` is "", "focus" (drawn with the focus ring) or "disabled"."""
    cls = "btn" + (f" btn-{kind}" if kind else "") + (" focus" if state == "focus" else "")
    d = " disabled" if state == "disabled" else ""
    g = icon(glyph) if glyph else ""
    return f'<button type="button" class="{cls}"{d}>{g}{label}</button>'


@dataclass(frozen=True)
class Amount:
    """An amount field: its value, whether it holds the focus, and its refusal (if any)."""

    value: str = ""
    focus: bool = False
    error: str = ""


def amount_field(fid: str, label: str, a: Amount) -> str:
    f = " focus" if a.focus else ""
    inv = f' aria-invalid="true" aria-describedby="{fid}-err"' if a.error else ""
    err = (
        f'<div id="{fid}-err">{notice("warning", a.error)}</div>' if a.error else ""
    )
    return (
        f'<div class="field"><label for="{fid}">{label}</label>'
        f'<input id="{fid}" class="input amount{f}" inputmode="decimal" autocomplete="off" value="{a.value}"{inv}>'
        f"</div>{err}"
    )


# ── the cashier's shift (/app/shift) ────────────────────────────────
INVALID = "أدخل مبلغًا صحيحًا بخانتين عشريتين على الأكثر."


def open_panel(a: Amount = Amount(focus=True)) -> str:
    body = amount_field("float", "مبلغ الافتتاح في الدرج", a) + f'<div class="commit">{btn("فتح الوردية", "primary")}</div>'
    return panel("فتح وردية", body, "open-h")


@dataclass(frozen=True)
class Totals:
    float_minor: int = 50000
    pay_in: int = 20000
    pay_out: int = 125000


def summary_panel(t: Totals = Totals()) -> str:
    rows = [
        ("مبلغ الافتتاح", t.float_minor),
        ("إجمالي الإيداعات", t.pay_in),
        ("إجمالي السحوبات", t.pay_out),
    ]
    ledger = "".join(f"<div><dt>{k}</dt><dd>{money(v)}</dd></div>" for k, v in rows)
    body = (
        f'<dl class="ledger">{ledger}</dl>'
        f'<div class="commit">{btn("إيداع نقدي")}{btn("سحب نقدي")}</div>'
    )
    return panel(f"وردية مفتوحة منذ {OPENED_AT}", body, "sum-h")


BLIND = "عُدّ النقد في الدرج وأدخله. لا يظهر المبلغ المتوقع قبل تسجيل العدّ."


def parked_block() -> str:
    """PK3-ShiftClose, unchanged: SHIFT_COPY.parked_sales_present, the terminal-wide count, the button."""
    return (
        '<div class="notice notice-warning stack" role="alert">'
        f'{icon("warn")}<div class="grow-text">'
        "<p>توجد مبيعات معلّقة على هذا الجهاز. استأنفها أو اطلب من المدير إلغاءها ثم أغلق الوردية.</p>"
        '<p><span class="chip-count">3 مبيعات معلّقة على هذا الجهاز</span></p>'
        f'<p>{btn("عرض مبيعاتي المعلّقة")}</p></div></div>'
    )


@dataclass(frozen=True)
class Close:
    count: str = ""
    focus_commit: bool = False
    parked: bool = False


def close_panel(c: Close = Close()) -> str:
    body = (
        f'<p class="hint">{BLIND}</p>'
        + amount_field("count", "النقد المعدود في الدرج", Amount(c.count))
        + (parked_block() if c.parked else "")
        + f'<div class="commit">{btn("تسجيل العدّ وإغلاق الوردية", "primary", state="focus" if c.focus_commit else "")}</div>'
    )
    return panel("إغلاق الوردية", body, "close-h")


def open_shift(t: Totals = Totals(), c: Close = Close()) -> str:
    return f'<div class="shift-grid">{summary_panel(t)}{close_panel(c)}</div>'


def cashier(content: str, inert: bool = False) -> str:
    return screen("الوردية", content, View(inert=inert))


def to_sale() -> str:
    return '<a class="btn" href="#">الذهاب إلى البيع</a>'


def s_open(w: int) -> str:
    return cashier(f'<div class="page-state">{open_panel()}</div>')


def s_open_invalid(w: int) -> str:
    a = Amount("50.555", focus=True, error=INVALID)
    return cashier(f'<div class="page-state">{open_panel(a)}</div>')


def s_opened(w: int) -> str:
    out = notice("success", "فُتحت الوردية.", to_sale())
    return cashier(out + open_shift(Totals(50000, 0, 0)))


def s_status(w: int) -> str:
    return cashier(open_shift())


# ── pay-in / pay-out (CashMovementDialog) ────────────────────────────
REASONS = [
    ("bank_drop", "إيداع بنكي"),
    ("float_top_up", "تزويد الفكة"),
    ("petty_expense", "مصروف نثري"),
    ("other", "أخرى"),
]


@dataclass(frozen=True)
class Movement:
    title: str
    amount: str = ""
    reason: str = "bank_drop"
    error: str = ""


def movement_dialog(m: Movement) -> str:
    opts = "".join(
        f'<option value="{k}"{" selected" if k == m.reason else ""}>{v}</option>' for k, v in REASONS
    )
    msg = notice("warning", m.error) if m.error else ""
    return (
        '<div class="scrim">'
        '<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="mv-h">'
        f'<h2 id="mv-h">{m.title}</h2>'
        '<form class="fields" novalidate>'
        + amount_field("mv-amount", "المبلغ", Amount(m.amount, focus=not m.error))
        + '<div class="field"><label for="mv-reason">السبب</label>'
        f'<select id="mv-reason" class="select">{opts}</select></div>'
        '<div class="field"><label for="mv-note">ملاحظة (اختياري، دون بيانات شخصية)</label>'
        '<textarea id="mv-note" class="textarea" maxlength="200"></textarea></div>'
        f'<div class="slot" role="status" aria-live="polite">{msg}</div>'
        '<div class="dialog-actions">'
        f'{btn("إلغاء")}'
        f'<button type="submit" class="btn btn-primary{" focus" if m.error else ""}">تسجيل</button>'
        "</div></form></div></div>"
    )


def s_pay_in(w: int) -> str:
    return cashier(open_shift(), inert=True) + movement_dialog(Movement("إيداع نقدي", "200.00", "float_top_up"))


def s_pay_out(w: int) -> str:
    return cashier(open_shift(), inert=True) + movement_dialog(Movement("سحب نقدي", "300.00"))


def s_pay_out_refused(w: int) -> str:
    m = Movement("سحب نقدي", "3,000.00", error="لم يُقبل السحب، ولم يُسجَّل شيء. راجع المدير.")
    return cashier(open_shift(), inert=True) + movement_dialog(m)


def s_recorded(w: int) -> str:
    out = notice("success", "سُجّل الإيداع.")
    return cashier(out + open_shift(Totals(50000, 40000, 125000)))


# ── the blind-count close ────────────────────────────────────────────
def s_close_count(w: int) -> str:
    return cashier(open_shift(c=Close("2,425.00", focus_commit=True)))


MANAGERS = ["سارة عبد الحميد", "خالد إبراهيم"]


def approval_dialog() -> str:
    """ManagerApprovalDialog as opened: nothing chosen, the commit unavailable, focus on «إلغاء»."""
    choices = "".join(
        f'<label class="choice"><input type="radio" name="approver">{n}</label>' for n in MANAGERS
    )
    return (
        '<div class="scrim">'
        '<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ap-h">'
        '<h2 id="ap-h">موافقة المدير</h2>'
        '<p class="hint">لا يُغلق هذا العدّ إلا بموافقة مدير مسجَّل على هذا الجهاز، برقمه السري.</p>'
        '<form class="fields" novalidate>'
        f'<fieldset class="choices"><legend>المدير</legend>{choices}</fieldset>'
        '<div class="field"><label for="ap-pin">الرقم السري للمدير</label>'
        '<input id="ap-pin" class="input pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>'
        '<div class="slot" role="status" aria-live="polite"></div>'
        '<div class="dialog-actions">'
        f'{btn("إلغاء", state="focus")}'
        '<button type="submit" class="btn btn-primary" disabled>اعتماد وإغلاق</button>'
        "</div></form></div></div>"
    )


def s_close_approval(w: int) -> str:
    return cashier(open_shift(c=Close("2,425.00")), inert=True) + approval_dialog()


def s_closed(w: int) -> str:
    out = notice("success", "أُغلقت الوردية.")
    return cashier(f'<div class="page-state">{out}{open_panel(Amount())}</div>')


def s_closed_approved(w: int) -> str:
    # Only an approved close returns its variance (CloseShiftPanel): shown after the commit.
    out = (
        '<div class="notice notice-success stack" role="status">'
        f'{icon("ok")}<div class="grow-text"><p>أُغلقت الوردية.</p>'
        f"<p>فرق العدّ المعتمد: {money(-2500)}</p></div></div>"
    )
    return cashier(f'<div class="page-state">{out}{open_panel(Amount())}</div>')


def s_parked_blocked(w: int) -> str:
    return cashier(open_shift(c=Close("2,450.00", focus_commit=True, parked=True)))


def s_unavailable(w: int) -> str:
    retry = btn("إعادة المحاولة", glyph="retry", state="focus")
    return cashier(
        f'<div class="page-state">{notice("warning", "تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.", retry)}</div>'
    )


# ── the manager's shift status (/app/shift/manager) ──────────────────
@dataclass(frozen=True)
class Status:
    open: bool = True
    queue: tuple[int, int, int, int] = (2, 0, 0, 0)
    stranded: tuple[int, int] = (0, 0)
    pending: tuple[int, int] = (0, 0)
    probes: tuple[int, int, int] = (0, 1, 0)


def figures() -> str:
    t = Totals()
    rows = [
        ("وردية مفتوحة منذ", OPENED_AT),
        ("مبلغ الافتتاح", money(t.float_minor)),
        ("إجمالي الإيداعات", money(t.pay_in)),
        ("إجمالي السحوبات", money(t.pay_out)),
    ]
    return '<dl class="figures">' + "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in rows) + "</dl>"


def counts(heading: str, rows: list[tuple[str, int]]) -> str:
    def dd(n: int) -> str:
        return f'<dd class="num {"zero" if n == 0 else "some"}">{n}</dd>'

    items = "".join(f"<div><dt>{k}</dt>{dd(n)}</div>" for k, n in rows)
    return f'<div class="group"><h3>{heading}</h3><dl class="counts">{items}</dl></div>'


def status_panel(s: Status) -> str:
    open_html = (
        figures()
        if s.open
        else f'<p class="no-shift">{icon("clock")}لا توجد وردية مفتوحة.</p>'
    )
    q, st, pd, pr = s.queue, s.stranded, s.pending, s.probes
    groups = (
        '<div class="groups">'
        + counts("وقائع الوردية غير المؤكَّدة على الخادم", [
            ("بانتظار الإرسال", q[0]), ("بانتظار إعادة المحاولة", q[1]),
            ("متوقفة", q[2]), ("بانتظار مسار المدير", q[3]),
        ])
        + counts("خارج إقران هذا الجهاز", [("وقائع غير مرسلة", st[0]), ("ورديات مفتوحة", st[1])])
        + counts("نشاط درج لم يكتمل", [("صرف مرتجعات", pd[0]), ("مبيعات لم تكتمل", pd[1])])
        + counts("محاولات مرفوضة في الوردية المفتوحة (منذ آخر تشغيل)", [
            ("سحب غير مقبول", pr[0]), ("إغلاق بفرق دون موافقة", pr[1]), ("موافقة مدير غير مقبولة", pr[2]),
        ])
        + "</div>"
    )
    refresh = btn("تحديث", glyph="retry")
    return panel("حالة الوردية على هذا الجهاز", open_html + groups, "st-h", refresh)


@dataclass(frozen=True)
class Pin:
    focus: bool = True
    result: str = ""


def pin_field(fid: str, label: str, focus: bool = False) -> str:
    f = " focus" if focus else ""
    return (
        f'<div class="field"><label for="{fid}">{label}</label>'
        f'<input id="{fid}" class="input pin{f}" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>'
    )


def pin_panel(p: Pin = Pin()) -> str:
    return (
        '<section class="panel" aria-labelledby="pin-h">'
        f'<div class="lead-head"><span class="glyph" aria-hidden="true">{icon("lock")}</span><div>'
        '<h2 id="pin-h">الرقم السري للمدير على هذا الجهاز</h2>'
        '<p class="hint">يُستخدم لاعتماد فرق العدّ عند إغلاق الوردية. احفظه خلال دقيقتين من تسجيل دخولك عبر الإنترنت.</p>'
        "</div></div>"
        '<div class="panel-body">'
        + pin_field("pin-new", "الرقم السري الجديد (6 إلى 8 أرقام)", p.focus)
        + pin_field("pin-confirm", "تأكيد الرقم السري")
        + pin_field("pin-current", "الرقم السري الحالي (عند التغيير فقط)")
        + p.result
        + f'<div class="commit">{btn("حفظ الرقم السري", "primary")}</div>'
        "</div></section>"
    )


STRANDED = (
    "تنبيه: على هذا الجهاز سجلات وردية من إقران سابق تعذّر إرسالها. قبل إلغاء ترخيص أي جهاز أو إعادة تعيينه، "
    "يجب إغلاق الوردية المفتوحة وتفريغ طابور المزامنة."
)


def manager(content: str) -> str:
    return screen("حالة الوردية", content, View(role="manager", current="dashboard"))


def mgr_grid(s: Status, p: Pin = Pin()) -> str:
    return f'<div class="mgr-grid">{status_panel(s)}{pin_panel(p)}</div>'


def s_mgr_open(w: int) -> str:
    return manager(mgr_grid(Status()))


def s_mgr_no_shift(w: int) -> str:
    return manager(mgr_grid(Status(open=False, queue=(0, 0, 0, 0), probes=(0, 0, 0))))


def s_mgr_stranded(w: int) -> str:
    s = Status(queue=(0, 0, 1, 0), stranded=(3, 1))
    return manager(notice("warning", STRANDED) + mgr_grid(s, Pin(focus=False)))


def s_mgr_pin_saved(w: int) -> str:
    saved = '<output class="notice notice-success">' + icon("ok") + "<p>حُفظ الرقم السري لهذا الجهاز.</p></output>"
    return manager(mgr_grid(Status(), Pin(focus=False, result=saved)))


def s_mgr_pin_error(w: int) -> str:
    return manager(mgr_grid(Status(), Pin(result=notice("warning", "الرقمان غير متطابقين."))))


def s_mgr_unavailable(w: int) -> str:
    retry = btn("إعادة المحاولة", glyph="retry")
    refused = (
        '<section class="panel" aria-labelledby="st-h"><div class="panel-head">'
        '<h2 id="st-h">حالة الوردية على هذا الجهاز</h2></div><div class="panel-body">'
        + notice("warning", "تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.", retry)
        + "</div></section>"
    )
    return manager(f'<div class="mgr-grid">{refused}{pin_panel()}</div>')


STATES = [
    ("Open", "فتح وردية", s_open),
    ("OpenInvalid", "فتح وردية: مبلغ غير صالح", s_open_invalid),
    ("Opened", "فُتحت الوردية", s_opened),
    ("Status", "وردية مفتوحة: الملخص والإغلاق", s_status),
    ("PayIn", "إيداع نقدي", s_pay_in),
    ("PayOut", "سحب نقدي", s_pay_out),
    ("PayOutRefused", "سحب نقدي غير مقبول", s_pay_out_refused),
    ("Recorded", "سُجّل الإيداع", s_recorded),
    ("CloseCount", "إغلاق الوردية: العدّ قبل التسجيل", s_close_count),
    ("CloseApproval", "إغلاق الوردية: موافقة المدير", s_close_approval),
    ("Closed", "أُغلقت الوردية", s_closed),
    ("ClosedApproved", "أُغلقت الوردية بفرق معتمد", s_closed_approved),
    ("ParkedBlocked", "إغلاق الوردية مرفوض: مبيعات معلّقة", s_parked_blocked),
    ("Unavailable", "تعذّرت قراءة حالة الوردية", s_unavailable),
    ("MgrOpen", "حالة الوردية: وردية مفتوحة", s_mgr_open),
    ("MgrNoShift", "حالة الوردية: لا توجد وردية", s_mgr_no_shift),
    ("MgrStranded", "حالة الوردية: سجلات من إقران سابق", s_mgr_stranded),
    ("MgrPinSaved", "حُفظ الرقم السري", s_mgr_pin_saved),
    ("MgrPinError", "الرقمان غير متطابقين", s_mgr_pin_error),
    ("MgrUnavailable", "تعذّرت قراءة حالة الوردية (المدير)", s_mgr_unavailable),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g2.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"G2-{key}-{w}.html").write_text(page(title, w, fn(w), f"G2-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
