"""Generate G6P-Spec.html (RT-659): the preview states, the reprint path, the two owner options and the copy.

Usage: python -I gen_g6p_spec.py   (writes into this script's parent folder, G6P-Receipt-Preview/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

TOOLS = Path(__file__).resolve().parent
TAKEN = "مأخوذ من main"
PROPOSED = "مقترح"

# (place, text, basis, status)
COPY = [
    ("عنوان النافذة", "«معاينة الإيصال»", "<code>ReceiptPreview.tsx</code> و<code>SALES_COPY.preview</code>", TAKEN),
    ("تحت العنوان", "رقم البيع بخط ثابت (<span class='ltr'>TERM-01-…</span>)", "<code>sale.sale_number</code>، موجود في <code>SaleResult</code>", PROPOSED),
    ("التحميل", "«جارٍ التحضير»", "<code>ReceiptPreview.tsx</code>", TAKEN),
    ("تعذّر المعاينة", "«تعذّرت معاينة الإيصال»", "<code>ReceiptPreview.tsx</code> (<code>role=alert</code>)", TAKEN),
    ("زر الإغلاق", "«إغلاق»", "<code>ReceiptPreview.tsx</code>؛ يُحذف زر ✕ المكرر", TAKEN),
    ("(ب) زر الطباعة", "«إعادة طباعة الإيصال» / «جارٍ إعادة الطباعة…»", "<code>SALES_COPY.reprint</code> و<code>reprinting</code>. لا «طباعة»: المسار يطبع نسخة مكررة لا الإيصال الأول", TAKEN),
    ("(ب) تلميح", "«تُطبع نسخة عليها «نسخة طبق الأصل».»", "علامة <code>reprint_duplicate</code> في <code>template-engine.ts</code>؛ المعاينة تعرض <code>preview</code> بلا العلامة", PROPOSED),
    ("(ب) أُرسل", "«أُرسل الإيصال للطابعة.» (محايد، لا «طُبع»)", "<code>SALES_COPY.reprintSent</code> (N-09)", TAKEN),
    ("(ب) تعذّر", "«تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.»", "<code>SALES_COPY.reprintFailed</code>", TAKEN),
]

# (what, where, finding)
PATH = [
    ("المسار", "<code>receipts.reprint</code> → <code>main/ipc/receipts.ts</code> → <code>receipts-bridge.ts reprint()</code>",
     "الواجهة تستعمله اليوم من <code>ReprintAffordance.tsx</code> بجانب «معاينة الإيصال» في نتيجة البحث وفي تفاصيل البيع المحلي (<code>SaleResult</code>). كل نقرة مفتاح idempotency جديد؛ نداء واحد في كل مرة."),
    ("من يحق له", "<code>sale-access-policy.ts</code> (RT-546، OD-534-2)",
     "يُفحص في main: الكاشير يعيد طباعة بيعه فقط، والمدير والمسؤول أي بيع في نطاق الجهاز. غير ذلك يُرفض <code>sale_not_found</code> بلا تسريب. تنقّل الكاشير يعرض «نقطة البيع» وحدها (OD-6)، فيصل إلى «المبيعات» المدير والمسؤول عمليًا."),
    ("الشرط", "<code>reprintPrecondition</code>",
     "لا إعادة طباعة قبل طباعة ناجحة (<code>not_yet_printed</code>)، ولا لبيع ملغى (<code>sale_voided</code>، يُطبع من سجل المتجر). في الواجهة يغيب الزر بلا طباعة ناجحة (<code>latest_print_event.outcome === 'success'</code>)، لا يُعطَّل."),
    ("ما يُطبع", "<code>reprint_duplicate</code>",
     "نسخة عليها «نسخة طبق الأصل / DUPLICATE COPY» ورقمها. لا يُفتح الدُّرج (FR-030). النتيجة ذات وجهين: <code>ok</code> أو رفض <code>printer_unavailable</code>."),
    ("ما تعرضه المعاينة", "<code>receipts.preview</code>",
     "قراءة فقط بنسخة <code>preview</code> (محتوى الطباعة الأولى بلا علامة). لا طباعة ولا أثر جانبي."),
]

OPTIONS = """
    <table><thead><tr><th>الخيار</th><th>ما يتغيّر</th><th>ما لا يتغيّر</th><th>الحالات المرسومة</th></tr></thead><tbody>
    <tr><td><b>(أ) حذف الزر</b></td><td>النافذة للمعاينة فقط: «إغلاق» وحده. إعادة الطباعة تبقى في سطر النتيجة كما هي.</td>
      <td>كل سلوك الطباعة.</td><td>A-Ready (والتحميل والتعذّر)</td></tr>
    <tr><td><b>(ب) ربطه بمسار إعادة الطباعة</b></td><td>يظهر في النافذة نفس عنصر <code>ReprintAffordance</code>: نفس النداء ونفس الشرط ونفس النصوص. يغيب بلا طباعة ناجحة فتبدو النافذة مثل (أ). تبقى النافذة مفتوحة بعد النتيجة.</td>
      <td>النداء، والصلاحيات (main)، والشرط، والمحتوى المطبوع، والناقل. لا نداء جديد ولا تغيير في الجسر.</td><td>B-Ready، B-Reprinting، B-Sent، B-Failed (والتحميل والتعذّر)</td></tr>
    </tbody></table>
    <p>(ب) ممكن اليوم بلا تغيير في main. ثمنه زر إعادة طباعة ثانٍ لنفس البيع (في السطر وفي النافذة)، ونسخة مطبوعة تختلف عن المعروضة بعلامة «نسخة طبق الأصل»، لذا التلميح.</p>
    <p><b>التوصية: (أ).</b> المعاينة قراءة فقط، والإجراء موجود بجانبها بنفس الشرط، فلا يتكرر الزر ولا تُطبع ورقة تختلف عمّا يُعرض. القرار للمالك.</p>
"""

DRAWN = """
      <li><b>نافذة V5 واحدة</b> (<code>v5/foundation/Dialog.tsx</code>): <code>aria-modal</code>، الشاشة خلفها inert، Esc يغلق، والتركيز يعود إلى «معاينة الإيصال».</li>
      <li><b>التركيز الأول على «إغلاق»</b>: العنصر الآمن (DESIGN.md). الترتيب بـ Tab: الإيصال (منطقة قابلة للتمرير، <code>tabindex=0</code>) ← (ب) «إعادة طباعة الإيصال» ← «إغلاق».</li>
      <li><b>حُذف:</b> زر ✕ المكرر، و«زر التكبير»، و«طباعة» المعطّل دائمًا. الإيصال بعرض 80 مم: 42 عمودًا بخط ثابت 12 بكسل، وهو الحد الأدنى، فلا حاجة للتكبير (اليوم 0.7rem ≈ 11 بكسل).</li>
      <li><b>الإيصال كما يخرج من المحرّك</b> (<code>tools/slip-preview.html</code>، نسخة <code>preview</code> من <code>template-engine.ts</code> على <span class="ltr">main@87238bc</span> ببيانات عيّنة). لا تغيير في المحتوى أو الشكل.</li>
      <li><b>الإيصال على حامل غائر</b> (surface-sunken) ويُمرَّر وحده؛ العنوان والأزرار ثابتة في 1024×768 و1280×800.</li>
      <li><b>الشاشة خلف النافذة</b> هي حالة G-6 «SalesFound» نفسها من <code>gen_g6.py</code>.</li>
"""

FORCED_NOTES = """
      <li>حد النافذة والحامل والإيصال بلون النص؛ حلقة التركيز <code>Highlight</code>؛ الزر المعطّل <code>GrayText</code> (أنماط G-6).</li>
      <li>المعنى لا يعتمد على اللون: الإشعارات برمزها ونصها.</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_g6p.cjs</code> (أداة <code>../tools/capture-refs.cjs</code> المشتركة، نفس فحوص G-6 وPK-3): الاحتواء داخل الإطار،
      لا نص أصغر من 12 بكسل، لا هدف أصغر من 44×44، لا عنصر قابل للتركيز خلف النافذة، وaxe-core بلا مخالفات. تُولَّد الملفات من
      <code>tools/gen_g6p.py</code> وهذه الصفحة من <code>tools/gen_g6p_spec.py</code>.</p>
"""

STYLE = """
  :root { --primary:#0f766e; --text:#0f1d2e; --muted:#53647a; --border:#d8dfe7; --bg:#f7f9fa; --surface:#fff; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--text); font-family:'Dubai','Segoe UI',Tahoma,Arial,sans-serif; font-size:15px; line-height:1.7; }
  main { max-inline-size:1180px; margin-inline:auto; display:grid; gap:28px; }
  h1 { margin:0; font-size:26px; } h2 { margin:0 0 8px; font-size:19px; }
  .status { display:inline-block; padding:2px 12px; border:1px solid #a35a00; border-radius:999px; background:#fdf1e0; color:#7a4300; font-weight:700; }
  section { padding:20px 24px; border:1px solid var(--border); border-radius:14px; background:var(--surface); }
  table { inline-size:100%; border-collapse:collapse; }
  th, td { padding:8px 10px; border-block-end:1px solid var(--border); text-align:start; vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .ltr { direction:ltr; unicode-bidi:isolate; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:13px; direction:ltr; unicode-bidi:isolate; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:16px; }
  figure { margin:0; display:grid; gap:6px; }
  figure img { inline-size:100%; border:1px solid var(--border); border-radius:8px; }
  figcaption { color:var(--muted); font-size:13px; }
  ul { margin:0; padding-inline-start:20px; }
"""

HEADER = """
  <header>
    <h1>معاينة الإيصال في «المبيعات»: ملحق G-6 (نافذة V5)</h1>
    <p><span class="status">مسودة · بانتظار قرار المالك</span> · Jira <span class="ltr">RT-659</span> · ملحق لـ G-6 (<span class="ltr">RT-478</span>، PR <span class="ltr">#670</span>)</p>
    <p><b>المطلوب من المالك:</b> اعتماد الشكل، واختيار (أ) أو (ب) لزر «طباعة». لا تغيير في محتوى الإيصال، ولا في ناقل الطباعة، ولا في صلاحيات البيع، ولا في main.</p>
  </header>
"""

FORCED_STATES = ("A-Ready", "B-Sent", "Failed")


def load_states() -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_g6p", TOOLS / "gen_g6p.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_g6p"] = module  # dataclasses resolves its owner module by name
    spec.loader.exec_module(module)
    return [(key, title) for key, title, _ in module.STATES]


def row(*cells: str) -> str:
    return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"


def table(heads: list[str], rows: list[str]) -> str:
    head = "".join(f"<th>{h}</th>" for h in heads)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table>"


def section(title: str, body: str) -> str:
    return f"  <section>\n    <h2>{title}</h2>\n    {body}\n  </section>\n"


def figure(src: str, caption: str) -> str:
    return f'<figure><img src="captures/{src}" alt=""><figcaption>{caption}</figcaption></figure>'


def figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        figure(f"G6P-{k}-{w}-light.png", f"{t} · {w}") for k, t in states for w in ("1280", "1024")
    )


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        figure(f"G6P-{k}-1280-forced.png", f"{t} · تباين عالٍ") for k, t in states if k in FORCED_STATES
    )


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>لكل حالة ملفان <code>G6P-&lt;State&gt;-1024.html</code> و<code>-1280.html</code>، والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section("«طباعة»: خياران للمالك", OPTIONS),
        section("مسار إعادة الطباعة الموجود (main@87238bc)", table(["", "أين", "ما وُجد"], [row(*p) for p in PATH])),
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("النصوص", table(["المكان", "النص", "الأساس", "الحالة"], [row(*c) for c in COPY])),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-659 G-6 addendum · معاينة الإيصال · مرجع</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6p_spec.py")
    states = load_states()
    (TOOLS.parent / "G6P-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote G6P-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
