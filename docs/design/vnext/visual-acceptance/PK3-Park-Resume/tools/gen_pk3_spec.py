"""Generate PK3-Spec.html (RT-471): the states, the copy table, the refusal map and the owner decisions.

The owner decided OD-1…OD-15 on 2026-10-17 (RT-471 comment 12299); this page records them.

Usage: python -I gen_pk3_spec.py <PK3-Park-Resume folder>
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

DECIDED = "معتمد (المالك 2026-10-17)"

# (place, text, basis, status). Status: None = taken from an existing catalogue or document.
COPY = [
    ("زر شاشة البيع", "«تعليق البيع»", "M-H1 في الوثيقة 15، وVN-R1", None),
    ("زر عدد المبيعات", "«المبيعات المعلّقة» + عدد", "M-H1 و<code>shift-copy</code>. الشارة = عدد مبيعاتك (<code>listParked</code>)", "OD-4"),
    ("عنوان نافذة التعليق", "«تعليق البيع»", "لم يحدده العقد", "OD-3"),
    ("حقل الاسم", "«اسم للبيع (اختياري)» · عدّاد <span class='ltr'>0/40</span>", "الحد 40 حرفًا وكونه اختياريًا من K2", "OD-3"),
    ("تحذير البيانات الشخصية", "«لا تكتب اسم العميل أو رقم هاتفه أو أي بيانات شخصية.»", "K2: «الواجهة تحذّر»", "OD-3, OD-11"),
    ("زر الإغلاق", "«رجوع» (وليس «إلغاء»)", "لئلا يشبه «إلغاء البيع» (I-2)", "OD-3"),
    ("اسم غير صالح", "«اكتب اسمًا من 1 إلى 40 حرفًا في سطر واحد، أو اتركه فارغًا.»", "<code>invalid_label</code>: تقص الواجهة المسافات وترسل الاسم الفارغ بلا اسم، فلا تظهر الحالة إلا مع محارف تحكم (OD-10)", "OD-3, OD-10"),
    ("جارٍ الحفظ", "«جارٍ حفظ البيع…»", "I-13: الحفظ ثم المسح", "OD-3"),
    ("الحد الأقصى", "«وصل هذا الجهاز إلى الحد الأقصى: 5 مبيعات معلّقة. استأنف بيعًا معلّقًا أو اطلب من المدير إلغاءه.» + «عرض المبيعات المعلّقة»", "<code>park_limit_reached</code>؛ بلا «x من 5» وبلا حقل جديد (OD-5)", "OD-3, OD-5"),
    ("بعد التعليق", "«عُلِّق البيع ‹الاسم›.»", "M-H1 في الوثيقة 15 حرفيًا", None),
    ("السلة الفارغة", "«لا توجد أصناف في السلة بعد.»", "<code>LiveSaleCart.tsx</code>", None),
    ("القائمة", "عنوان «المبيعات المعلّقة» · «مبيعاتك المعلّقة» · «رجوع إلى البيع»", "شاشة كاملة (OD-4)", "OD-3, OD-4"),
    ("قائمة فارغة", "«لا توجد مبيعات معلّقة.»", "غير محدد في العقد", "OD-3"),
    ("سطر البيع", "‹الاسم أو «بدون اسم»› · عدد الأصناف · «عُلّق ‹وقت مطلق›» · الإجمالي · «استئناف البيع»", "الحقول من <code>ParkedSaleView</code>. الاسم الطويل يُقتطع بنقاط وتظهر كامله عند التركيز (OD-11)؛ اسم من 36 حرفًا يتسع في الصفين بلا اقتطاع، فالقاعدة تعمل في الصفوف الأضيق", "OD-3, OD-11"),
    ("علامة القِدَم", "«قديم»؛ الوقت «13:41» لليوم و«16/10 20:45» لما قبله", "<code>stale</code> (K4) وقاعدة D-N1", "OD-12"),
    ("حاشية القائمة", "«تبقى المبيعات المعلّقة على هذا الجهاز ولا تظهر لغير صاحبها. يُراجَع كل سعر عند الاستئناف.»", "K2 وK3 وK4", "OD-3"),
    ("المراجعة", "«مراجعة البيع قبل الاستئناف» · «لن يتغيّر شيء في البيع قبل أن تقبل التغييرات.»", "§3.3 / §3.4", "OD-3"),
    ("جدول الأسعار", "الصنف · السعر السابق · السعر الجديد · «الفرق للوحدة» · ارتفع / انخفض", "<code>changes[]</code>: الفرق للوحدة إلى أن تتوفر الكمية (OD-1)", "OD-1, OD-3"),
    ("الأصناف المحذوفة", "«لم تعد في الكتالوج، وستُحذف من البيع عند الاستئناف» · «ستُحذف»", "<code>unavailable[]</code> وR-1", "OD-3"),
    ("حداثة الكتالوج", "«آخر كتالوج: اليوم 13:02»", "§4.2 وVN-R1", None),
    ("التعارض VN-R10", "«لديك بيع نشط الآن: صنفان بقيمة 95.00 EGP.» · «لا يمكن دمج بيعين. اختر ما يحدث للبيع الحالي.»", "I-13 و<code>current_cart</code>", "OD-3, OD-7"),
    ("أزرار التعارض", "«علّق البيع الحالي واستأنف المحدد» · «أبقِ البيع الحالي» (رجوع محلي بلا نداء)", "إجراء واحد يجمع القبول والتعليق؛ البيع المُبدَّل يُعلَّق «بدون اسم»", "OD-7, OD-8"),
    ("الكتالوج غير متاح", "«تعذّرت مراجعة الأسعار لأن الكتالوج غير متاح على هذا الجهاز. بقي البيع معلّقًا ولم يتغيّر شيء.» + «رجوع» فقط", "<code>catalogue_unavailable</code>", "OD-3, OD-14"),
    ("تغيّرت الأسعار", "«تغيّرت الأسعار منذ عرضها. راجع التغييرات الجديدة قبل الاستئناف.»", "<code>price_changes_unaccepted</code>: تعيد الواجهة المعاينة تلقائيًا وتعرض المراجعة الجديدة", "OD-3, OD-14"),
    ("البيع الحالي في الدفع", "«البيع الحالي في مرحلة الدفع. أكمله أو ارجع إليه قبل أن تستأنف بيعًا معلّقًا.»", "<code>checkout_in_progress</code>", "OD-3"),
    ("رفض عام", "«تعذّر تنفيذ العملية. حاول مرة أخرى، وإن تكرر اطلب المدير.» ثم تُقرأ القائمة من جديد", "الأسباب التي لا حالة لها (OD-9)؛ لا تُرسم حالة منفصلة", "OD-9"),
    ("المسح أثناء القائمة والمراجعة", "الحالة الموجودة «المسح متوقف — نافذة مفتوحة»", "الوثيقة 15 §3.1؛ لا نص جديد ولا حالة جديدة (OD-15)", "OD-15"),
    ("إغلاق الوردية", "«توجد مبيعات معلّقة على هذا الجهاز. استأنفها أو اطلب من المدير إلغاءها ثم أغلق الوردية.»", "<code>SHIFT_COPY.parked_sales_present</code> حرفيًا", None),
    ("عدد المانعة للإغلاق", "«3 مبيعات معلّقة على هذا الجهاز» (المفرد «بيع معلّق واحد»، والمثنى «بيعان معلّقان») + زر «عرض مبيعاتي المعلّقة»", "<code>parkedCount</code>: العدد للجهاز كله ويبقى كذلك (OD-13)", "OD-13"),
]

# (reason, outcome)
REFS = [
    ("<code>park</code>: <code>invalid_label</code>", "رُسمت (ParkInvalid): لا تظهر إلا مع محارف تحكم (OD-10)"),
    ("<code>park</code>: <code>park_limit_reached</code>", "رُسمت (ParkLimit)"),
    ("<code>park</code>: <code>not_parkable</code>", "زر التعليق معطّل بسلة فارغة (SaleEmpty)؛ ما عدا ذلك يظهر الرفض العام (OD-9)"),
    ("<code>wrong_owner</code> · <code>not_parked</code> · <code>no_session</code> · <code>authority_conflict</code> · <code>idempotency_payload_mismatch</code> · <code>current_cart_active</code>", "الرفض العام «تعذّر تنفيذ العملية…» ثم قراءة القائمة من جديد (OD-9)، بلا حالة مرسومة"),
    ("<code>session_locked</code>", "شاشة القفل الموجودة (I3-Locked)"),
    ("<code>previewResume</code> / <code>resume</code>: <code>catalogue_unavailable</code>", "رُسمت (RefCatalogue): «رجوع» فقط (OD-14)"),
    ("<code>resume</code>: <code>price_changes_unaccepted</code>", "رُسمت (RefChanged): معاينة تلقائية ثم المراجعة الجديدة (OD-14)"),
    ("<code>resume</code>: <code>checkout_in_progress</code>", "رُسمت (RefCheckout)"),
    ("<code>parked_sales_present</code> + <code>parkedCount</code>", "رُسمت (ShiftClose) مع زر «عرض مبيعاتي المعلّقة» (OD-13)"),
]

# (id, point, outcome)
DECISIONS = [
    ("OD-1", "اسم الصنف وكميته في مراجعة الاستئناف", "يُضاف اسم الصنف وكميته إلى <code>changes[]</code> و<code>unavailable[]</code> في <code>cart.previewResume</code> (جسر PK-2). البيانات في البنود المحفوظة محليًا، فلا تغيير في Backend-Core. يُتابَع في <b>RT-610</b> (Implementation مع مراجعة §A4) و<b>يمنع RT-445</b>. تبقى المراجع بالأسماء، ويبقى الفرق للوحدة إلى أن تتوفر الكمية."),
    ("OD-2", "المصطلح", "«معلّق» في كل مكان. <code>RECOVERY_COPY.parked</code> («مؤجلة») تصبح «معلّقة» ضمن RT-445."),
    ("OD-3", "النصوص المقترحة", "كل نص موسوم «مقترح» معتمد كما رُسم، مع التعديلات في هذا الجدول."),
    ("OD-4", "مكان القائمة ومصدر العدد", "شاشة كاملة كما رُسمت. الشارة تعدّ مبيعات الكاشير نفسه (<code>listParked</code>)."),
    ("OD-5", "الحد 5 للجهاز والقائمة لصاحبها", "نص الرفض يكفي. بلا «x من 5» وبلا حقل جديد في الجسر."),
    ("OD-6", "معاينة بلا تغييرات ولا تعارض", "يُستأنف مباشرة بلا شاشة مراجعة فارغة. المعاينة تُجرى كما يوجب العقد."),
    ("OD-7", "دمج التعارض والمراجعة", "الإجراء الواحد المجمّع معتمد. البيع الحالي المُعلَّق يُعلَّق «بدون اسم»."),
    ("OD-8", "«أبقِ البيع الحالي»", "رجوع محلي بلا نداء."),
    ("OD-9", "أسباب الرفض بلا حالة", "رفض عام واحد: «تعذّر تنفيذ العملية. حاول مرة أخرى، وإن تكرر اطلب المدير.» ثم تُقرأ القائمة من جديد."),
    ("OD-10", "متى يظهر «اسم غير صالح»", "تقص الواجهة المسافات، والاسم الفارغ يُرسل بلا اسم، فلا يظهر <code>invalid_label</code> إلا مع محارف تحكم. حالة ParkInvalid ترسم الاسم العادي لهذا السبب."),
    ("OD-11", "ما يظهر من الاسم", "التحذير يكفي. الاسم الطويل يُقتطع بنقاط في القائمة وتظهر كامله عند التركيز. القاعدة مطبّقة في الأنماط؛ اسم من 36 حرفًا (في ListFive) يتسع في الصفين بلا اقتطاع، فلا يظهر الاقتطاع في أي مرجع."),
    ("OD-12", "صيغة الوقت وعلامة القِدَم", "كما رُسمت: «13:41» لليوم و«16/10 20:45» لما قبله، والعلامة «قديم»."),
    ("OD-13", "عدد المبيعات في رفض إغلاق الوردية", "الصياغة والجمع كما رُسما، وأُضيف زر «عرض مبيعاتي المعلّقة». العدد يبقى للجهاز كله."),
    ("OD-14", "إعادة المحاولة بعد الرفض", "كما رُسم: رفض الكتالوج «رجوع» فقط؛ وتغيّر الأسعار يعيد المعاينة تلقائيًا ويعرض المراجعة الجديدة."),
    ("OD-15", "المسح أثناء القائمة والمراجعة", "تُستعمل حالة المسح الموجودة «المسح متوقف — نافذة مفتوحة» (الوثيقة 15 §3.1). لا نص جديد."),
]

STYLE = """
  :root { --primary:#0f766e; --text:#0f1d2e; --muted:#53647a; --border:#d8dfe7; --bg:#f7f9fa; --surface:#fff; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--text); font-family:'Dubai','Segoe UI',Tahoma,Arial,sans-serif; font-size:15px; line-height:1.7; }
  main { max-inline-size:1180px; margin-inline:auto; display:grid; gap:28px; }
  h1 { margin:0; font-size:26px; } h2 { margin:0 0 8px; font-size:19px; }
  .status { display:inline-block; padding:2px 12px; border:1px solid #0f766e; border-radius:999px; background:#e6f4f1; color:#0b5b55; font-weight:700; }
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
  a { color:var(--primary); }
  ul { margin:0; padding-inline-start:20px; }
"""

HEADER = """
  <header>
    <h1>تعليق البيع واستئنافه (PK-3): مراجع شاشات VN-S11</h1>
    <p><span class="status">قرارات المالك مسجّلة (<span class="ltr">2026-10-17</span>)</span> · Jira <span class="ltr">RT-471</span> (التعليق <span class="ltr">12299</span>) · تخدم <span class="ltr">RT-445</span></p>
    <p><b>التصنيف:</b> السلوك معتمد بقدر ما يحدده العقد (<code>specs/024-park-resume-v1/spec.md</code> وجسر RT-440) وبقرارات المالك أدناه. الشكل بعد تصحيح الإطار: يرى الكاشير «نقطة البيع» وحدها في التنقل (OD-6 وRT-597). لا تغيير في السلوك.</p>
    <p><b>يمنع RT-445:</b> إضافة اسم الصنف وكميته إلى <code>cart.previewResume</code> (OD-1، <span class="ltr">RT-610</span>).</p>
    <p>لا مفاتيح مرتبطة: F3 وF4 مفتوحان تحت D-K1 (RT-252)، وكل إجراء زر ظاهر.</p>
  </header>
"""

DRAWN = """
      <li><b>التعليق ≠ الإلغاء (I-2):</b> «تعليق البيع» زر محايد بحدّ أخضر داكن ورمز إيقاف مؤقت، و«إلغاء البيع» وحده بلون الخطر في الطرف الآخر خلف فاصل. زر إغلاق نافذة التعليق «رجوع» لا «إلغاء».</li>
      <li><b>الحفظ ثم المسح (I-13):</b> أثناء <code>cart.park</code> تبقى السلة ظاهرة (ParkSaving)، ولا تُمسح إلا بعد <code>parked</code> (Parked).</li>
      <li><b>القائمة لصاحبها فقط (K3):</b> بلا عمود موظف، وبلا بنود، وبلا «x من 5».</li>
      <li><b>القِدَم علامة عرض فقط (K4):</b> كل استئناف يراجع الأسعار.</li>
      <li><b>لا شيء قبل القبول (§3.3):</b> المراجعة تُظهر السعر السابق والجديد والفرق والأصناف المحذوفة؛ الفرق بالعلامة والسهم والنص، لا باللون وحده.</li>
      <li><b>إطار الكاشير:</b> التنقل «نقطة البيع» وحدها في كل الحالات.</li>
      <li><b>الأرقام غربية وعملة <span class="ltr">EGP</span></b> (DESIGN.md)، والتوقيت مطلق، وكل هدف 44 بكسل فأكثر.</li>
      <li><b>لم يُرسم:</b> مسار المدير (RT-441) وربط المفاتيح.</li>
"""

FORCED_NOTES = """
      <li>كل حد (البطاقة، الزر، الوسم، الجدول، التعارض) يصبح حدًّا بلون النص؛ وحدّا التعارض والتحذير 2 بكسل.</li>
      <li>الأزرار المعطّلة بلون <code>GrayText</code>، وحلقة التركيز <code>Highlight</code>.</li>
      <li>المعنى لا يعتمد على اللون: لكل وسم رمزه (ساعة لـ«قديم»، علامة × لـ«ستُحذف»، سهم لارتفاع الفرق وانخفاضه).</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_pk3.cjs</code> (نفس فحوص G-3 وG-6): الاحتواء داخل الإطار، لا تدفق أفقي، لا نص أصغر من 12 بكسل،
      لا هدف أصغر من 44×44، لا اسم مقصوص، لا عنصر قابل للتركيز خلف النافذة، وaxe-core بلا مخالفات على الإطار. تُولَّد الملفات من
      <code>tools/gen_pk3.py</code> وهذه الصفحة من <code>tools/gen_pk3_spec.py</code>.</p>
"""

FORCED_STATES = ("ParkLimit", "ConflictChanges", "ListStale")


def load_states(tools: Path) -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_pk3", tools / "gen_pk3.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_pk3"] = module  # dataclasses resolves its owner module by name
    spec.loader.exec_module(module)
    return [(key, title) for key, title, _ in module.STATES]


def row(*cells: str) -> str:
    return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"


def table(heads: list[str], rows: list[str]) -> str:
    head = "".join(f"<th>{h}</th>" for h in heads)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table>"


def section(title: str, body: str) -> str:
    return f"  <section>\n    <h2>{title}</h2>\n    {body}\n  </section>\n"


def figures(states: list[tuple[str, str]]) -> str:
    def one(i: int, key: str, title: str) -> str:
        width = "1024" if i % 2 else "1280"
        return f'<figure><img src="captures/PK3-{key}-{width}-light.png" alt=""><figcaption>{i + 1} · {title}</figcaption></figure>'

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/PK3-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def copy_rows() -> list[str]:
    return [row(place, text, basis, DECIDED + f" · {ods}" if ods else "مأخوذ") for place, text, basis, ods in COPY]


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>PK3-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("خريطة أسباب الرفض في العقد", table(["السبب", "الحالة"], [row(a, b) for a, b in REFS])),
        section("النصوص", table(["المكان", "النص", "الأساس", "الحالة"], copy_rows())),
        section(
            "قرارات المالك (2026-10-17، RT-471 التعليق 12299)",
            table(["#", "النقطة", "القرار"], [row(a, b, c) for a, b, c in DECISIONS]),
        ),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-471 PK-3 · تعليق البيع واستئنافه · مرجع</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python -I gen_pk3_spec.py <PK3-Park-Resume folder>")
    out = Path(sys.argv[1])
    states = load_states(Path(__file__).resolve().parent)
    (out / "PK3-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote PK3-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
