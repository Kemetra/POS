"""Generate the RT-471 PK-3 park / resume reference HTML files (visual DRAFT, pending owner approval).

Behaviour authority: specs/024-park-resume-v1/spec.md (RT-439) and the PK-2 bridge
src/shared/cart/park-types.ts (RT-440). Nothing here defines behaviour the contract does not.
Strings the contract and the shipped catalogues do not define are PROPOSED: they are drawn for
layout only and listed in PK3-Spec.html with their owner decision.

Usage: python -I gen_pk3.py <PK3-Park-Resume folder>
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

OPERATOR = "منى عادل"

# OD-6 (VN-S10) and RT-597: the cashier frame carries the Sale only.
NAV = ["نقطة البيع"]

ICONS = {
    "pause": '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "up": '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>',
    "down": '<path d="M12 5v13M6.5 12.5L12 18l5.5-5.5"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "gone": '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
    "search": '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
    "scan": '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 9v6M11 9v6M14 9v6M17 9v6"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def money(minor: int) -> str:
    sign = "-" if minor < 0 else ""
    minor = abs(minor)
    return f'<span class="num">{sign}{minor // 100}.{minor % 100:02d} EGP</span>'


def plural_items(n: int) -> str:
    if n == 1:
        return "صنف واحد"
    if n == 2:
        return "صنفان"
    return f"{n} أصناف"


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-471 PK-3 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="pk3.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def nav(inert: bool = False, current: str | None = "نقطة البيع") -> str:
    i = " inert" if inert else ""
    cur = ' aria-current="page"'
    links = "".join(
        f'<li><a href="#"{cur if label == current else ""}>{label}</a></li>' for label in NAV
    )
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{i}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{OPERATOR}</b><span>كاشير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


# Each tone has its own glyph and live-region role: warnings interrupt, the rest are polite.
NOTICE = {
    "success": ("ok", "status"),
    "neutral": ("info", "status"),
    "warning": ("warn", "alert"),
}


def notice(kind: str, text: str, action: str = "") -> str:
    glyph, role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role}">{icon(glyph)}<p>{text}</p>{action}</div>'


@dataclass(frozen=True)
class View:
    """What surrounds a screen's content: a notice above it, whether it sits behind a dialog, the current nav entry."""

    notice_html: str = ""
    inert: bool = False
    current: str | None = "نقطة البيع"


def screen(head: str, content: str, view: View = View()) -> str:
    i = " inert" if view.inert else ""
    return f'<main class="screen"{i}>{head}{view.notice_html}{content}</main>{nav(view.inert, view.current)}'


# ── the Sale screen ─────────────────────────────────────────────────
CART = [
    ("بنادول إكسترا 500 مجم — 24 قرص", "Panadol Extra 500mg", 2, 9000),
    ("أموكسيسيلين/كلافولانيت 875/125 مجم", "Amoxicillin/Clavulanate", 1, 18750),
    ("فولتارين جل 1% — 50 جم", "Voltaren Emulgel 1%", 1, 6800),
    ("كونجستال أقراص", "Congestal Tablets", 1, 2950),
]
CART_TOTAL = 37500


def sale_head(parked_count: int) -> str:
    # The parked list is reached by a visible button (no F3: D-K1 / RT-252 are open).
    return (
        '<div class="screen-head"><h1>نقطة البيع</h1><span class="grow"></span>'
        f'<button type="button" class="btn btn-quiet">المبيعات المعلّقة <span class="badge-count num">{parked_count}</span></button>'
        "</div>"
    )


def rail() -> str:
    return (
        '<section class="rail" aria-label="إضافة صنف">'
        "<h2>إضافة صنف</h2>"
        f'<div class="scan">{icon("scan")}<span>جاهز للمسح</span></div>'
        f'<div class="search">{icon("search")}<span>&nbsp;اكتب حرفين على الأقل…</span></div>'
        "</section>"
    )


def lines_html() -> str:
    rows = "".join(
        f'<li class="line"><span class="nm">{ar}<span class="en ltr">{en}</span></span>'
        f'<span class="num">× {q}</span><b>{money(t)}</b></li>'
        for ar, en, q, t in CART
    )
    return f'<ul class="lines" aria-label="أصناف البيع">{rows}</ul>'


def cart_panel(empty: bool = False, park_focus: bool = False, locked: bool = False) -> str:
    dis = " disabled" if (empty or locked) else ""
    f = " focus" if park_focus else ""
    sub = "لا أصناف" if empty else f"{plural_items(len(CART))} · 5 وحدات"
    body = (
        '<div class="cart-empty"><p>لا توجد أصناف في السلة بعد.</p></div>'
        if empty
        else lines_html()
    )
    total = 0 if empty else CART_TOTAL
    pay_dis = " disabled" if (empty or locked) else ""
    void_dis = " disabled" if (empty or locked) else ""
    return (
        '<section class="panel" aria-labelledby="cart-h">'
        '<div class="cart-bar">'
        f'<div class="title"><h2 id="cart-h">سلة المشتريات</h2><span class="sub">{sub}</span></div>'
        f'<button type="button" class="btn btn-park{f}"{dis}>{icon("pause")}تعليق البيع</button>'
        '<span class="sep" aria-hidden="true"></span>'
        f'<button type="button" class="btn btn-danger"{void_dis}>إلغاء البيع</button>'
        "</div>"
        f"{body}"
        '<div class="totals">'
        f'<div class="sum"><span>الإجمالي الحالي</span><b>{money(total)}</b></div>'
        f'<button type="button" class="btn btn-primary"{pay_dis}>الدفع</button>'
        "</div></section>"
    )


def sale_body(empty: bool = False, park_focus: bool = False, locked: bool = False) -> str:
    return f'<div class="sale">{cart_panel(empty, park_focus, locked)}{rail()}</div>'


# ── the park dialog ────────────────────────────────────────────────
PII = "لا تكتب اسم العميل أو رقم هاتفه أو أي بيانات شخصية."


@dataclass(frozen=True)
class Park:
    label: str = ""
    phase: str = "typing"
    notice_html: str = ""
    primary_disabled: bool = False
    secondary: str = ""


def park_dialog(park: Park = Park()) -> str:
    label, phase, notice_html, secondary = park.label, park.phase, park.notice_html, park.secondary
    primary_disabled = park.primary_disabled
    busy = phase == "saving"
    invalid = phase == "invalid"
    dis_all = " disabled" if busy else ""
    ro = " readonly" if busy else ""
    inv = ' aria-invalid="true" aria-describedby="park-pii park-msg"' if invalid else ' aria-describedby="park-pii"'
    msg = ""
    if invalid:
        msg = (
            '<span class="notice notice-warning" role="alert">'
            f'{icon("warn")}<p>اكتب اسمًا من 1 إلى 40 حرفًا في سطر واحد، أو اتركه فارغًا.</p></span>'
        )
    elif notice_html:
        msg = notice_html
    elif busy:
        msg = f'<span class="notice notice-neutral" role="status">{icon("clock")}<p>جارٍ حفظ البيع…</p></span>'
    count = len(label.strip()) if invalid is False else len(label)
    primary_off = " disabled" if (primary_disabled or busy) else ""
    focus_input = " focus" if phase in ("typing", "invalid") else ""
    return (
        '<div class="scrim">'
        '<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="park-h">'
        '<h2 id="park-h">تعليق البيع</h2>'
        f'<div class="summary"><span>{plural_items(len(CART))}</span>{money(CART_TOTAL)}</div>'
        "<form novalidate>"
        '<div class="fields"><div class="field">'
        '<div class="row-label"><label for="park-label">اسم للبيع (اختياري)</label>'
        f'<span class="counter num" aria-hidden="true">{count}/40</span></div>'
        f'<input id="park-label" class="input text{focus_input}" type="text" maxlength="40" autocomplete="off" '
        f'value="{label}"{inv}{ro}>'
        "</div>"
        f'<p class="pii" id="park-pii">{icon("warn")}<span>{PII}</span></p></div>'
        f'<div class="slot" id="park-msg" role="status" aria-live="polite">{msg}</div>'
        '<div class="dialog-actions split">'
        f"<div>{secondary}</div>"
        '<div style="display:flex;gap:8px">'
        f'<button type="button" class="btn"{dis_all}>رجوع</button>'
        f'<button type="submit" class="btn btn-primary"{primary_off}>تعليق البيع</button>'
        "</div></div></form></div></div>"
    )


# ── the parked list ────────────────────────────────────────────────
# (label | None, lines, total_minor, "parked_at" shown, stale). Newest first; this operator only.
PARKED_5 = [
    (None, 1, 4500, "13:55", False),
    ("ينتظر الروشتة", 4, 21200, "13:41", False),
    ("طلب التوصيل", 5, 64025, "12:10", False),
    ("عميل الصف الثاني", 2, 11850, "11:32", False),
    ("ينتظر وصول الروشتة الأصلية من المريض", 4, 9600, "10:05", False),
]
PARKED_STALE = [
    ("ينتظر الروشتة", 4, 21200, "13:41", False),
    ("طلب التوصيل", 5, 64025, "16/10 20:45", True),
    ("عميل الصف الثاني", 2, 11850, "16/10 13:20", True),
]


def list_head(count_text: str) -> str:
    return (
        '<div class="screen-head"><h1>المبيعات المعلّقة</h1>'
        f'<p>{count_text}</p><span class="grow"></span>'
        '<button type="button" class="btn">رجوع إلى البيع</button></div>'
    )


def prow(item: tuple, focus: bool = False) -> str:
    label, lines, total, at, stale = item
    shown = f'<span class="lbl"><bdi>{label}</bdi></span>' if label else '<span class="muted">بدون اسم</span>'
    tag = f'<span class="tag-stale">{icon("clock")}قديم</span>' if stale else ""
    f = " focus" if focus else ""
    return (
        '<li class="prow">'
        f'<span class="name">{shown}<span class="meta">{plural_items(lines)} · عُلّق <time class="num">{at}</time></span></span>'
        f'<span class="slot-stale">{tag}</span>'
        f'<span class="total">{money(total)}</span>'
        f'<button type="button" class="btn{f}">استئناف البيع</button>'
        "</li>"
    )


def list_panel(items: list[tuple], foot: bool = True) -> str:
    count = f'<span class="count">{len(items)} من مبيعاتك</span>'
    rows = "".join(prow(it, i == 0) for i, it in enumerate(items))
    foot_html = (
        '<p class="panel-foot">تبقى المبيعات المعلّقة على هذا الجهاز ولا تظهر لغير صاحبها. '
        "يُراجَع كل سعر عند الاستئناف.</p>"
        if foot
        else ""
    )
    return (
        '<section class="panel" aria-labelledby="pl-h">'
        f'<div class="panel-head"><h2 id="pl-h">مبيعاتك المعلّقة</h2>{count}</div>'
        f'<ul class="plist" aria-labelledby="pl-h">{rows}</ul>{foot_html}</section>'
    )


def list_empty_panel() -> str:
    body = '<div class="panel-state">' + notice("neutral", "لا توجد مبيعات معلّقة.") + "</div>"
    return (
        '<section class="panel" aria-labelledby="pl-h">'
        '<div class="panel-head"><h2 id="pl-h">مبيعاتك المعلّقة</h2><span class="count">0</span></div>'
        f"{body}</section>"
    )


# ── the resume review ──────────────────────────────────────────────
CHANGES = [
    ("فولتارين جل 1% — 50 جم", 6800, 6400),
    ("بنادول إكسترا 500 مجم — 24 قرص", 4500, 4800),
]
REMOVED = ["كونجستال أقراص", "نوفالجين أقراص 500 مجم"]
FRESH = "آخر كتالوج: اليوم 13:02"


def review_head(label: str | None) -> str:
    name = f"<bdi>{label}</bdi>" if label else "بدون اسم"
    return (
        f'<div class="screen-head"><h1>استئناف البيع</h1><p>{name}</p><span class="grow"></span>'
        '<button type="button" class="btn">رجوع إلى القائمة</button></div>'
    )


def change_table() -> str:
    head = (
        '<div class="tr th" role="row"><span role="columnheader">الصنف</span>'
        '<span role="columnheader">السعر السابق</span><span role="columnheader">السعر الجديد</span>'
        '<span role="columnheader">الفرق للوحدة</span></div>'
    )
    rows = []
    for name, old, new in CHANGES:
        d = new - old
        cls, glyph, word = ("diff-up", "up", "ارتفع") if d > 0 else ("diff-down", "down", "انخفض")
        sign = "+" if d > 0 else "-"
        rows.append(
            f'<div class="tr" role="row"><span class="nm" role="cell"><bdi>{name}</bdi></span>'
            f'<span class="old" role="cell">{money(old)}</span><span role="cell"><b>{money(new)}</b></span>'
            f'<span class="diff {cls}" role="cell">{icon(glyph)}<span class="num">{sign}{abs(d) // 100}.{abs(d) % 100:02d}</span>'
            f'<span class="diff-word">{word}</span></span></div>'
        )
    return f'<div class="tbl" role="table" aria-label="تغيّر الأسعار">{head}{"".join(rows)}</div>'


def removed_table() -> str:
    rows = "".join(
        f'<div class="tr gone" role="row"><span class="nm" role="cell"><bdi>{n}</bdi></span>'
        f'<span class="tag-gone" role="cell">{icon("gone")}ستُحذف</span></div>'
        for n in REMOVED
    )
    return f'<div class="tbl" role="table" aria-label="أصناف ستُحذف">{rows}</div>'


def conflict_block(lines: int = 2, total: int = 9500) -> str:
    return (
        '<div class="conflict" role="group" aria-labelledby="cf-h">'
        f'<p class="head" id="cf-h">{icon("warn")}<span>لديك بيع نشط الآن: {plural_items(lines)} بقيمة {money(total)}.</span></p>'
        "<p>لا يمكن دمج بيعين. اختر ما يحدث للبيع الحالي.</p></div>"
    )


@dataclass(frozen=True)
class Review:
    price: bool = False
    removed: bool = False
    conflict: bool = False
    top_notice: str = ""
    primary: str | None = None
    secondary: str | None = None


def review_actions(primary: str | None, secondary: str | None) -> str:
    if primary is None and secondary is None:
        return ""
    p = f'<button type="button" class="btn btn-primary focus">{primary}</button>' if primary else ""
    s = f'<button type="button" class="btn">{secondary}</button>' if secondary else ""
    return f'<div class="review-actions">{p}{s}</div>'


def review_parts(r: Review) -> list[str]:
    """The review's blocks in reading order; a block that does not apply is an empty string."""
    changes = r.price or r.removed
    return [
        r.top_notice,
        conflict_block() if r.conflict else "",
        '<p class="lead">لن يتغيّر شيء في البيع قبل أن تقبل التغييرات.</p>' if changes else "",
        "<h3>تغيّر سعر الصنف منذ التعليق</h3>" + change_table() if r.price else "",
        "<h3>لم تعد في الكتالوج، وستُحذف من البيع عند الاستئناف</h3>" + removed_table() if r.removed else "",
        review_actions(r.primary, r.secondary),
    ]


def review_panel(r: Review) -> str:
    body = "".join(review_parts(r))
    return (
        '<section class="panel" aria-labelledby="rv-h">'
        '<div class="panel-head"><h2 id="rv-h">مراجعة البيع قبل الاستئناف</h2>'
        f'<span class="freshness">{FRESH}</span></div>'
        f'<div class="review">{body}</div></section>'
    )


# ── states ───────────────────────────────────────────────────────────
def s_sale_ready(w: int) -> str:
    return screen(sale_head(2), sale_body(park_focus=True))


def s_sale_empty(w: int) -> str:
    return screen(sale_head(2), sale_body(empty=True))


def s_park_dialog(w: int) -> str:
    return screen(sale_head(2), sale_body(), View(inert=True)) + park_dialog()


def s_park_label(w: int) -> str:
    return screen(sale_head(2), sale_body(), View(inert=True)) + park_dialog(Park(label="ينتظر المحفظة"))


def s_park_invalid(w: int) -> str:
    return screen(sale_head(2), sale_body(), View(inert=True)) + park_dialog(Park(label="ينتظر المحفظة", phase="invalid"))


def s_park_saving(w: int) -> str:
    return screen(sale_head(2), sale_body(), View(inert=True)) + park_dialog(Park(label="ينتظر المحفظة", phase="saving"))


def s_park_limit(w: int) -> str:
    n = notice(
        "warning",
        "وصل هذا الجهاز إلى الحد الأقصى: 5 مبيعات معلّقة. استأنف بيعًا معلّقًا أو اطلب من المدير إلغاءه.",
    )
    sec = '<button type="button" class="btn focus">عرض المبيعات المعلّقة</button>'
    return screen(sale_head(4), sale_body(), View(inert=True)) + park_dialog(
        Park(label="ينتظر المحفظة", notice_html=n, primary_disabled=True, secondary=sec)
    )


def s_parked(w: int) -> str:
    done = notice("success", "عُلِّق البيع <bdi>ينتظر المحفظة</bdi>.")
    return screen(sale_head(3), sale_body(empty=True), View(notice_html=done))


def s_list_empty(w: int) -> str:
    return screen(list_head("لا شيء"), list_empty_panel())


def s_list_one(w: int) -> str:
    return screen(list_head("1"), list_panel(PARKED_5[1:2]))


def s_list_five(w: int) -> str:
    return screen(list_head("5"), list_panel(PARKED_5))


def s_list_stale(w: int) -> str:
    return screen(list_head("3"), list_panel(PARKED_STALE))


SALE = "ينتظر الروشتة"
ACCEPT = "قبول التغييرات واستئناف البيع"
BACK = "رجوع"


def review_state(r: Review) -> str:
    return screen(review_head(SALE), review_panel(r))


def s_review_price(w: int) -> str:
    return review_state(Review(price=True, primary=ACCEPT, secondary=BACK))


def s_review_removed(w: int) -> str:
    return review_state(Review(removed=True, primary="قبول الحذف واستئناف البيع", secondary=BACK))


def s_review_mixed(w: int) -> str:
    return review_state(Review(price=True, removed=True, primary=ACCEPT, secondary=BACK))


def s_conflict_clean(w: int) -> str:
    return review_state(
        Review(conflict=True, primary="علّق البيع الحالي واستأنف المحدد", secondary="أبقِ البيع الحالي")
    )


def s_conflict_changes(w: int) -> str:
    return review_state(
        Review(
            conflict=True,
            price=True,
            removed=True,
            primary="علّق الحالي، اقبل التغييرات واستأنف",
            secondary="أبقِ البيع الحالي",
        )
    )


def s_ref_catalogue(w: int) -> str:
    n = notice(
        "warning",
        "تعذّرت مراجعة الأسعار لأن الكتالوج غير متاح على هذا الجهاز. بقي البيع معلّقًا ولم يتغيّر شيء.",
    )
    return review_state(Review(top_notice=n, secondary=BACK))


def s_ref_changed(w: int) -> str:
    n = notice("warning", "تغيّرت الأسعار منذ عرضها. راجع التغييرات الجديدة قبل الاستئناف.")
    return review_state(Review(top_notice=n, price=True, primary=ACCEPT, secondary=BACK))


def s_ref_checkout(w: int) -> str:
    n = notice("warning", "البيع الحالي في مرحلة الدفع. أكمله أو ارجع إليه قبل أن تستأنف بيعًا معلّقًا.")
    return review_state(Review(top_notice=n, secondary=BACK))


def s_shift_close(w: int) -> str:
    head = '<div class="screen-head"><h1>الوردية</h1></div>'
    alert = (
        '<div class="notice notice-warning" role="alert">'
        f'{icon("warn")}<div class="grow-text"><p>توجد مبيعات معلّقة على هذا الجهاز. '
        "استأنفها أو اطلب من المدير إلغاءها ثم أغلق الوردية.</p>"
        '<p><span class="chip-count">3 مبيعات معلّقة على هذا الجهاز</span></p>'
        '<p><button type="button" class="btn">عرض مبيعاتي المعلّقة</button></p></div></div>'
    )
    panel = (
        '<section class="panel" aria-labelledby="sh-h"><div class="shift-panel">'
        '<h2 id="sh-h">إغلاق الوردية</h2>'
        '<p class="muted">عُدّ النقد في الدرج وأدخله. لا يظهر المبلغ المتوقع قبل تسجيل العدّ.</p>'
        '<label for="cnt" style="font-weight:600">النقد المعدود في الدرج</label>'
        '<input id="cnt" class="input" inputmode="decimal" autocomplete="off" value="2,450.00">'
        f"{alert}"
        '<div><button type="button" class="btn btn-primary focus">تسجيل العدّ وإغلاق الوردية</button></div>'
        "</div></section>"
    )
    return screen(head, panel, View(current=None))


STATES = [
    ("SaleReady", "شاشة البيع: تعليق البيع بجانب إلغاء البيع", s_sale_ready),
    ("SaleEmpty", "شاشة البيع بسلة فارغة: التعليق معطّل", s_sale_empty),
    ("ParkDialog", "تعليق البيع: الاسم اختياري", s_park_dialog),
    ("ParkLabel", "تعليق البيع باسم مكتوب", s_park_label),
    ("ParkInvalid", "اسم غير صالح (invalid_label)", s_park_invalid),
    ("ParkSaving", "جارٍ حفظ البيع قبل مسح الشاشة", s_park_saving),
    ("ParkLimit", "الحد الأقصى للمبيعات المعلّقة (park_limit_reached)", s_park_limit),
    ("Parked", "بعد التعليق: سلة فارغة وإشعار", s_parked),
    ("ListEmpty", "قائمة المبيعات المعلّقة: فارغة", s_list_empty),
    ("ListOne", "قائمة المبيعات المعلّقة: بيع واحد", s_list_one),
    ("ListFive", "قائمة المبيعات المعلّقة: خمسة", s_list_five),
    ("ListStale", "قائمة المبيعات المعلّقة: علامة «قديم»", s_list_stale),
    ("ReviewPrice", "مراجعة الاستئناف: تغيّر الأسعار", s_review_price),
    ("ReviewRemoved", "مراجعة الاستئناف: أصناف ستُحذف", s_review_removed),
    ("ReviewMixed", "مراجعة الاستئناف: أسعار وأصناف محذوفة", s_review_mixed),
    ("ConflictClean", "تعارض VN-R10: بلا تغييرات", s_conflict_clean),
    ("ConflictChanges", "تعارض VN-R10: مع تغييرات", s_conflict_changes),
    ("RefCatalogue", "رفض الاستئناف: الكتالوج غير متاح", s_ref_catalogue),
    ("RefChanged", "رفض الاستئناف: تغيّرت الأسعار", s_ref_changed),
    ("RefCheckout", "رفض الاستئناف: البيع الحالي في الدفع", s_ref_checkout),
    ("ShiftClose", "إغلاق الوردية مرفوض: مبيعات معلّقة", s_shift_close),
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python -I gen_pk3.py <PK3-Park-Resume folder>")
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"PK3-{key}-{w}.html").write_text(page(title, w, fn(w), f"PK3-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
