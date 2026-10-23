"""Generate the RT-859 G-6 Diagnostics addendum: the catalogue check lists the matched items.

Visual DRAFT, pending owner approval. Same frame and generator pattern as G-6 (gen_g6.py, RT-478):
the frozen g6.css is imported unchanged through g6c.css, and the three other diagnostics panels
are drawn exactly as G6-Diagnostics draws them.

Behaviour authority: POS main@be087a4f. Each row draws only fields `catalogue.search` returns
there: `display_name_ar`, `unit_pack_label`, `sku` and `price_minor`. A search row never carries
`selling_barcode` (product-repo.ts search() calls toSnapshot(r) with no barcode), so no row here
shows a barcode. Product strings are the shipped Diagnostics copy (diagnostics-copy.ts) plus two
shipped sale-search strings (LiveSearchResults.tsx). Product names, SKUs and prices are sample
data only.

Usage: python -I gen_g6c.py   (writes into this script's parent folder, G6-Catalogue-check/)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

TERMINAL = "POS-03"
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

CROSS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'

# Shipped copy: src/renderer/v5/manager/diagnostics/diagnostics-copy.ts (DIAGNOSTICS_COPY).
TITLE = "فحص الكتالوج"
SUB = "للقراءة فقط. لا يغيّر شيئًا في الكتالوج."
SEARCH_HEADING = "بحث في الكتالوج المحلي"
SEARCH_LABEL = "ابحث بالاسم أو الباركود"
NONE = "لا توجد نتائج"
UNAVAILABLE = "غير متاح"
# Shipped sale-search copy: src/renderer/v5/sale/LiveSearchResults.tsx.
LIST_LABEL = "نتائج البحث"
LIMITED = "النتائج محدودة؛ عدّل البحث لتضييقها."


@dataclass(frozen=True)
class Hit:
    """One `ProductSnapshotDisplay` as search returns it: no `selling_barcode`, ever."""

    name_ar: str
    pack: str | None
    sku: str
    price_minor: int


# Name search «بنادول»: five hits. The first row is the dev seed product (dev-seed-catalogue.ts).
# The barcode query in BarcodeQuery matches it only on read-down data, where D-BARCODE puts every
# aliases[] entry (barcodes included) into alias_fold; the dev seed folds its aliases only.
PANADOL = [
    Hit("بنادول إكسترا", "×20 أقراص", "PARA-500", 1500),
    Hit("بنادول أدفانس", "×24 قرص", "PARA-ADV-500", 4250),
    Hit("بنادول شراب للأطفال", "زجاجة ١٠٠ مل", "PARA-SYR-100", 3175),
    Hit("بنادول كولد آند فلو", "×24 قرص", "PARA-CF-24", 5800),
    Hit("بنادول نايت لتسكين الآلام الليلية مع المساعدة على النوم", "×20 قرص", "PARA-NIGHT-20", 6600),
]

# Name search «فيتامين»: more than 20 match, search returns the first 20 and `truncated: true`.
VITAMINS = [
    Hit("فيتامين أ ٥٠٠٠٠ وحدة", "×20 كبسولة", "VITA-50K", 3600),
    Hit("فيتامين ب المركب", "×20 قرص", "VITB-CPLX", 2150),
    Hit("فيتامين ب١٢ أمبول", "×3 أمبول", "VITB12-AMP", 4800),
    Hit("فيتامين ب١٢ أقراص للمضغ", "×30 قرص", "VITB12-CHW", 5500),
    Hit("فيتامين د٣ ٥٠٠٠ وحدة", "×30 كبسولة", "VITD3-5K", 9900),
    Hit("فيتامين د٣ ١٠٠٠ وحدة", "×30 قرص", "VITD3-1K", 6250),
    Hit("فيتامين د٣ نقط للأطفال", "زجاجة ١٥ مل", "VITD3-DRP", 7400),
    Hit("فيتامين سي ١٠٠٠", "×20 فوار", "VITC-1000", 1800),
    Hit("فيتامين سي ٥٠٠ للمضغ", "×30 قرص", "VITC-500C", 2400),
    Hit("فيتامين سي مع الزنك", "×20 فوار", "VITC-ZN", 3150),
    Hit("فيتامين سي شراب للأطفال", "زجاجة ١٢٠ مل", "VITC-SYR", 2900),
    Hit("فيتامين هـ ٤٠٠ وحدة", "×30 كبسولة", "VITE-400", 5200),
    Hit("فيتامين هـ ١٠٠٠ وحدة", "×30 كبسولة", "VITE-1000", 8700),
    Hit("فيتامين ك نقط", "زجاجة ١٠ مل", "VITK-DRP", 4600),
    Hit("فيتامينات متعددة للحامل", "×30 قرص", "MVIT-PRG", 12500),
    Hit("فيتامينات متعددة للأطفال", "×60 قرص للمضغ", "MVIT-KID", 9800),
    Hit("فيتامينات متعددة للرجال", "×30 قرص", "MVIT-MEN", 11000),
    Hit("فيتامينات متعددة للنساء", "×30 قرص", "MVIT-WMN", 11000),
    Hit("فيتامينات متعددة فوق الخمسين", "×30 قرص", "MVIT-50P", 13250),
    Hit("فيتامينات الشعر والأظافر", "×30 كبسولة", "MVIT-HAIR", 14900),
]


def money(minor: int) -> str:
    """formatHumanMoney (src/renderer/ui/format/human-format.ts): grouped major, 2-digit minor, EGP."""
    major, cents = divmod(minor, 100)
    return f"{major:,}.{cents:02d} EGP"


def plural_results(n: int) -> str:
    """SEARCH_RESULT_FORMS through pluralAr: 1, 2, 3–10, 11–99 (the counts these frames use)."""
    if n == 1:
        return "نتيجة واحدة"
    if n == 2:
        return "نتيجتان"
    word = "نتائج" if 3 <= n % 100 <= 10 else "نتيجة"
    return f'<span class="num">{n}</span> {word}'


def page(title: str, width: int, body: str, label: str) -> str:
    height = 800 if width == 1280 else 768
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT · RT-859 G-6 · {title} · {width}×{height}</title>
<link rel="stylesheet" href="g6c.css">
</head>
<body>
<div class="rt w{width}" data-ref="{label}" data-w="{width}">
{body}
</div>
</body>
</html>
"""


def nav() -> str:
    links = "".join(
        f'<li><a href="#"{" aria-current=\"page\"" if key == "inventory" else ""}>{text}</a></li>'
        for key, text in NAV
    )
    return (
        '<nav class="nav" aria-label="التنقل الرئيسي">'
        f'<div class="brand"><i aria-hidden="true">{CROSS}</i><span class="ltr">POS Pulse</span></div>'
        f'<ul class="links">{links}</ul>'
        f'<div class="operator"><b>{MANAGER}</b><span>مدير</span>'
        '<button type="button">تسجيل الخروج</button></div>'
        "</nav>"
    )


def panel(title: str, body: str, hid: str, cls: str = "panel") -> str:
    return (
        f'<section class="{cls}" aria-labelledby="{hid}">'
        f'<div class="panel-head"><h2 id="{hid}">{title}</h2></div>{body}</section>'
    )


# The three other panels, exactly as G6-Diagnostics draws them (gen_g6.py state_diagnostics).
DEVICE = (
    '<div class="panel-body"><dl class="facts">'
    '<dt>المستأجر</dt><dd class="id ltr">7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77</dd>'
    '<dt>الفرع</dt><dd class="id ltr">b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13</dd>'
    '<dt>الجهاز</dt><dd class="id ltr">0556bfa4-2c7e-4d19-b3a8-91f0e6d2c450</dd>'
    f'<dt>اسم الجهاز</dt><dd><bdi class="ltr">{TERMINAL}</bdi></dd>'
    "</dl></div>"
)
SYNC = (
    '<div class="panel-body"><dl class="facts">'
    '<dt>آخر تحديث</dt><dd><time class="num" datetime="2026-10-15T09:42">2026-10-15 09:42</time></dd>'
    "</dl>"
    '<div><button type="button" class="btn">تحديث الآن</button></div></div>'
)
COUNTS = (
    '<div class="panel-body"><dl class="facts">'
    '<dt>الأصناف</dt><dd class="num">12,480</dd>'
    '<dt>الباركود والأسماء البديلة</dt><dd class="num">15,902</dd>'
    "</dl></div>"
)


def hit_row(h: Hit) -> str:
    pack = f"<span>{h.pack}</span>" if h.pack else ""
    return (
        '<li class="row hit"><div class="hit-copy">'
        f'<span class="name">{h.name_ar}</span>'
        f'<span class="meta">{pack}<bdi class="code" dir="ltr">{h.sku}</bdi></span>'
        f'</div><span class="money">{money(h.price_minor)}</span></li>'
    )


@dataclass(frozen=True)
class Search:
    """What the search panel shows: the typed query, the status line, the hits and `truncated`."""

    query: str
    status: str = ""
    hits: tuple[Hit, ...] = ()
    truncated: bool = False


def search_panel(s: Search) -> str:
    body = (
        '<div class="panel-body">'
        f'<div class="field"><label for="cat-q">{SEARCH_LABEL}</label>'
        f'<input id="cat-q" class="input focus" type="search" autocomplete="off" value="{s.query}"></div>'
        f'<p role="status">{s.status}</p>'
    )
    if s.hits:
        # A list taller than its panel scrolls, so the keyboard needs a stop on it (axe
        # scrollable-region-focusable): the list itself is focusable; no row is.
        body += (
            f'<ul class="rows hits" tabindex="0" aria-label="{LIST_LABEL}">'
            + "".join(hit_row(h) for h in s.hits)
            + "</ul>"
        )
    if s.truncated:
        body += f'<p class="limited">{LIMITED}</p>'
    body += "</div>"
    return panel(SEARCH_HEADING, body, "q-h", "panel search")


def screen(s: Search) -> str:
    grid_cls = "grid-2 listing" if s.hits else "grid-2"
    grid = (
        f'<div class="{grid_cls}">'
        + panel("هذا الجهاز", DEVICE, "dev-h")
        + panel("مزامنة الكتالوج", SYNC, "sync-h")
        + panel("البيانات المحلية", COUNTS, "cnt-h")
        + search_panel(s)
        + "</div>"
    )
    head = f'<div class="screen-head"><h1>{TITLE}</h1><p class="sub">{SUB}</p></div>'
    return f'<main class="screen">{head}{grid}</main>{nav()}'


STATES: list[tuple[str, str, Search]] = [
    ("Results", "قائمة النتائج", Search("بنادول", plural_results(len(PANADOL)), tuple(PANADOL))),
    (
        "BarcodeQuery",
        "باركود مكتوب في البحث",
        Search("6221000000011", plural_results(1), (PANADOL[0],)),
    ),
    ("Long", "أول 20 نتيجة", Search("فيتامين", plural_results(20), tuple(VITAMINS), truncated=True)),
    ("Empty", "لا توجد نتائج", Search("زنجبيل", NONE)),
    ("Short", "بحث أقصر من حرفين", Search("ب")),
    ("Unavailable", "البحث غير متاح", Search("بنادول", UNAVAILABLE)),
]


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6c.py")
    out = Path(__file__).resolve().parent.parent
    for key, title, s in STATES:
        for w in (1024, 1280):
            (out / f"G6C-{key}-{w}.html").write_text(
                page(title, w, screen(s), f"G6C-{key}"), encoding="utf-8"
            )
    print(f"[OK] wrote {len(STATES) * 2} files to {out}")


if __name__ == "__main__":
    main()
