"""Generate the RT-659 G-6 addendum: the receipt preview inside /app/sales as a V5 Dialog (DRAFT).

The frame, the nav and the found-sale panel come from the frozen G-6 generator
(../../G6-Manager/tools/gen_g6.py, owner-approved 2026-10-15), so the screen behind the
dialog is the G-6 «SalesFound» state, made inert. Only the dialog is new.

The slip inside the dialog is the receipt engine's own HTML for the `preview` variant
(src/main/receipts/template-engine.ts on main@87238bc), rendered from a sample payload and
kept verbatim in tools/slip-preview.html. Receipt content and format are out of scope.

Two owner options for «طباعة» (RT-659):
  (a) the button is removed: the dialog has «إغلاق» only;
  (b) the button is wired to the existing `receipts.reprint` path, unchanged.
The loading and failed states are the same under both options.

Usage: python -I gen_g6p.py   (writes into this script's parent folder, G6P-Receipt-Preview/)
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path

sys.dont_write_bytecode = True

TOOLS = Path(__file__).resolve().parent


def load_g6():
    path = TOOLS.parent.parent / "G6-Manager" / "tools" / "gen_g6.py"
    spec = importlib.util.spec_from_file_location("gen_g6", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_g6"] = module  # dataclasses resolves its owner module by name
    spec.loader.exec_module(module)
    return module


G6 = load_g6()
SLIP = (TOOLS / "slip-preview.html").read_text(encoding="utf-8").strip()

# The shipped copy (ReceiptPreview.tsx and SALES_COPY on main); «مقترح» marks new text.
TITLE = "معاينة الإيصال"
LOADING = "جارٍ التحضير"
PREVIEW_FAILED = "تعذّرت معاينة الإيصال"
CLOSE = "إغلاق"
REPRINT = "إعادة طباعة الإيصال"
REPRINTING = "جارٍ إعادة الطباعة…"
SENT = "أُرسل الإيصال للطابعة."
REPRINT_FAILED = "تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى."
DUPLICATE_HINT = "تُطبع نسخة عليها «نسخة طبق الأصل»."  # مقترح (option b)


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-659 G-6 addendum · {title} · {width}×{height}</title>
<link rel="stylesheet" href="../G6-Manager/g6.css">
<link rel="stylesheet" href="g6p.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def sales_behind() -> str:
    """The G-6 SalesFound screen, inert behind the dialog."""
    body = f'<div class="panel-body">{G6.lookup_form(G6.SALE_NO, focus=False)}{G6.sale_result()}</div>'
    found = G6.panel("البحث عن بيع", body, "find-h", hug=True)
    return G6.screen("المبيعات", found, G6.View("sales", inert=True))


@dataclass(frozen=True)
class Phase:
    """What the dialog shows: the slip well's content, the reprint control (None = absent)
    and the reprint feedback under the actions."""

    well: str
    reprint: str | None = None
    feedback: str = ""


def well(content: str, slip: bool) -> str:
    # A scrollable region must be reachable by keyboard (axe scrollable-region-focusable).
    if slip:
        return (
            '<div class="well" role="region" aria-label="الإيصال" tabindex="0">'
            f'<div class="slip">{SLIP}</div></div>'
        )
    return f'<div class="well center">{content}</div>'


def actions(phase: Phase) -> str:
    reprint = ""
    if phase.reprint == "idle":
        reprint = f'<button type="button" class="btn">{REPRINT}</button>'
    elif phase.reprint == "busy":
        reprint = f'<button type="button" class="btn" disabled>{REPRINTING}</button>'
    hint = f'<p class="hint">{DUPLICATE_HINT}</p>' if phase.reprint is not None else ""
    # Initial focus is «إغلاق»: the safe control (DESIGN.md Dialog rule).
    return (
        f'{hint}<div class="slot" role="status" aria-live="polite">{phase.feedback}</div>'
        f'<div class="dialog-actions">{reprint}'
        f'<button type="button" class="btn btn-primary focus">{CLOSE}</button></div>'
    )


def dialog(phase: Phase) -> str:
    return (
        '<div class="scrim">'
        '<div class="dialog preview" role="dialog" aria-modal="true" aria-labelledby="rp-h" aria-describedby="rp-no">'
        f'<div class="preview-head"><h2 id="rp-h">{TITLE}</h2>'
        f'<p id="rp-no" class="hint"><bdi class="ltr">{G6.SALE_NO}</bdi></p></div>'
        f"{phase.well}{actions(phase)}"
        "</div></div>"
    )


def state(phase: Phase):
    return lambda w: sales_behind() + dialog(phase)


READY = well("", slip=True)
LOADING_WELL = well(f'<p class="muted" role="status">{LOADING}</p>', slip=False)
FAILED_WELL = well(G6.notice("warning", PREVIEW_FAILED), slip=False)

STATES = [
    ("Loading", "جارٍ تحضير المعاينة (الخياران)", state(Phase(LOADING_WELL))),
    ("Failed", "تعذّرت المعاينة (الخياران)", state(Phase(FAILED_WELL))),
    ("A-Ready", "الخيار (أ): المعاينة بلا طباعة", state(Phase(READY))),
    ("B-Ready", "الخيار (ب): المعاينة مع إعادة الطباعة", state(Phase(READY, "idle"))),
    ("B-Reprinting", "الخيار (ب): جارٍ إعادة الطباعة", state(Phase(READY, "busy"))),
    ("B-Sent", "الخيار (ب): أُرسل الإيصال للطابعة", state(Phase(READY, "idle", G6.notice("neutral", SENT)))),
    ("B-Failed", "الخيار (ب): تعذّرت إعادة الطباعة", state(Phase(READY, "idle", G6.notice("warning", REPRINT_FAILED)))),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6p.py")
    out = TOOLS.parent
    for key, title, fn in STATES:
        for w in (1024, 1280):
            (out / f"G6P-{key}-{w}.html").write_text(page(title, w, fn(w), f"G6P-{key}"), encoding="utf-8")
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
