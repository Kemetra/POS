"""Check that every product string in the G6R references is copied verbatim from the shipped code.

Each Arabic text run in the generated G6R-*.html files must appear, character for character, in
src/renderer/returns/** (the RT-15 screen), in the shared frame/role strings, or in the sample-data
list below (names, sale lines, times: illustrative only, never product copy).

Usage: python -I check_g6r_copy.py   (exit 1 and one line per string that is not found)
"""

from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
REPO = PACK.parents[4]
SOURCES = [
    *sorted((REPO / "src/renderer/returns").glob("*.ts*")),
    REPO / "src/renderer/v5/frame/V5Navigation.tsx",
    REPO / "src/renderer/v5/frame/V5SignOut.tsx",
    REPO / "src/shared/operator/role.ts",
    REPO / "specs/003-pos-ui-shell/contracts/shell-routes.ts",
]

# Illustrative sample data drawn in the references (not product copy).
SAMPLE = {
    "سارة عبد الحميد",
    "بنادول إكسترا 500 مجم — 24 قرص",
    "أموكسيسيلين/كلافولانيت 875/125 مجم",
    "فولتارين جل 1% — 50 جم",
    "كونجستال أقراص",
}
ARABIC = re.compile(r"[؀-ۿ]")
DATE = re.compile(r"^\d{1,2} [؀-ۿ]+ \d{4}، \d{2}:\d{2}$")


class Texts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.runs: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs) -> None:
        if tag in ("title", "style", "bdi", "time", "output"):
            self._skip += 1
        for name, value in attrs:
            if name == "aria-label" and value and ARABIC.search(value):
                self.runs.append(value)

    def handle_endtag(self, tag) -> None:
        if tag in ("title", "style", "bdi", "time", "output"):
            self._skip -= 1

    def handle_data(self, data) -> None:
        text = data.strip()
        if text and not self._skip and ARABIC.search(text):
            self.runs.append(text)


def source_text() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in SOURCES if p.exists())


def pieces(run: str) -> list[str]:
    # A run interrupted by a <bdi> (sale number, amount) is checked as its literal pieces.
    return [p.strip(" ·:") for p in re.split(r"\s·\s", run) if p.strip(" ·:")]


def allowed(piece: str, src: str) -> bool:
    if piece in SAMPLE or DATE.match(piece):
        return True
    if piece in src:
        return True
    # aria-labels are a template literal plus a sample product name or sale number.
    return any(piece == f"{prefix} {s}" for s in SAMPLE for prefix in ("إنقاص", "زيادة", "كمية")) or bool(
        re.match(r"^(صرف|إكمال الصرف|طباعة نسخة) TERM-[\d-]+$", piece)
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I check_g6r_copy.py")
    src = source_text()
    missing: set[str] = set()
    count = 0
    for html in sorted(PACK.glob("G6R-*-*.html")):
        parser = Texts()
        parser.feed(html.read_text(encoding="utf-8"))
        for run in parser.runs:
            for piece in pieces(run):
                count += 1
                if not allowed(piece, src):
                    missing.add(piece)
    for piece in sorted(missing):
        print(f"[NOT FOUND] {piece}")
    print(f"[{'FAIL' if missing else 'OK'}] {count} string runs checked, {len(missing)} not found in the shipped sources")
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
