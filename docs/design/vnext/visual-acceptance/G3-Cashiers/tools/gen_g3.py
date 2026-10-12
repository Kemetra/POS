"""Generate the RT-251 G-3 Manager -> Cashiers reference HTML files (FROZEN, owner-approved 2026-10-12).

Brief: docs/design/vnext/19-d-m1-cashier-pin-status.md (owner-approved D1, D3, D4 on 2026-10-12).

Usage: python -I gen_g3.py <G3-Cashiers folder>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TERMINAL = "POS-03"
MANAGER = "سارة عبد الحميد"
LOCK_UNTIL = "14:35"

# (name, state): state is one of no_pin | ready | locked
CASHIERS = [
    ("منى عبد الرحمن", "ready"),
    ("أحمد سمير", "no_pin"),
    ("ياسمين خالد", "locked"),
    ("محمود عادل", "ready"),
    ("نورهان إبراهيم", "no_pin"),
    ("كريم فتحي", "ready"),
]
CASHIERS_LONG = CASHIERS + [
    ("عبد الرحمن مصطفى السيد عبد الفتاح الشناوي", "ready"),
    ("هدى محمد", "ready"),
    ("مصطفى جمال", "no_pin"),
    ("سلمى طارق", "ready"),
    ("إسلام حسن", "locked"),
    ("محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي", "ready"),
    ("عمرو وليد", "ready"),
    ("دينا سامح", "no_pin"),
    ("يوسف أشرف", "ready"),
    ("رحاب عصام", "ready"),
    ("شريف ماهر", "ready"),
    ("آية رضا", "no_pin"),
]

NAV = ["لوحة المتابعة", "نقطة البيع", "المبيعات", "المرتجعات", "سجل المراجعة", "المخزون", "الإعدادات"]

ICONS = {
    "check": '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    "lock": '<path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
    "dash": '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "retry": '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    "cross": '<path d="M12 5v14M5 12h14"/>',
}

STATUS = {
    "no_pin": ("status-none", "dash", "بدون رقم سري"),
    "ready": ("status-ready", "check", "جاهز"),
    "locked": ("status-locked", "lock", "مقفل"),
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def initial(name: str) -> str:
    return name.strip()[0]


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FROZEN · RT-251 G-3 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g3.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def nav() -> str:
    # The Cashiers screen has no nav entry on main (it opens from the Dashboard link), so no
    # entry is current here: the reference shows main as it is.
    links = "".join(f'<li><a href="#">{label}</a></li>' for label in NAV)
    return (
        '<nav class="nav" aria-label="التنقل الرئيسي">'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{MANAGER}</b><span>المدير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def status(state: str) -> str:
    cls, glyph, label = STATUS[state]
    until = ""
    if state == "locked":
        until = f' <time class="ltr" datetime="2026-10-12T{LOCK_UNTIL}">حتى {LOCK_UNTIL}</time>'
    return f'<span class="status {cls}">{icon(glyph)}{label}{until}</span>'


def actions(name: str, state: str, focus: bool = False) -> str:
    # Two fixed slots, so every row's actions line up: the state's own action first (nearest the
    # status), then «تغيير الرقم السري» (D1) for a cashier who already has a PIN.
    f = " focus" if focus else ""
    primary = {
        "no_pin": f'<button type="button" class="btn{f}">تعيين أول رقم سري</button>',
        "locked": f'<button type="button" class="btn{f}">فك القفل</button>',
        "ready": "",
    }[state]
    secondary = (
        '<button type="button" class="btn btn-ghost">تغيير الرقم السري</button>' if state != "no_pin" else ""
    )
    return (
        '<div class="actions">'
        f'<div class="act-primary">{primary}</div><div class="act-secondary">{secondary}</div>'
        "</div>"
    )


def row(name: str, state: str, focus: bool = False) -> str:
    return (
        '<li class="row">'
        f'<span class="initial" aria-hidden="true">{initial(name)}</span>'
        f'<span class="name"><bdi>{name}</bdi></span>'
        f"{status(state)}"
        f"{actions(name, state, focus)}"
        "</li>"
    )


def head() -> str:
    return (
        '<div class="screen-head"><h1>إدارة الكاشير</h1>'
        f'<p>الرقم السري لكل كاشير على الجهاز <b><bdi>{TERMINAL}</bdi></b></p></div>'
    )


def panel(body: str, count: int | None = None) -> str:
    c = f'<span class="count">{count} كاشير</span>' if count is not None else ""
    return (
        '<section class="panel" aria-labelledby="list-h">'
        f'<div class="panel-head"><h2 id="list-h">الكاشير في هذا الفرع</h2>{c}</div>'
        f"{body}</section>"
    )


def rows(items: list[tuple[str, str]], focus_index: int | None = None) -> str:
    return (
        '<ul class="rows" aria-labelledby="list-h">'
        + "".join(row(n, s, i == focus_index) for i, (n, s) in enumerate(items))
        + "</ul>"
    )


def screen(content: str, notice: str = "", inert: bool = False) -> str:
    i = " inert" if inert else ""
    return f'<main class="screen"{i}>{head()}{notice}{content}</main>{nav()}'


# Each tone has its own glyph and live-region role: warnings interrupt, the rest are polite.
NOTICE = {
    "success": ("ok", "status"),
    "neutral": ("info", "status"),
    "warning": ("warn", "alert"),
}


def notice(kind: str, text: str, action: str = "") -> str:
    glyph, role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role}">{icon(glyph)}<p>{text}</p>{action}</div>'


PIN_RE = re.compile(r"^\d{4,6}$")  # the cashier rule (pin-management.ts PIN_RE)

# The dialog's phases: (first field, confirmation, focused field). «حفظ» is enabled only when
# both fields hold 4–6 digits and match (brief §4); a mismatch clears both and refocuses the first.
PIN_PHASES = {
    "typing": ("1234", "123", 2),
    "complete": ("1234", "1234", 2),
    "mismatch": ("", "", 1),
}


def pin_dialog(title: str, phase: str) -> str:
    first, second, focused = PIN_PHASES[phase]
    mismatch = phase == "mismatch"
    inv = ' aria-invalid="true" aria-describedby="pin-hint pin-msg"' if mismatch else ' aria-describedby="pin-hint"'
    msg = (
        '<span class="notice notice-warning" role="alert">'
        f'{icon("warn")}<p>الرقمان غير متطابقين.</p></span>'
        if mismatch
        else ""
    )
    ready = bool(PIN_RE.match(first)) and first == second
    save_disabled = "" if ready else " disabled"
    return (
        '<div class="scrim">'
        '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pin-h">'
        f'<h2 id="pin-h">{title}</h2>'
        '<form novalidate>'
        '<p class="hint" id="pin-hint">من 4 إلى 6 أرقام.</p>'
        '<div class="fields">'
        '<div class="field"><label for="pin-1">الرقم السري الجديد</label>'
        f'<input id="pin-1" class="input pin{" focus" if focused == 1 else ""}" type="password" inputmode="numeric"'
        f' autocomplete="off" value="{first}"{inv}></div>'
        '<div class="field"><label for="pin-2">تأكيد الرقم السري</label>'
        f'<input id="pin-2" class="input pin{" focus" if focused == 2 else ""}" type="password" inputmode="numeric"'
        f' autocomplete="off" value="{second}"{inv}></div>'
        "</div>"
        f'<div class="slot" id="pin-msg" role="status" aria-live="polite">{msg}</div>'
        '<div class="dialog-actions">'
        '<button type="button" class="btn">إلغاء</button>'
        f'<button type="submit" class="btn btn-primary"{save_disabled}>حفظ</button>'
        "</div></form></div></div>"
    )


# ── states ───────────────────────────────────────────────────────────
def state_list(w: int) -> str:
    return screen(panel(rows(CASHIERS, focus_index=1), len(CASHIERS)))


def state_list_long(w: int) -> str:
    return screen(panel(rows(CASHIERS_LONG), len(CASHIERS_LONG)))


def state_first_pin(w: int) -> str:
    return screen(panel(rows(CASHIERS), len(CASHIERS)), inert=True) + pin_dialog(
        f"تعيين أول رقم سري لـ <bdi>{CASHIERS[1][0]}</bdi>", "typing"
    )


def state_mismatch(w: int) -> str:
    return screen(panel(rows(CASHIERS), len(CASHIERS)), inert=True) + pin_dialog(
        f"تعيين أول رقم سري لـ <bdi>{CASHIERS[1][0]}</bdi>", "mismatch"
    )


def state_change_pin(w: int) -> str:
    return screen(panel(rows(CASHIERS), len(CASHIERS)), inert=True) + pin_dialog(
        f"تغيير الرقم السري لـ <bdi>{CASHIERS[0][0]}</bdi>", "complete"
    )


def state_set_done(w: int) -> str:
    items = [(n, "ready" if i == 1 else s) for i, (n, s) in enumerate(CASHIERS)]
    done = notice("success", f"تم تعيين الرقم السري لـ <bdi>{CASHIERS[1][0]}</bdi>.")
    return screen(panel(rows(items), len(items)), notice=done)


def state_unlock_done(w: int) -> str:
    items = [(n, "ready" if i == 2 else s) for i, (n, s) in enumerate(CASHIERS)]
    done = notice("success", f"تم فك القفل عن <bdi>{CASHIERS[2][0]}</bdi>.")
    return screen(panel(rows(items), len(items)), notice=done)


def state_unreachable(w: int) -> str:
    retry = f'<button type="button" class="btn focus">{icon("retry")}إعادة المحاولة</button>'
    body = (
        '<div class="panel-state">'
        + notice("warning", "تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.", retry)
        + "</div>"
    )
    return screen(panel(body))


def state_empty(w: int) -> str:
    body = (
        '<div class="panel-state">'
        + notice("neutral", "لا يوجد كاشير مسجّل في هذا الفرع.")
        + "</div>"
    )
    return screen(panel(body, 0))


def state_reauth(w: int) -> str:
    # M6 (RT-247): provision found the manager's sign-in expired. The shipped re-auth notice sits
    # above the list, and the shipped re-auth dialog (G1-Reauth) opens from «تسجيل الدخول».
    action = '<button type="button" class="btn btn-primary focus">تسجيل الدخول</button>'
    expired = notice("warning", "انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.", action)
    return screen(panel(rows(CASHIERS), len(CASHIERS)), notice=expired)


STATES = [
    ("List", "قائمة الكاشير وحالة الرقم السري", state_list),
    ("ListLong", "قائمة طويلة", state_list_long),
    ("FirstPin", "تعيين أول رقم سري", state_first_pin),
    ("Mismatch", "الرقمان غير متطابقين", state_mismatch),
    ("ChangePin", "تغيير الرقم السري", state_change_pin),
    ("SetDone", "تم تعيين الرقم السري", state_set_done),
    ("UnlockDone", "تم فك القفل", state_unlock_done),
    ("Unreachable", "تعذّر تحميل القائمة", state_unreachable),
    ("Empty", "لا يوجد كاشير مسجّل", state_empty),
    ("Reauth", "انتهت جلسة الدخول", state_reauth),
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python -I gen_g3.py <G3-Cashiers folder>")
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"G3-{key}-{w}.html").write_text(
                page(title, w, fn(w), f"G3-{key}"), encoding="utf-8"
            )
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
