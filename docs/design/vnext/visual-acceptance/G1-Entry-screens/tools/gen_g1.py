"""Generate the RT-246 G-1 entry-screen reference HTML files (FROZEN, owner-approved 2026-10-11).

Usage: python -I gen_g1.py <G1-Entry-screens folder>
"""

from __future__ import annotations

import sys
from pathlib import Path

TERMINAL = "POS-03"

ROSTER = [
    "منى عبد الرحمن",
    "أحمد سمير",
    "ياسمين خالد",
    "محمود عادل",
    "نورهان إبراهيم",
    "كريم فتحي",
]
ROSTER_LONG = ROSTER + [
    "عبد الرحمن مصطفى السيد عبد الفتاح الشناوي",
    "هدى محمد",
    "مصطفى جمال",
    "سلمى طارق",
    "إسلام حسن",
    "محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي",
    "عمرو وليد",
    "دينا سامح",
    "يوسف أشرف",
    "رحاب عصام",
    "شريف ماهر",
    "آية رضا",
]

ICONS = {
    "back": '<path d="M9 6l6 6-6 6"/>',
    "del": '<path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="M12 9l5 6M17 9l-5 6"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "alert": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.4v.01"/>',
    "key": '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>',
    "terminal": '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    "link": '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    "users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    "cart": '<path d="M3 4h2l2.4 11h11l2-8H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "gear": '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
}


def icon(name: str, cls: str = "icon") -> str:
    return f'<svg class="{cls}" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def initial(name: str) -> str:
    return name.strip()[0]


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FROZEN · RT-246 G-1 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g1.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def bar(signed_context: bool = True, role: str | None = None) -> str:
    ctx = ""
    if signed_context:
        # terminal_label is admin free text, not an id: <bdi>, body font. The branch name is
        # not shown: the renderer has no branch-name field on main (RT-244 decision).
        ctx = (
            '<span class="sep" aria-hidden="true"></span>'
            f'<span class="ctx">الجهاز <b><bdi>{TERMINAL}</bdi></b></span>'
        )
    if role:
        ctx += f'<span class="sep" aria-hidden="true"></span><span class="ctx">{role}</span>'
    return (
        '<header class="bar">'
        '<span class="mark ltr"><i aria-hidden="true"></i>POS Pulse</span>'
        f"{ctx}</header>"
    )


def roster_list(names: list[str], selected: int | None) -> str:
    items = []
    for i, n in enumerate(names):
        pressed = "true" if i == selected else "false"
        items.append(
            f'<li><button type="button" class="who" aria-pressed="{pressed}">'
            f'<span class="badge" aria-hidden="true">{initial(n)}</span>'
            f'<span class="who-name">{n}</span></button></li>'
        )
    return '<ul class="roster" aria-label="الكاشير في هذا الفرع">' + "".join(items) + "</ul>"


def roster_panel(content: str, manager_pressed: bool = False) -> str:
    pressed = "true" if manager_pressed else "false"
    return (
        '<section class="panel" aria-labelledby="roster-h">'
        '<div class="panel-head"><h2 id="roster-h">الكاشير في هذا الفرع</h2></div>'
        f"{content}"
        '<div class="panel-foot">'
        f'<button type="button" class="btn" aria-pressed="{pressed}">{icon("key")}دخول المدير</button>'
        "</div></section>"
    )


def keypad(disabled: bool) -> str:
    keys = [str(d) for d in range(1, 10)]
    dis = ' aria-disabled="true"' if disabled else ""
    tab = ' tabindex="-1"' if disabled else ""
    cells = "".join(f'<button type="button" class="key"{tab}>{k}</button>' for k in keys)
    cells += '<span class="key key-blank" aria-hidden="true"></span>'
    cells += f'<button type="button" class="key"{tab}>0</button>'
    cells += f'<button type="button" class="key" aria-label="حذف"{tab}>{icon("del")}</button>'
    return f'<div class="keypad" role="group" aria-label="لوحة الأرقام"{dis}>{cells}</div>'


def dots(filled: int, error: bool = False, focus: bool = True) -> str:
    spans = "".join(f'<span class="{"on" if i < filled else ""}"></span>' for i in range(6))
    cls = "dots" + (" err" if error else "") + (" focus" if focus else "")
    desc = ' aria-describedby="pin-feedback"' if error else ""
    return (
        f'<div class="{cls}" role="textbox" aria-label="الرقم السري، أُدخل {filled} من 6"'
        f' tabindex="0"{desc}>{spans}</div>'
    )


def auth_waiting(prompt: str = "اختر اسمك من القائمة لإدخال الرقم السري.") -> str:
    return (
        '<aside class="panel auth" aria-labelledby="auth-h">'
        '<div class="panel-head"><h2 id="auth-h">الرقم السري</h2></div>'
        '<div class="auth-body">'
        f'<p class="prompt">{prompt}</p>'
        '<div class="feedback"></div>'
        f"{keypad(disabled=True)}"
        '<div class="auth-actions"><button type="button" class="btn btn-primary commit" disabled>دخول</button></div>'
        "</div></aside>"
    )


def auth_pin(name: str, filled: int, feedback: str = "", error: bool = False) -> str:
    commit_disabled = "" if filled >= 4 else " disabled"
    return (
        '<aside class="panel auth" aria-labelledby="auth-h">'
        '<div class="panel-head">'
        '<div class="auth-who">'
        f'<span class="badge" aria-hidden="true">{initial(name)}</span>'
        f'<div style="min-inline-size:0"><h2 id="auth-h">{name}</h2><span class="meta">الكاشير</span></div>'
        "</div>"
        f'<button type="button" class="btn btn-ghost">{icon("back")}رجوع</button>'
        "</div>"
        '<div class="auth-body">'
        f"{dots(filled, error=error)}"
        f'<div class="feedback" id="pin-feedback" role="status" aria-live="polite">{feedback}</div>'
        f"{keypad(disabled=False)}"
        f'<div class="auth-actions"><button type="button" class="btn btn-primary commit"{commit_disabled}>دخول</button></div>'
        "</div></aside>"
    )


def auth_manager() -> str:
    return (
        '<aside class="panel auth" aria-labelledby="auth-h">'
        '<div class="panel-head">'
        '<div class="auth-who"><h2 id="auth-h">دخول المدير</h2></div>'
        f'<button type="button" class="btn btn-ghost">{icon("back")}رجوع</button>'
        "</div>"
        '<form class="auth-body" novalidate>'
        '<div class="field"><label for="m-id">البريد الإلكتروني أو اسم المستخدم</label>'
        '<input id="m-id" class="input ltr focus" dir="ltr" type="text" value="sara.manager" autocomplete="username"></div>'
        '<div class="field"><label for="m-pw">كلمة المرور</label>'
        '<input id="m-pw" class="input ltr pw" dir="ltr" type="password" value="password12" autocomplete="current-password"></div>'
        '<div class="feedback" role="status" aria-live="polite"></div>'
        '<div class="auth-actions"><button type="submit" class="btn btn-primary commit">تسجيل الدخول</button></div>'
        "</form></aside>"
    )


def signin_stage(roster_html: str, auth_html: str) -> str:
    return (
        bar()
        + '<main class="stage">'
        '<div class="stage-head"><h1>تسجيل الدخول</h1><p>كل عمليات الوردية تُسجَّل باسمك.</p></div>'
        f"{roster_html}{auth_html}</main>"
    )


def danger(text: str) -> str:
    return f'<p class="notice notice-danger" role="alert">{icon("alert")}{text}</p>'


def state_roster(w: int) -> str:
    return signin_stage(roster_panel(roster_list(ROSTER, None)), auth_waiting())


def state_roster_long(w: int) -> str:
    return signin_stage(roster_panel(roster_list(ROSTER_LONG, 13)), auth_pin(ROSTER_LONG[13], 2))


def state_manager(w: int) -> str:
    return signin_stage(roster_panel(roster_list(ROSTER, None), manager_pressed=True), auth_manager())


def state_pin(w: int) -> str:
    return signin_stage(roster_panel(roster_list(ROSTER, 2)), auth_pin(ROSTER[2], 4))


def state_wrong_pin(w: int) -> str:
    return signin_stage(
        roster_panel(roster_list(ROSTER, 2)),
        auth_pin(ROSTER[2], 0, danger("بيانات الدخول غير صحيحة. حاول مرة أخرى."), error=True),
    )


def state_lockout(w: int) -> str:
    return signin_stage(
        roster_panel(roster_list(ROSTER, 2)),
        auth_pin(ROSTER[2], 0, danger("محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى."), error=True),
    )


def state_unreachable(w: int) -> str:
    # no_connection only. Another roster refusal shows «تعذّر تحميل قائمة الكاشير.» in the same slot.
    notice = (
        '<div class="roster-empty">'
        f'<p class="notice notice-warning" role="alert">{icon("warn")}'
        "تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.</p></div>"
    )
    return signin_stage(roster_panel(notice), auth_waiting("لا يمكن إدخال الرقم السري قبل تحميل القائمة."))


def state_roster_empty(w: int) -> str:
    # The roster loaded and holds no cashier: a fact, not a fault (neutral, not warning).
    notice = (
        '<div class="roster-empty">'
        f'<p class="notice notice-neutral" role="status">{icon("users")}'
        "لا يوجد كاشير مسجّل في هذا الفرع.</p></div>"
    )
    return signin_stage(
        roster_panel(notice), auth_waiting("الدخول بالرقم السري يحتاج كاشيرًا مسجّلًا في هذا الفرع.")
    )


def state_ready(w: int) -> str:
    return (
        bar(signed_context=False)
        + '<main class="center"><section class="card" aria-labelledby="ready-h">'
        f'<span class="card-icon">{icon("terminal")}</span>'
        '<h1 id="ready-h">الجهاز مرتبط وجاهز.</h1>'
        f'<dl class="facts"><dt>الجهاز</dt><dd><bdi>{TERMINAL}</bdi></dd></dl>'
        '<button type="button" class="btn btn-primary commit focus">متابعة</button>'
        "</section></main>"
    )


def state_pairing(w: int) -> str:
    return (
        bar(signed_context=False)
        + '<main class="center"><form class="card" aria-labelledby="pair-h" novalidate>'
        f'<span class="card-icon">{icon("link")}</span>'
        '<div style="display:grid;gap:4px"><h1 id="pair-h">ربط الجهاز</h1>'
        '<p id="pair-hint">أدخل رمز الربط الظاهر في لوحة الإدارة.</p></div>'
        '<div class="field"><label for="pair-code">رمز الربط</label>'
        '<input id="pair-code" class="input code-input focus" dir="ltr" type="text" value="K7Q2-9XMP"'
        ' autocomplete="off" spellcheck="false" aria-describedby="pair-hint pair-status"></div>'
        '<p class="slot" id="pair-status" role="status"></p>'
        '<button type="submit" class="btn btn-primary commit">ربط الجهاز</button>'
        "</form></main>"
    )


def state_reauth(w: int) -> str:
    nav = (
        '<nav class="nav" aria-label="التنقل">'
        f'<a href="#">{icon("cart")}البيع</a>'
        f'<a href="#">{icon("clock")}الوردية</a>'
        f'<a href="#" aria-current="page">{icon("users")}الكاشير</a>'
        f'<a href="#">{icon("gear")}الإعدادات</a>'
        "</nav>"
    )
    rows = "".join(
        f'<li><span class="badge" aria-hidden="true">{initial(n)}</span><span>{n}</span>'
        '<button type="button" class="btn">تعيين أول رقم سري</button></li>'
        for n in ROSTER[:4]
    )
    notice = (
        f'<div class="notice notice-warning notice-action" role="alert">{icon("warn")}'
        '<p>انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.</p>'
        '<button type="button" class="btn btn-primary">تسجيل الدخول</button></div>'
    )
    work = (
        f'<section class="work" inert><h1>الكاشير</h1><ul class="rows">{rows}</ul>{notice}</section>'
    )
    dialog = (
        '<div class="scrim">'
        '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="reauth-h">'
        '<h2 id="reauth-h">تسجيل الدخول مرة أخرى</h2>'
        '<form novalidate>'
        '<p>المدير: <bdi>سارة عبد الحميد</bdi></p>'
        '<div class="fields">'
        '<label for="r-id">البريد الإلكتروني أو اسم المستخدم</label>'
        '<input id="r-id" class="input ltr focus" dir="ltr" type="text" value="" autocomplete="username">'
        '<label for="r-pw">كلمة المرور</label>'
        '<input id="r-pw" class="input ltr" dir="ltr" type="password" value="" autocomplete="current-password">'
        "</div>"
        '<div role="status" aria-live="polite"></div>'
        '<div class="dialog-actions">'
        '<button type="button" class="btn">إلغاء</button>'
        '<button type="submit" class="btn btn-primary">تسجيل الدخول</button>'
        "</div></form></div></div>"
    )
    return (
        bar(role="المدير: <b>سارة عبد الحميد</b>")
        + f'<div class="app">{nav}{work}</div>{dialog}'
    )


STATES = [
    ("Roster", "قائمة الكاشير", state_roster),
    ("RosterLong", "قائمة طويلة، والرقم السري ظاهر", state_roster_long),
    ("Manager", "دخول المدير", state_manager),
    ("Pin", "إدخال الرقم السري", state_pin),
    ("WrongPin", "رقم سري غير صحيح", state_wrong_pin),
    ("Lockout", "محاولات كثيرة", state_lockout),
    ("Unreachable", "تعذّر تحميل القائمة", state_unreachable),
    ("RosterEmpty", "لا يوجد كاشير مسجّل", state_roster_empty),
    ("Ready", "الجهاز مرتبط وجاهز", state_ready),
    ("Pairing", "ربط الجهاز", state_pairing),
    ("Reauth", "تسجيل دخول المدير مرة أخرى", state_reauth),
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python -I gen_g1.py <G1-Entry-screens folder>")
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"G1-{key}-{w}.html").write_text(
                page(title, w, fn(w), f"G1-{key}"), encoding="utf-8"
            )
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
