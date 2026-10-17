"""Generate the RT-656 manager held-sales recovery references (visual DRAFT, pending owner approval).

Behaviour authority: RT-441 on main (src/renderer/v5/recovery/: RecoveryScreen, RecoveryActionDialog,
recovery-actions, recovery-copy) and its dev harness `#/dev/recovery-proof` (RecoveryProof.tsx), whose
seeded views (typical, recovery, long, empty, refused) and bridge answers (approver ok / none /
locked, approval ok / wrong_pin) are the data drawn here. The frame and page header are G-6
(gen_g6.py, RT-478). Every string is RECOVERY_COPY verbatim; none is new.

Usage: python -I gen_rc.py   (writes into this script's parent folder, RC-Recovery/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

MANAGER = "سارة عبد الحميد"
TITLE = "المبيعات المعلقة"

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

# RECOVERY_COPY (src/renderer/v5/recovery/recovery-copy.ts), verbatim.
C = {
    "recoveryMode": "دخلت لإنهاء دفع معلّق على هذه الطرفية. لا يمكن البيع حتى يُكمَل الدفع أو يُلغى.",
    "loading": "جارٍ التحميل…",
    "stuckTitle": "دفع معلّق",
    "noneStuck": "لا يوجد دفع معلّق على هذه الطرفية.",
    "heldTitle": "مبيعات محفوظة لموظفين آخرين",
    "noneHeld": "لا توجد مبيعات محفوظة لموظفين آخرين.",
    "owner": "الموظف",
    "someoneElse": "موظف آخر",
    "lines": "عدد الأصناف",
    "total": "الإجمالي",
    "cash": "نقدي مدفوع",
    "card": "بطاقة مدفوعة",
    "voucher": "قسيمة مستخدمة",
    "remaining": "المتبقي",
    "draft": "مسودة",
    "handedOff": "في الدفع",
    "parked": "معلّقة",
    "complete": "إكمال البيع",
    "cancelPayment": "إلغاء الدفع",
    "cancelSale": "إلغاء البيع",
    "cashReceived": "النقدية المستلمة للمتبقي",
    "confirmCash": "أرجعتُ النقدية المدفوعة للعميل",
    "confirmCard": "ألغيتُ دفع البطاقة على جهاز البطاقة",
    "approvalBody": "أدخل رقمك السري لتأكيد هذا الإجراء.",
    "pinLabel": "الرقم السري",
    "approve": "تأكيد",
    "back": "رجوع",
    "noPin": "لا يوجد لك رقم سري مدير مفعّل على هذه الطرفية. سجّله من شاشة الوردية، ثم عُد.",
    "completed": "اكتمل البيع.",
    "change": "الباقي للعميل",
    "cancelledPayment": "أُلغي الدفع وسُجّل الإرجاع.",
    "cancelledSale": "أُلغي البيع المحفوظ.",
    "unavailable": "تعذّر تنفيذ الإجراء. حاول مرة أخرى.",
    # recoveryRefusalMessage(): the reasons the harness can produce.
    "role_mismatch": "هذه الشاشة للمدير فقط.",
    "session_locked": "الجهاز مقفل.",
    "approval_unavailable": "الرقم السري غير صحيح أو غير مفعّل.",
}

ICONS = {
    "cross": '<path d="M12 5v14M5 12h14"/>',
    "warn": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
    "ok": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    "cash": '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
    "pause": '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    "dash": '<path d="M7 12h10"/>',
}


def icon(name: str) -> str:
    return f'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def money(minor: int) -> str:
    """formatHumanMoney: grouped major, two decimals, «EGP», LTR-isolated tabular figures."""
    major, cents = divmod(minor, 100)
    return f'<bdi class="num">{major:,}.{cents:02d} EGP</bdi>'


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-656 RC · {title} · {width}×{height}</title>
<link rel="stylesheet" href="rc.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


# ── the G-6 frame ────────────────────────────────────────────────────
def nav(inert: bool) -> str:
    # Reached from the dashboard card, so «لوحة المتابعة» is current (as G-6 draws stuck shifts).
    i = " inert" if inert else ""
    links = "".join(
        f'<li><a href="#"{" aria-current=\"page\"" if key == "dashboard" else ""}>{label}</a></li>'
        for key, label in NAV
    )
    return (
        f'<nav class="nav" aria-label="التنقل الرئيسي"{i}>'
        f'<div class="brand"><i aria-hidden="true">{icon("cross")}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{MANAGER}</b><span>مدير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def screen(content: str, inert: bool = False) -> str:
    i = " inert" if inert else ""
    head = f'<div class="screen-head"><h1 id="recovery-title">{TITLE}</h1></div>'
    return f'<main class="screen" aria-labelledby="recovery-title"{i}>{head}{content}</main>{nav(inert)}'


NOTICE = {"success": ("ok", "status"), "neutral": ("info", "status"), "warning": ("warn", "alert")}


def notice(kind: str, text: str, role: str = "") -> str:
    glyph, default_role = NOTICE[kind]
    return f'<div class="notice notice-{kind}" role="{role or default_role}">{icon(glyph)}<p>{text}</p></div>'


def panel(title: str, glyph: str, body: str, hid: str) -> str:
    return (
        f'<section class="panel rc-{hid}" aria-labelledby="{hid}">'
        f'<div class="panel-head"><span class="rc-glyph">{icon(glyph)}</span><h2 id="{hid}">{title}</h2></div>'
        f"{body}</section>"
    )


def empty(text: str) -> str:
    return f'<div class="panel-body"><p class="rc-empty">{icon("dash")}{text}</p></div>'


# ── data: RecoveryProof.tsx seeds, resolved through the roster ──────
@dataclass(frozen=True)
class Stuck:
    owner: str = "أحمد سمير"
    lines: int = 4
    total: int = 15_000
    cash: int = 5_000
    card: int = 0
    voucher: int = 0
    remaining: int = 10_000


TYPICAL_STUCK = Stuck()
RECOVERY_STUCK = Stuck(card=7_000, voucher=900, remaining=2_100)


@dataclass(frozen=True)
class Held:
    owner: str
    kind: str = "draft"
    parked: bool = False
    lines: int = 3
    total: int = 4_250


LONG_1 = "عبد الرحمن مصطفى السيد عبد الفتاح الشناوي"
LONG_2 = "محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي"

TYPICAL_HELD = [
    Held("منى عبد الرحمن"),
    Held("ياسمين خالد", kind="handed_off", lines=7, total=31_975),
    Held("كريم فتحي", parked=True, lines=1, total=1_200),
    Held(C["someoneElse"], lines=2, total=890),  # op-gone: not on the roster
]
LONG_HELD = [
    Held(LONG_1, parked=True, lines=12, total=128_450),
    Held(LONG_2, kind="handed_off", lines=3, total=9_900),
    *TYPICAL_HELD,
    Held("نورهان إبراهيم", lines=5, total=2_340),
    Held(LONG_1, kind="handed_off", parked=True, total=75_000),
    Held("أحمد سمير", lines=9, total=18_000),
]


# ── the stuck payment ───────────────────────────────────────────────
def fact(label: str, value: str, cls: str = "") -> str:
    c = f"rc-fact {cls}".strip()
    return f'<div class="{c}"><dt>{label}</dt><dd>{value}</dd></div>'


def stuck_facts(s: Stuck) -> str:
    # Totals and live tender only: a zero tender line is never shown.
    tender = [(C["cash"], s.cash), (C["card"], s.card), (C["voucher"], s.voucher)]
    return (
        '<dl class="rc-facts">'
        + fact(C["owner"], f'<bdi class="rc-name">{s.owner}</bdi>', "rc-fact--lead")
        + fact(C["lines"], f'<bdi class="num">{s.lines}</bdi>')
        + fact(C["total"], money(s.total))
        + "".join(fact(label, money(v)) for label, v in tender if v > 0)
        + fact(C["remaining"], money(s.remaining), "rc-fact--due")
        + "</dl>"
    )


def stuck_panel(s: Stuck | None) -> str:
    if s is None:
        return panel(C["stuckTitle"], "cash", empty(C["noneStuck"]), "recovery-stuck")
    actions = (
        '<div class="rc-actions">'
        f'<button type="button" class="btn btn-primary">{C["complete"]}</button>'
        f'<button type="button" class="btn">{C["cancelPayment"]}</button>'
        "</div>"
    )
    return panel(C["stuckTitle"], "cash", f'<div class="panel-body">{stuck_facts(s)}{actions}</div>', "recovery-stuck")


# ── the held sales ──────────────────────────────────────────────────
def tags(h: Held) -> str:
    kind = C["draft"] if h.kind == "draft" else C["handedOff"]
    parked = f'<span class="status status-none">{C["parked"]}</span>' if h.parked else ""
    return f'<span class="rc-tags"><span class="status status-none">{kind}</span>{parked}</span>'


def held_row(h: Held) -> str:
    return (
        '<li class="row rc-held">'
        f'<span class="initial" aria-hidden="true">{h.owner[0]}</span>'
        f'<span class="rc-who"><span class="name"><bdi>{h.owner}</bdi></span>{tags(h)}</span>'
        f'<span class="rc-sum">{money(h.total)}<span>{C["lines"]} <bdi class="num">{h.lines}</bdi></span></span>'
        f'<button type="button" class="btn">{C["cancelSale"]}</button>'
        "</li>"
    )


def held_panel(held: list[Held]) -> str:
    if not held:
        return panel(C["heldTitle"], "pause", empty(C["noneHeld"]), "recovery-held")
    rows = "".join(held_row(h) for h in held)
    return panel(C["heldTitle"], "pause", f'<ul class="rows">{rows}</ul>', "recovery-held")


# ── the page ────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Page:
    """What the screen shows: the stuck payment, the held sales, and any line above them."""

    stuck: Stuck | None
    held: list[Held]
    recovery_mode: bool = False
    outcome: str = ""


def body(p: Page) -> str:
    above = notice("neutral", C["recoveryMode"], role="note") if p.recovery_mode else ""
    if p.outcome:
        above = notice("success", p.outcome) + above
    return f'{above}<div class="rc-grid">{stuck_panel(p.stuck)}{held_panel(p.held)}</div>'


def page_state(item: str) -> str:
    return f'<div class="page-state">{item}</div>'


TYPICAL = Page(TYPICAL_STUCK, TYPICAL_HELD)
RECOVERY = Page(RECOVERY_STUCK, [], recovery_mode=True)


# ── the action dialog (RecoveryActionDialog) ────────────────────────
@dataclass(frozen=True)
class Dialog:
    """One action's dialog: what it asks for besides the PIN, and the approver read."""

    title: str
    extras: str = ""
    approver: str = "ok"  # ok | none | locked
    pin: str = ""
    error: str = ""
    ready: bool = False
    focus: str = "back"  # back | pin


def pin_field(d: Dialog) -> str:
    f = " focus" if d.focus == "pin" else ""
    return (
        '<div class="fields">'
        f'<p>{C["approvalBody"]}</p>'
        f'<div class="field"><label for="rc-pin">{C["pinLabel"]} — <bdi>{MANAGER}</bdi></label>'
        f'<input id="rc-pin" class="input pin{f}" type="password" inputmode="numeric" autocomplete="off" maxlength="8" value="{d.pin}"></div>'
        "</div>"
    )


APPROVER_REFUSAL = {"none": C["noPin"], "locked": C["session_locked"]}


def dialog(d: Dialog) -> str:
    approver = notice("warning", APPROVER_REFUSAL[d.approver]) if d.approver in APPROVER_REFUSAL else pin_field(d)
    slot = f'<div class="slot">{notice("warning", d.error) if d.error else ""}</div>'
    back_focus = " focus" if d.focus == "back" else ""
    disabled = "" if d.ready else " disabled"
    return (
        '<div class="scrim">'
        '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rc-dlg">'
        f'<h2 id="rc-dlg">{d.title}</h2>'
        f"{d.extras}{approver}{slot}"
        '<div class="dialog-actions">'
        f'<button type="button" class="btn{back_focus}">{C["back"]}</button>'
        f'<button type="button" class="btn btn-primary"{disabled}>{C["approve"]}</button>'
        "</div></div></div>"
    )


def cash_field(s: Stuck, value: str = "") -> str:
    return (
        '<div class="fields">'
        f'<p>{C["remaining"]}: {money(s.remaining)}</p>'
        f'<div class="field"><label for="rc-cash">{C["cashReceived"]}</label>'
        f'<input id="rc-cash" class="input code" inputmode="decimal" autocomplete="off" value="{value}"></div>'
        "</div>"
    )


def confirms(s: Stuck, checked: bool = False) -> str:
    c = " checked" if checked else ""
    rows = []
    if s.cash > 0:
        rows.append(f'<label class="choice{c}"><input type="checkbox"{c}><span>{C["confirmCash"]} ({money(s.cash)})</span></label>')
    if s.card > 0:
        rows.append(f'<label class="choice{c}"><input type="checkbox"{c}><span>{C["confirmCard"]}</span></label>')
    return f'<fieldset class="choices rc-confirms">{"".join(rows)}</fieldset>'


def with_dialog(p: Page, d: Dialog) -> str:
    return screen(body(p), inert=True) + dialog(d)


# ── states ──────────────────────────────────────────────────────────
def state_typical(w: int) -> str:
    return screen(body(TYPICAL))


def state_recovery_mode(w: int) -> str:
    return screen(body(RECOVERY))


def state_long(w: int) -> str:
    return screen(body(Page(None, LONG_HELD)))


def state_empty(w: int) -> str:
    return screen(body(Page(None, [])))


def state_loading(w: int) -> str:
    return screen(page_state(notice("neutral", C["loading"])))


def state_refused(w: int) -> str:
    return screen(page_state(notice("warning", C["role_mismatch"])))


def state_unavailable(w: int) -> str:
    # listHeld threw: recoveryRefusalMessage('recovery_unavailable').
    return screen(page_state(notice("warning", C["unavailable"])))


def state_complete(w: int) -> str:
    return with_dialog(TYPICAL, Dialog(C["complete"], extras=cash_field(TYPICAL_STUCK)))


def state_complete_ready(w: int) -> str:
    d = Dialog(C["complete"], extras=cash_field(TYPICAL_STUCK, "150"), pin="123456", ready=True, focus="pin")
    return with_dialog(TYPICAL, d)


def state_cancel_payment(w: int) -> str:
    return with_dialog(RECOVERY, Dialog(C["cancelPayment"], extras=confirms(RECOVERY_STUCK)))


def state_cancel_payment_ready(w: int) -> str:
    d = Dialog(C["cancelPayment"], extras=confirms(RECOVERY_STUCK, checked=True), pin="123456", ready=True, focus="pin")
    return with_dialog(RECOVERY, d)


def state_cancel_sale(w: int) -> str:
    return with_dialog(TYPICAL, Dialog(C["cancelSale"]))


def state_wrong_pin(w: int) -> str:
    return with_dialog(TYPICAL, Dialog(C["cancelSale"], error=C["approval_unavailable"], focus="pin"))


def state_no_pin(w: int) -> str:
    return with_dialog(TYPICAL, Dialog(C["cancelSale"], approver="none"))


def state_approver_locked(w: int) -> str:
    return with_dialog(TYPICAL, Dialog(C["cancelSale"], approver="locked"))


def state_completed(w: int) -> str:
    # The harness answers change = cash received − remaining: 150.00 − 100.00.
    outcome = f'{C["completed"]} {C["change"]}: {money(5_000)}'
    return screen(body(Page(None, TYPICAL_HELD, outcome=outcome)))


def state_cancelled_payment(w: int) -> str:
    return screen(body(Page(None, TYPICAL_HELD, outcome=C["cancelledPayment"])))


def state_cancelled_sale(w: int) -> str:
    return screen(body(Page(TYPICAL_STUCK, TYPICAL_HELD[1:], outcome=C["cancelledSale"])))


STATES = [
    ("Typical", "دفع معلّق ومبيعات محفوظة", state_typical),
    ("RecoveryMode", "وضع الاستعادة", state_recovery_mode),
    ("Long", "قائمة طويلة وأسماء طويلة", state_long),
    ("Empty", "لا شيء معلّق", state_empty),
    ("Loading", "جارٍ التحميل", state_loading),
    ("Refused", "مرفوض: ليست شاشة المدير", state_refused),
    ("Unavailable", "تعذّر تحميل القائمة", state_unavailable),
    ("Complete", "إكمال البيع: النافذة", state_complete),
    ("CompleteReady", "إكمال البيع: جاهز للتأكيد", state_complete_ready),
    ("CancelPayment", "إلغاء الدفع: النافذة", state_cancel_payment),
    ("CancelPaymentReady", "إلغاء الدفع: جاهز للتأكيد", state_cancel_payment_ready),
    ("CancelSale", "إلغاء بيع محفوظ: النافذة", state_cancel_sale),
    ("WrongPin", "رقم سري غير صحيح", state_wrong_pin),
    ("NoPin", "لا يوجد رقم سري مدير", state_no_pin),
    ("ApproverLocked", "الجهاز مقفل أثناء التأكيد", state_approver_locked),
    ("Completed", "اكتمل البيع", state_completed),
    ("CancelledPayment", "أُلغي الدفع", state_cancelled_payment),
    ("CancelledSale", "أُلغي البيع المحفوظ", state_cancelled_sale),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_rc.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"RC-{key}-{w}.html").write_text(page(title, w, fn(w), f"RC-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
