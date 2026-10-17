"""Generate compare.html (RT-660): each implementation capture beside its G6R reference.

Usage: python -I gen_compare.py   (writes ../compare.html; no path is taken from the command line)
"""

from __future__ import annotations

import sys
from pathlib import Path

STATES = [
    "LookupEmpty", "LookupBlank", "LookupNotFound", "LookupRefused", "LookupOffline",
    "Found", "SelectPicked", "SelectQuoting", "SelectRefused", "Quote",
    "OutcomeUnconfirmed", "OutcomeRefused", "OutcomeFailed", "OutcomeMayBeRecorded",
    "PayoutReady", "PayoutOpening", "PayoutPaid", "PayoutNoDrawer", "PayoutSlipFailed",
    "PayoutReprintFailed", "PayoutDrawerFailed", "PayoutDrawerUnknown", "PayoutConfirmManual",
    "PayoutInterrupted", "PayoutWait", "PayoutRefused", "PayoutUnknown",
    "HistoryEmpty", "HistoryRows", "HistoryReprintFailed", "HistoryFailed", "Disabled",
]
SIZES = {1024: 768, 1280: 800}
REF = "../../visual-acceptance/G6-Returns/captures"

STYLE = """
:root { color-scheme: light; --ink:#0f1d2e; --muted:#53647a; --line:#d8dfe7; --bg:#f7f9fa; }
body { margin:0; padding:16px; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
header { position:sticky; top:0; z-index:1; background:var(--bg); padding-block:8px; border-bottom:1px solid var(--line); }
label { margin-inline-end:16px; }
section { margin-block:24px; }
h2 { font-size:15px; margin:0 0 8px; }
.pair { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
figure { margin:0; }
figcaption { color:var(--muted); font-size:12px; }
img { width:100%; height:auto; border:1px solid var(--line); }
"""

SCRIPT = """
const w = document.getElementById('w'), m = document.getElementById('m');
function apply() {
  document.querySelectorAll('section[data-w]').forEach((s) => {
    s.hidden = (w.value !== 'all' && s.dataset.w !== w.value) || (m.value !== 'all' && s.dataset.m !== m.value);
  });
}
w.addEventListener('change', apply); m.addEventListener('change', apply);
"""


def pair(state: str, width: int, mode: str) -> str:
    height = SIZES[width]
    suffix = "-forced" if mode == "forced" else ""
    impl = f"rt660-{state}-{width}x{height}{suffix}.png"
    ref = f"{REF}/G6R-{state}-{width}-{mode}.png"
    return (
        f'<section data-w="{width}" data-m="{mode}"><h2>{state} · {width}×{height} · {mode}</h2>'
        '<div class="pair">'
        f'<figure><img src="{ref}" alt="G6R reference {state} {width} {mode}" loading="lazy">'
        "<figcaption>G6R reference (owner-approved, RT-660 Phase 1)</figcaption></figure>"
        f'<figure><img src="{impl}" alt="Implementation {state} {width} {mode}" loading="lazy">'
        "<figcaption>Implementation (#/dev/returns-proof)</figcaption></figure>"
        "</div></section>"
    )


def build() -> str:
    sections = "".join(pair(s, w, m) for s in STATES for w in SIZES for m in ("light", "forced"))
    return (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>RT-660 vs G6R references</title>\n<style>{STYLE}</style>\n</head>\n<body>\n"
        "<header><strong>RT-660 Returns content: implementation vs the G6R references</strong><br>"
        '<label>Width <select id="w"><option value="all">all</option><option>1024</option><option>1280</option></select></label>'
        '<label>Mode <select id="m"><option value="all">all</option><option value="light">light</option>'
        '<option value="forced">forced colours</option></select></label></header>\n'
        f"{sections}\n<script>{SCRIPT}</script>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_compare.py")
    out = Path(__file__).resolve().parent.parent / "compare.html"
    out.write_text(build(), encoding="utf-8")
    print(f"[OK] wrote {out.name} ({len(STATES) * 4} pairs)")


if __name__ == "__main__":
    main()
