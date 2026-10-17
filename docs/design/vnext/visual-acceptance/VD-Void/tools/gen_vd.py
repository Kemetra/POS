"""Generate the RT-654 «إلغاء بيع» (/app/void) reference HTML files (visual DRAFT, pending owner approval).

Behaviour authority: the shipped RT-530 screen on main (src/renderer/v5/void/VoidScreen.tsx,
VoidActionDialog.tsx) and its bridge contract (src/shared/sale-void/types.ts). Every Arabic string
is copied verbatim from src/renderer/v5/void/void-copy.ts; dates and amounts use the shipped
formatters' output (formatHumanDateTime, formatHumanMoney). Nothing here adds behaviour, data or
copy: the layout moves onto the owner-approved G-6 vocabulary (page header, panels, 44px controls,
the V5 dialog). Same frame and generator pattern as G-6 (gen_g6.py, RT-478) and PK-3 (RT-471).

Usage: python -I gen_vd.py   (writes into this script's parent folder, VD-Void/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

MANAGER = "سارة عبد الحميد"
CASHIER = "منى عبد الرحمن"

# The seven-entry nav contract (specs/003-pos-ui-shell/contracts/shell-routes.ts), in order.
# /app/void is not a nav entry, so no entry is current on this screen.
NAV = ["لوحة المتابعة", "نقطة البيع", "المبيعات", "المرتجعات", "سجل المراجعة", "المخزون", "الإعدادات"]

# ── copy: verbatim from src/renderer/v5/void/void-copy.ts ────────────
C = {
    "title": "إلغاء بيع",
    "lookupHeading": "البحث عن بيع",
    "numberLabel": "رقم البيع",
    "search": "بحث",
    "saleNumber": "رقم البيع",
    "soldAt": "وقت البيع",
    "seller": "البائع",
    "total": "إجمالي البيع",
    "cash": "نقدي في الدرج",
    "voidAction": "إلغاء هذا البيع",
    "sameDayHint": "يمكن إلغاء البيع في يوم بيعه فقط، وبتأكيد مدير آخر غيرك وغير بائع الفاتورة.",
    "dialogTitle": "تأكيد إلغاء البيع",
    "dialogBody": "يلزم مدير آخر، ليس أنت وليس بائع الفاتورة، ليؤكد الإلغاء برقمه السري. يخرج نقد هذا البيع من الدرج.",
    "managerLegend": "المدير المؤكِّد",
    "pinLabel": "الرقم السري للمدير",
    "approve": "تأكيد الإلغاء",
    "back": "رجوع",
    "noManagers": "لا يوجد مدير مفعّل لتأكيد الإلغاء على هذه الطرفية.",
    "requested": "سُجّل طلب الإلغاء. يُرسل تلقائيًا عند اتصال مُقدِّمه بالإنترنت.",
    "historyTitle": "طلبات الإلغاء",
    "noHistory": "لا توجد طلبات إلغاء.",
    "requestedAt": "وقت الطلب",
    "acknowledge": "تم الاطلاع",
}

REFUSAL = {
    "sale_not_found": "لا يوجد بيع بهذا الرقم على هذه الطرفية.",
    "not_same_day": "انتهى يوم هذا البيع، فلا يمكن إلغاؤه. استخدم المرتجعات.",
    "void_unavailable": "تعذّر تنفيذ الإجراء. حاول مرة أخرى.",
    "approval_unavailable": (
        "تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. "
        "يجب أن يؤكد مدير آخر."
    ),
    "void_self_approval": "رفض الخادم الإلغاء: المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. يلزم مدير آخر.",
}

STATE_LABEL = {
    "pending": "طلب الإلغاء بانتظار الإرسال",
    "unknown": "تعذّر تأكيد الإرسال، وستُعاد المحاولة تلقائيًا",
    "confirmed": "تم الإلغاء",
    "refused": "رُفض الإلغاء",
}


def waiting_message(waiting_for: str, requester: str) -> str:
    if waiting_for == "sale_sync":
        return "بانتظار مزامنة البيع مع الخادم"
    return f"بانتظار تسجيل دخول <bdi>{requester}</bdi> متصلًا لإرسال الإلغاء"


ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "retry": '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "gone": '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def money(minor: int) -> str:
    """formatHumanMoney: grouped thousands, two decimals, EGP after; an LTR tabular run."""
    major, cents = divmod(minor, 100)
    return f'<span class="num">{major:,}.{cents:02d} EGP</span>'


def code(text: str) -> str:
    return f'<span class="num">{text}</span>'


def when(iso: str, shown: str) -> str:
    """formatHumanDateTime output: an Arabic month in Dubai, Western digits, tabular."""
    return f'<time class="when" datetime="{iso}">{shown}</time>'


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-654 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="vd.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def nav(inert: bool) -> str:
    i = " inert" if inert else ""
    links = "".join(f'<li><a href="#">{label}</a></li>' for label in NAV)
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{i}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{MANAGER}</b><span>مدير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


NOTICE = {"success": ("ok", "status"), "neutral": ("info", "status"), "warning": ("warn", "alert")}


def notice(kind: str, text: str, action: str = "") -> str:
    glyph, role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role}">{icon(glyph)}<p>{text}</p>{action}</div>'


# ── data (fictional; no real sale, person or credential) ─────────────
@dataclass(frozen=True)
class Sale:
    number: str = "TERM-01-2026-10-17-000051"
    iso: str = "2026-10-17T10:58"
    shown: str = "17 أكتوبر، 10:58"
    seller: str = CASHIER
    total: int = 31250
    cash: int = 31250


SALE = Sale()
OLD_SALE = Sale(number="TERM-01-2026-10-16-000118", iso="2026-10-16T19:24", shown="16 أكتوبر، 19:24", total=8500, cash=8500)


@dataclass(frozen=True)
class Entry:
    number: str
    total: int
    iso: str
    shown: str
    state: str
    requester: str = MANAGER
    waiting: str | None = None
    refusal: str | None = None

    @property
    def attention(self) -> bool:
        return self.state == "refused"


JOURNAL = [
    Entry("TERM-01-2026-10-17-000049", 4500, "2026-10-17T11:42", "17 أكتوبر، 11:42", "pending", waiting="sale_sync"),
    Entry("TERM-01-2026-10-17-000047", 124000, "2026-10-17T11:20", "17 أكتوبر، 11:20", "pending", CASHIER, waiting="requester_sign_in"),
    Entry("TERM-01-2026-10-17-000039", 18750, "2026-10-17T10:05", "17 أكتوبر، 10:05", "unknown"),
    Entry("TERM-01-2026-10-17-000022", 4675, "2026-10-17T09:31", "17 أكتوبر، 09:31", "confirmed"),
]
REFUSED = Entry(
    "TERM-01-2026-10-17-000044", 19000, "2026-10-17T11:02", "17 أكتوبر، 11:02", "refused", refusal="void_self_approval"
)
APPROVERS = ["خالد منصور", "هبة الشافعي"]


# ── the screen ───────────────────────────────────────────────────────
def screen(content: str, top: str = "", inert: bool = False) -> str:
    i = " inert" if inert else ""
    head = f'<div class="screen-head"><h1>{C["title"]}</h1></div>'
    return f'<main class="screen"{i}>{head}{top}<div class="cols">{content}</div></main>{nav(inert)}'


def panel(title: str, body: str, hid: str, hug: bool = False) -> str:
    cls = "panel hug" if hug else "panel"
    return (
        f'<section class="{cls}" aria-labelledby="{hid}">'
        f'<div class="panel-head"><h2 id="{hid}">{title}</h2></div>{body}</section>'
    )


def lookup_form(value: str, focus: bool) -> str:
    f = " focus" if focus else ""
    return (
        '<form class="lookup" novalidate>'
        f'<div class="field"><label for="void-sale-number">{C["numberLabel"]}</label>'
        f'<input id="void-sale-number" class="input code{f}" type="text" dir="ltr" autocomplete="off" '
        f'spellcheck="false" maxlength="64" value="{value}"></div>'
        f'<button type="submit" class="btn btn-primary">{C["search"]}</button>'
        "</form>"
    )


def facts(sale: Sale) -> str:
    return (
        '<dl class="facts">'
        f'<dt>{C["saleNumber"]}</dt><dd>{code(sale.number)}</dd>'
        f'<dt>{C["soldAt"]}</dt><dd>{when(sale.iso, sale.shown)}</dd>'
        f'<dt>{C["seller"]}</dt><dd><bdi>{sale.seller}</bdi></dd>'
        f'<dt>{C["total"]}</dt><dd>{money(sale.total)}</dd>'
        f'<dt>{C["cash"]}</dt><dd>{money(sale.cash)}</dd>'
        "</dl>"
    )


def found(sale: Sale, ineligible: str | None = None, focus: bool = True) -> str:
    f = " focus" if focus else ""
    action = (
        f'<div class="buttons"><button type="button" class="btn btn-danger{f}">{C["voidAction"]}</button></div>'
        if ineligible is None
        else notice("warning", REFUSAL[ineligible])
    )
    return f'<div class="result" data-testid="void-sale">{facts(sale)}{action}</div>'


@dataclass(frozen=True)
class Lookup:
    """The lookup panel: what is typed, what came back, and whether the input holds focus."""

    value: str = ""
    result: str = ""
    focus: bool = True


def lookup_panel(lk: Lookup = Lookup()) -> str:
    below = lk.result or f'<p class="hint">{C["sameDayHint"]}</p>'
    body = f'<div class="panel-body">{lookup_form(lk.value, lk.focus)}{below}</div>'
    return panel(C["lookupHeading"], body, "void-lookup", hug=True)


STATUS = {
    "pending": ("status-none", "clock"),
    "unknown": ("status-none", "retry"),
    "confirmed": ("status-ready", "ok"),
    "refused": ("status-refused", "warn"),
}


def journal_row(e: Entry, focus: bool = False) -> str:
    tone, glyph = STATUS[e.state]
    att = " attention" if e.attention else ""
    parts = [
        f'<span class="ref num">{e.number}</span>',
        f'<span class="amt">{money(e.total)}</span>',
        f'<span class="status {tone} full">{icon(glyph)}{STATE_LABEL[e.state]}</span>',
        f'<p class="meta full">{C["requestedAt"]}: {when(e.iso, e.shown)}</p>',
    ]
    if e.waiting is not None:
        parts.append(f'<p class="waiting full">{icon("clock")}<span>{waiting_message(e.waiting, e.requester)}</span></p>')
    if e.refusal is not None:
        parts.append(f'<div class="full">{notice("warning", REFUSAL[e.refusal])}</div>')
    if e.attention:
        f = " focus" if focus else ""
        parts.append(f'<button type="button" class="btn ack full{f}">{C["acknowledge"]}</button>')
    return f'<li class="row jrow{att}" data-state="{e.state}">{"".join(parts)}</li>'


def journal_panel(entries: list[Entry] | None, focus_ack: bool = False) -> str:
    if entries is None:  # the list itself was refused
        body = f'<div class="panel-state">{notice("warning", REFUSAL["void_unavailable"])}</div>'
    elif not entries:
        body = f'<div class="panel-state">{notice("neutral", C["noHistory"])}</div>'
    else:
        rows = "".join(journal_row(e, focus_ack and i == 0) for i, e in enumerate(entries))
        body = f'<ul class="rows" tabindex="0" aria-labelledby="void-history">{rows}</ul>'
    return panel(C["historyTitle"], body, "void-history")


# ── the confirm dialog (V5 Dialog) ───────────────────────────────────
@dataclass(frozen=True)
class Confirm:
    """The dialog's phase: which manager is chosen, whether a PIN is typed, the refusal line."""

    chosen: int | None = None
    pin: bool = False
    error: str = ""
    managers: bool = True


def manager_choice(cf: Confirm) -> str:
    if not cf.managers:
        return f'<p>{C["noManagers"]}</p>'
    choices = "".join(
        f'<label class="choice{" checked" if i == cf.chosen else ""}">'
        f'<input type="radio" name="approver"{" checked" if i == cf.chosen else ""}><bdi>{name}</bdi></label>'
        for i, name in enumerate(APPROVERS)
    )
    return f'<fieldset class="choices"><legend>{C["managerLegend"]}</legend>{choices}</fieldset>'


def confirm_dialog(cf: Confirm = Confirm()) -> str:
    ready = cf.managers and cf.chosen is not None and cf.pin
    pin_value = ' value="1357"' if cf.pin else ""
    # Focus opens on «رجوع» (initialFocusRef); once a PIN is typed it sits in the PIN field.
    back_focus = "" if cf.pin else " focus"
    pin_focus = " focus" if cf.pin else ""
    msg = notice("warning", cf.error) if cf.error else ""
    return (
        '<div class="scrim">'
        '<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="vd-h">'
        f'<h2 id="vd-h">{C["dialogTitle"]}</h2>'
        f'<p class="summary">{code(SALE.number)}{money(SALE.total)}</p>'
        f'<p class="body">{C["dialogBody"]}</p>'
        "<form novalidate>"
        f"{manager_choice(cf)}"
        f'<div class="field"><label for="vd-pin">{C["pinLabel"]}</label>'
        f'<input id="vd-pin" class="input pin{pin_focus}" type="password" inputmode="numeric" '
        f'autocomplete="off" maxlength="8"{pin_value}></div>'
        f'<div class="slot" role="status" aria-live="polite">{msg}</div>'
        '<div class="dialog-actions">'
        f'<button type="button" class="btn{back_focus}">{C["back"]}</button>'
        f'<button type="button" class="btn btn-danger"{"" if ready else " disabled"}>{C["approve"]}</button>'
        "</div></form></div></div>"
    )


# ── states ───────────────────────────────────────────────────────────
FOUND = Lookup(SALE.number, found(SALE), focus=False)


def s_lookup(w: int) -> str:
    return screen(lookup_panel() + journal_panel([]))


def s_journal(w: int) -> str:
    return screen(lookup_panel() + journal_panel(JOURNAL))


def s_found(w: int) -> str:
    return screen(lookup_panel(FOUND) + journal_panel(JOURNAL))


def s_requested(w: int) -> str:
    done = notice("success", f'{C["requested"]} {waiting_message("sale_sync", MANAGER)}')
    first = Entry(SALE.number, SALE.total, "2026-10-17T11:48", "17 أكتوبر، 11:48", "pending", waiting="sale_sync")
    return screen(lookup_panel() + journal_panel([first, *JOURNAL]), top=done)


def s_ref_not_found(w: int) -> str:
    miss = Lookup("TERM-01-2026-10-17-000999", notice("warning", REFUSAL["sale_not_found"]))
    return screen(lookup_panel(miss) + journal_panel(JOURNAL))


def s_ref_ineligible(w: int) -> str:
    old = Lookup(OLD_SALE.number, found(OLD_SALE, "not_same_day"))
    return screen(lookup_panel(old) + journal_panel(JOURNAL))


def s_ref_journal(w: int) -> str:
    return screen(lookup_panel() + journal_panel(None))


def s_ref_server(w: int) -> str:
    return screen(lookup_panel(Lookup(focus=False)) + journal_panel([REFUSED, *JOURNAL], focus_ack=True))


def behind_dialog() -> str:
    return screen(lookup_panel(Lookup(SALE.number, found(SALE, focus=False), focus=False)) + journal_panel(JOURNAL), inert=True)


def s_dialog(w: int) -> str:
    return behind_dialog() + confirm_dialog()


def s_dialog_ready(w: int) -> str:
    return behind_dialog() + confirm_dialog(Confirm(chosen=0, pin=True))


def s_dialog_refused(w: int) -> str:
    # The PIN is cleared on the press (VoidActionDialog.press), so the refusal shows an empty PIN.
    return behind_dialog() + confirm_dialog(Confirm(chosen=0, error=REFUSAL["approval_unavailable"]))


def s_dialog_no_managers(w: int) -> str:
    return behind_dialog() + confirm_dialog(Confirm(managers=False))


STATES = [
    ("Lookup", "البحث عن بيع، ولا طلبات إلغاء", s_lookup),
    ("Journal", "طلبات الإلغاء: بانتظار الإرسال، تعذّر التأكيد، تم الإلغاء", s_journal),
    ("Found", "تم العثور على البيع: «إلغاء هذا البيع»", s_found),
    ("Requested", "سُجّل طلب الإلغاء", s_requested),
    ("RefNotFound", "رفض البحث: لا يوجد بيع بهذا الرقم", s_ref_not_found),
    ("RefIneligible", "البيع لا يُلغى: انتهى يومه", s_ref_ineligible),
    ("RefJournal", "تعذّر تحميل طلبات الإلغاء", s_ref_journal),
    ("RefServer", "رفض الخادم طلب إلغاء: «تم الاطلاع»", s_ref_server),
    ("Dialog", "تأكيد الإلغاء: لم يُختر مدير", s_dialog),
    ("DialogReady", "تأكيد الإلغاء: المدير والرقم السري", s_dialog_ready),
    ("DialogRefused", "تأكيد الإلغاء مرفوض", s_dialog_refused),
    ("DialogNoManagers", "لا يوجد مدير مفعّل للتأكيد", s_dialog_no_managers),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_vd.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"VD-{key}-{w}.html").write_text(page(title, w, fn(w), f"VD-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
