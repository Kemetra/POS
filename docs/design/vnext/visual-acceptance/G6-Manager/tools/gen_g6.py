"""Generate the RT-478 S10-R G-6 manager/admin surface references (FROZEN, owner-approved 2026-10-15).

Plan: docs/design/vnext/23-vn-s10-manager-surfaces-shell-retirement.md (owner-approved 2026-10-15,
D-10-1 ... D-10-8 as recommended). Same frame and generator pattern as G-3 (gen_g3.py, RT-251).

Every surface keeps the behaviour it has on main@91d080ef. Nothing here adds data, a call or a
capability; English stubs and «Coming soon» become honest Arabic states.

Usage: python -I gen_g6.py   (writes into this script's parent folder, G6-Manager/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

TERMINAL = "POS-03"
MANAGER = "سارة عبد الحميد"
CASHIER = "منى عبد الرحمن"
SALE_NO = "TERM-01-2026-10-15-000042"

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

ROLE_AR = {"manager": "مدير", "cashier": "كاشير"}  # shared/operator/role.ts

ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "retry": '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "users": '<circle cx="9" cy="9" r="3.5"/><path d="M3 19c.8-3.3 3.2-5 6-5s5.2 1.7 6 5"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7M18 14c1.6.6 2.6 2.4 3 5"/>',
    "pause": '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    "stop": '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 12h6"/>',
    "search": '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FROZEN · RT-478 G-6 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g6.css">
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
    """How the frame around a screen is drawn: the current nav entry, the sub-heading, the
    signed-in role, and whether the whole background is inert behind a dialog."""

    current: str | None
    sub: str = ""
    role: str = "manager"
    inert: bool = False


def aria_current(key: str, view: View) -> str:
    return ' aria-current="page"' if key == view.current else ""


def nav(view: View) -> str:
    i = " inert" if view.inert else ""
    who = MANAGER if view.role == "manager" else CASHIER
    entries = [e for e in NAV if view.role != "cashier" or e[0] in CASHIER_NAV]
    links = "".join(
        f'<li><a href="#"{aria_current(key, view)}>{label}</a></li>'
        for key, label in entries
    )
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{i}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{who}</b><span>{ROLE_AR[view.role]}</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def head(title: str, sub: str = "") -> str:
    s = f'<p class="sub">{sub}</p>' if sub else ""
    return f'<div class="screen-head"><h1>{title}</h1>{s}</div>'


def screen(title: str, content: str, view: View) -> str:
    i = " inert" if view.inert else ""
    return f'<main class="screen"{i}>{head(title, view.sub)}{content}</main>{nav(view)}'


NOTICE = {"success": ("ok", "status"), "neutral": ("info", "status"), "warning": ("warn", "alert")}


def notice(kind: str, text: str, action: str = "") -> str:
    glyph, role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role}">{icon(glyph)}<p>{text}</p>{action}</div>'


def panel(title: str, body: str, hid: str, hug: bool = False) -> str:
    # A list panel fills the height (its rows scroll); a form panel hugs its content.
    cls = "panel hug" if hug else "panel"
    return (
        f'<section class="{cls}" aria-labelledby="{hid}">'
        f'<div class="panel-head"><h2 id="{hid}">{title}</h2></div>{body}</section>'
    )


def page_state(*items: str) -> str:
    return '<div class="page-state">' + "".join(items) + "</div>"


# ── manager home ─────────────────────────────────────────────────────
def tile(glyph: str, title: str, text: str, focus: bool = False) -> str:
    f = " focus" if focus else ""
    return (
        f'<li><a class="tile{f}" href="#"><span class="glyph">{icon(glyph)}</span>'
        f"<b>{title}</b><span>{text}</span></a></li>"
    )


SHIFT_TILE = ("clock", "حالة الوردية", "حالة وردية هذا الجهاز.")
HOME_TILES = [
    ("users", "إدارة الكاشير", "الرقم السري لكل كاشير على هذا الجهاز."),
    ("pause", "المبيعات المعلقة", "دفع معلّق، أو مبيعات محفوظة لموظفين آخرين."),
    ("stop", "الورديات العالقة", "ورديات بقيت مفتوحة ويجب إغلاقها."),
]


def tiles(items: list[tuple[str, str, str]]) -> str:
    return '<ul class="tiles">' + "".join(tile(*t, focus=i == 0) for i, t in enumerate(items)) + "</ul>"


def state_home(w: int) -> str:
    return screen("لوحة المتابعة", tiles([SHIFT_TILE, *HOME_TILES]), View("dashboard"))


def state_home_no_shift(w: int) -> str:
    # POS_PULSE_FEATURE_SHIFT_CASHUP off: ShiftManagerLink renders nothing, so no shift card.
    return screen("لوحة المتابعة", tiles(HOME_TILES), View("dashboard"))


def state_cashier_refused(w: int) -> str:
    back = '<button type="button" class="btn btn-primary focus">العودة إلى البيع</button>'
    body = page_state(notice("neutral", "لوحة المتابعة متاحة للمدير فقط.", back))
    return screen("لوحة المتابعة", body, View(None, role="cashier"))


# ── sales: find a sale and reprint its receipt ───────────────────────
def lookup_form(value: str = "", focus: bool = True, hid: str = "find") -> str:
    f = " focus" if focus else ""
    return (
        '<form class="lookup" novalidate>'
        f'<div class="field"><label for="{hid}-no">رقم البيع</label>'
        f'<input id="{hid}-no" class="input code{f}" type="text" autocomplete="off" value="{value}"></div>'
        '<button type="submit" class="btn btn-primary">بحث</button>'
        "</form>"
    )


def sale_result(feedback: str = "") -> str:
    return (
        '<div class="result">'
        f'<p class="ref"><bdi class="ltr">{SALE_NO}</bdi></p>'
        f'<p class="meta"><bdi>{CASHIER}</bdi> · <bdi class="ltr">{TERMINAL}</bdi></p>'
        '<div class="buttons">'
        '<button type="button" class="btn">معاينة الإيصال</button>'
        '<button type="button" class="btn">إعادة طباعة الإيصال</button>'
        "</div>"
        f"{feedback}</div>"
    )


def sales(body_extra: str = "", value: str = "", focus: bool = True) -> str:
    body = f'<div class="panel-body">{lookup_form(value, focus)}{body_extra}</div>'
    return screen("المبيعات", panel("البحث عن بيع", body, "find-h", hug=True), View("sales"))


def state_sales(w: int) -> str:
    return sales()


def state_sales_found(w: int) -> str:
    return sales(sale_result(), SALE_NO, focus=False)


def state_sales_not_found(w: int) -> str:
    return sales(notice("neutral", "لم يُعثر على بيع بهذا الرقم."), "TERM-01-2026-10-15-000999")


def state_sales_reprint_sent(w: int) -> str:
    # "Sent to the printer", never "printed": OS print cannot prove paper (N-09).
    return sales(sale_result(notice("neutral", "أُرسل الإيصال للطابعة.")), SALE_NO, focus=False)


def state_sales_reprint_failed(w: int) -> str:
    fail = notice("warning", "تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.")
    return sales(sale_result(fail), SALE_NO, focus=False)


# ── returns: the RT-15 screen, unchanged, inside the frame ───────────
# FRAME PLACEMENT ONLY. The content is a stand-in for the shipped ReturnsScreen (returns.css);
# S10-4 keeps the shipped content and copy and must not restyle it to match this drawing.
def state_returns(w: int) -> str:
    look = panel("البحث عن بيع", f'<div class="panel-body">{lookup_form(hid="ret")}</div>', "ret-h", hug=True)
    hist = panel(
        "سجل المرتجعات على هذا الجهاز",
        f'<div class="panel-body">{notice("neutral", "لا توجد مرتجعات مسجَّلة على هذا الجهاز.")}</div>',
        "hist-h",
        hug=True,
    )
    return screen("المرتجعات", look + hist, View("returns"))


# ── honest pages ─────────────────────────────────────────────────────
def state_audit(w: int) -> str:
    return screen("سجل المراجعة", page_state(notice("neutral", "سجل المراجعة لا يُعرض على هذا الجهاز.")), View("audit"))


def state_inventory(w: int) -> str:
    body = page_state(
        notice("neutral", "إدارة المخزون غير متاحة على هذا الجهاز."),
        '<ul class="tiles">'
        + tile("search", "فحص الكتالوج", "حالة كتالوج الأصناف على هذا الجهاز، والبحث فيه.", focus=True)
        + "</ul>",
    )
    return screen("المخزون", body, View("inventory"))


def state_settings(w: int) -> str:
    return screen("الإعدادات", page_state(notice("neutral", "لا توجد إعدادات يمكن تغييرها على هذا الجهاز.")), View("settings"))


def state_diagnostics(w: int) -> str:
    device = (
        '<div class="panel-body"><dl class="facts">'
        '<dt>المستأجر</dt><dd class="id ltr">7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77</dd>'
        '<dt>الفرع</dt><dd class="id ltr">b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13</dd>'
        '<dt>الجهاز</dt><dd class="id ltr">0556bfa4-2c7e-4d19-b3a8-91f0e6d2c450</dd>'
        f'<dt>اسم الجهاز</dt><dd><bdi class="ltr">{TERMINAL}</bdi></dd>'
        "</dl></div>"
    )
    sync = (
        '<div class="panel-body"><dl class="facts">'
        '<dt>آخر تحديث</dt><dd><time class="num" datetime="2026-10-15T09:42">2026-10-15 09:42</time></dd>'
        "</dl>"
        '<div><button type="button" class="btn">تحديث الآن</button></div></div>'
    )
    counts = (
        '<div class="panel-body"><dl class="facts">'
        '<dt>الأصناف</dt><dd class="num">12,480</dd>'
        '<dt>الباركود والأسماء البديلة</dt><dd class="num">15,902</dd>'
        "</dl></div>"
    )
    search = (
        '<div class="panel-body">'
        '<div class="field"><label for="cat-q">ابحث بالاسم أو الباركود</label>'
        '<input id="cat-q" class="input focus" type="search" autocomplete="off" value="بنادول"></div>'
        '<p role="status"><span class="num">12</span> نتيجة</p></div>'
    )
    grid = (
        '<div class="grid-2">'
        + panel("هذا الجهاز", device, "dev-h")
        + panel("مزامنة الكتالوج", sync, "sync-h")
        + panel("البيانات المحلية", counts, "cnt-h")
        + panel("بحث في الكتالوج المحلي", search, "q-h")
        + "</div>"
    )
    return screen("فحص الكتالوج", grid, View("inventory", sub="للقراءة فقط. لا يغيّر شيئًا في الكتالوج."))


# ── stuck shifts / forced close ──────────────────────────────────────
SHIFTS = [
    ("أحمد سمير", "POS-01", "3 ساعات و10 دقائق"),
    ("ياسمين خالد", "POS-03", "ساعة و5 دقائق"),
    ("عبد الرحمن مصطفى السيد عبد الفتاح الشناوي", "POS-02", "45 دقيقة"),
]

REASONS = [
    ("takeover_supersession", "دخل موظف آخر على الجهاز"),
    ("cashier_no_show", "الكاشير غير موجود"),
    ("cashier_illness", "الكاشير مريض"),
    ("terminal_failure", "عطل في الجهاز"),
    ("other", "سبب آخر"),
]

STUCK_SUB = "وردية بقيت مفتوحة لكاشير لم يُغلقها. لا تُعرض أي مبالغ."


def shift_row(name: str, terminal: str, since: str, focus: bool = False) -> str:
    f = " focus" if focus else ""
    return (
        '<li class="row shift">'
        f'<span class="initial" aria-hidden="true">{name[0]}</span>'
        f'<span class="name"><bdi>{name}</bdi></span>'
        f'<span class="terminal ltr">{terminal}</span>'
        f'<span class="since">مفتوحة منذ {since}</span>'
        f'<button type="button" class="btn{f}">إغلاق الوردية</button>'
        "</li>"
    )


def shift_list(focus_index: int | None = 0) -> str:
    rows = "".join(shift_row(*s, focus=i == focus_index) for i, s in enumerate(SHIFTS))
    return panel("الورديات المفتوحة", f'<ul class="rows" aria-labelledby="open-h">{rows}</ul>', "open-h")


def stuck(content: str, inert: bool = False) -> str:
    return screen("الورديات العالقة", content, View("dashboard", sub=STUCK_SUB, inert=inert))


# The dialog's phases, all on main's behaviour (StuckShiftSurface / ForcedCloseForm):
#   open    — nothing chosen, confirm disabled, focus on the first reason (first safe control)
#   chosen  — a reason chosen, confirm enabled
#   changed — refused with state_invalid: main refetches the list, so the copy may say so
#   failed  — any other refusal: no refetch, so the copy must not claim one
CLOSE_PHASES = {
    "open": (None, 0, ""),
    "chosen": (1, 1, ""),
    "changed": (1, None, "تغيّرت حالة هذه الوردية. تم تحديث القائمة."),
    "failed": (1, None, "تعذّر إغلاق هذه الوردية. حاول مرة أخرى."),
}


def focus_class(i: int, focused: int | None) -> str:
    return ' class="focus"' if i == focused else ""


def close_dialog(phase: str) -> str:
    name = SHIFTS[0][0]
    checked, focused, text = CLOSE_PHASES[phase]
    choices = "".join(
        f'<label class="choice{" checked" if i == checked else ""}">'
        f'<input type="radio" name="reason" value="{key}"{" checked" if i == checked else ""}'
        f'{focus_class(i, focused)}>{label}</label>'
        for i, (key, label) in enumerate(REASONS)
    )
    msg = notice("warning", text) if text else ""
    confirm_disabled = " disabled" if checked is None else ""
    cancel_focus = " focus" if focused is None else ""
    return (
        '<div class="scrim">'
        '<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="fc-h">'
        f'<h2 id="fc-h">إغلاق وردية <bdi>{name}</bdi></h2>'
        "<form novalidate>"
        f'<fieldset class="choices"><legend>السبب</legend>{choices}</fieldset>'
        '<div class="field"><label for="fc-note">ملاحظة (اختياري)</label>'
        '<textarea id="fc-note" class="textarea" maxlength="500"></textarea></div>'
        f'<div class="slot" role="status" aria-live="polite">{msg}</div>'
        '<div class="dialog-actions">'
        f'<button type="button" class="btn{cancel_focus}">إلغاء</button>'
        f'<button type="submit" class="btn btn-danger"{confirm_disabled}>إغلاق الوردية</button>'
        "</div></form></div></div>"
    )


def state_stuck_list(w: int) -> str:
    return stuck(shift_list())


def state_stuck_open(w: int) -> str:
    return stuck(shift_list(None), inert=True) + close_dialog("open")


def state_stuck_confirm(w: int) -> str:
    return stuck(shift_list(None), inert=True) + close_dialog("chosen")


def state_stuck_changed(w: int) -> str:
    return stuck(shift_list(None), inert=True) + close_dialog("changed")


def state_stuck_failed(w: int) -> str:
    return stuck(shift_list(None), inert=True) + close_dialog("failed")


def state_stuck_empty(w: int) -> str:
    return stuck(page_state(notice("neutral", "لا توجد ورديات عالقة.")))


def state_stuck_unreachable(w: int) -> str:
    retry = f'<button type="button" class="btn focus">{icon("retry")}إعادة المحاولة</button>'
    return stuck(page_state(notice("warning", "تعذّر تحميل الورديات العالقة. تحقق من الاتصال.", retry)))


# ── force-fail: the hidden route ─────────────────────────────────────
def state_force_fail(w: int) -> str:
    go = '<button type="button" class="btn focus">المبيعات المعلقة</button>'
    body = page_state(notice("neutral", "هذه الصفحة تُفتح من دفع معلّق فقط.", go))
    return screen("إنهاء دفع معلّق", body, View("dashboard"))


STATES = [
    ("Home", "لوحة المتابعة", state_home),
    ("HomeNoShift", "لوحة المتابعة بدون إدارة الوردية", state_home_no_shift),
    ("CashierRefused", "لوحة المتابعة لكاشير", state_cashier_refused),
    ("Sales", "البحث عن بيع", state_sales),
    ("SalesFound", "تم العثور على البيع", state_sales_found),
    ("SalesNotFound", "لم يُعثر على البيع", state_sales_not_found),
    ("SalesReprintSent", "أُرسل الإيصال للطابعة", state_sales_reprint_sent),
    ("SalesReprintFailed", "تعذّرت إعادة الطباعة", state_sales_reprint_failed),
    ("Returns", "المرتجعات داخل الإطار", state_returns),
    ("Audit", "سجل المراجعة", state_audit),
    ("Inventory", "المخزون", state_inventory),
    ("Diagnostics", "فحص الكتالوج", state_diagnostics),
    ("Settings", "الإعدادات", state_settings),
    ("StuckList", "الورديات العالقة", state_stuck_list),
    ("StuckOpen", "إغلاق وردية: لم يُختر سبب", state_stuck_open),
    ("StuckConfirm", "إغلاق وردية: السبب مختار", state_stuck_confirm),
    ("StuckChanged", "تغيّرت حالة الوردية", state_stuck_changed),
    ("StuckFailed", "تعذّر الإغلاق", state_stuck_failed),
    ("StuckEmpty", "لا توجد ورديات عالقة", state_stuck_empty),
    ("StuckUnreachable", "تعذّر تحميل الورديات", state_stuck_unreachable),
    ("ForceFail", "إنهاء دفع معلّق", state_force_fail),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"G6-{key}-{w}.html").write_text(page(title, w, fn(w), f"G6-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
