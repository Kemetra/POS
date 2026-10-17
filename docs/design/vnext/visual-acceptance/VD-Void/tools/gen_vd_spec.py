"""Generate VD-Spec.html (RT-654): the states, the copy table, the refusal map and the owner decisions.

Visual DRAFT, pending owner approval. Every string is verbatim from src/renderer/v5/void/void-copy.ts;
this pack adds no copy. The layout points the owner must decide are listed as OD-1…OD-8.

Usage: python -I gen_vd_spec.py   (writes into this script's parent folder, VD-Void/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

SRC = "<code>void-copy.ts</code>"

# (place, text, where it is drawn). Every text is verbatim from void-copy.ts.
COPY = [
    ("عنوان الشاشة", "«إلغاء بيع»", "كل الحالات (رأس صفحة G-6)"),
    ("البحث", "«البحث عن بيع» · «رقم البيع» · «بحث»", "كل الحالات"),
    ("التلميح قبل البحث", "«يمكن إلغاء البيع في يوم بيعه فقط، وبتأكيد مدير آخر غيرك وغير بائع الفاتورة.»", "Lookup · Journal · Requested · RefJournal · RefServer"),
    ("بيانات البيع", "«رقم البيع» · «وقت البيع» · «البائع» · «إجمالي البيع» · «نقدي في الدرج»", "Found · RefIneligible"),
    ("زر الإلغاء", "«إلغاء هذا البيع»", "Found"),
    ("طلبات الإلغاء", "«طلبات الإلغاء» · «لا توجد طلبات إلغاء.» · «وقت الطلب»", "Lookup · Journal"),
    ("حالة الطلب", "«طلب الإلغاء بانتظار الإرسال» · «تعذّر تأكيد الإرسال، وستُعاد المحاولة تلقائيًا» · «تم الإلغاء» · «رُفض الإلغاء»", "Journal · RefServer"),
    ("ما ينتظره الطلب", "«بانتظار مزامنة البيع مع الخادم» · «بانتظار تسجيل دخول ‹الاسم› متصلًا لإرسال الإلغاء»", "Journal"),
    ("بعد الطلب", "«سُجّل طلب الإلغاء. يُرسل تلقائيًا عند اتصال مُقدِّمه بالإنترنت.» + ما ينتظره، كما يجمعهما الكود اليوم", "Requested (OD-6)"),
    ("الاطلاع على الرفض", "«تم الاطلاع»", "RefServer"),
    ("نافذة التأكيد", "«تأكيد إلغاء البيع» · «يلزم مدير آخر، ليس أنت وليس بائع الفاتورة، ليؤكد الإلغاء برقمه السري. يخرج نقد هذا البيع من الدرج.» · «المدير المؤكِّد» · «الرقم السري للمدير» · «رجوع» · «تأكيد الإلغاء»", "Dialog · DialogReady · DialogRefused"),
    ("لا مدير", "«لا يوجد مدير مفعّل لتأكيد الإلغاء على هذه الطرفية.»", "DialogNoManagers"),
    ("التحميل", "«جارٍ التحميل…»", "لم يُرسم (القائمة والمديرون أثناء التحميل)"),
    ("لافتة الإطار", "«رفض الخادم طلب إلغاء بيع. افتح «إلغاء بيع» لمعرفة السبب.» + «عرض» · رابط «إلغاء بيع»", "لا تظهر على هذه الشاشة؛ خارج النطاق"),
]

# (reasons, family, drawn as)
REFS = [
    ("<code>sale_not_found</code>", "رفض البحث", "RefNotFound: «لا يوجد بيع بهذا الرقم على هذه الطرفية.»"),
    ("<code>invalid_input</code> · <code>feature_disabled</code> · <code>no_session</code> · <code>session_locked</code> · <code>void_unavailable</code> · خطأ الجسر", "رفض البحث", "نفس مكان RefNotFound، بنصه من الجدول"),
    ("<code>not_same_day</code>", "البيع موجود ولا يُلغى", "RefIneligible: البيانات تظهر، والتنبيه مكان الزر"),
    ("<code>already_voided</code> · <code>has_return</code>", "البيع موجود ولا يُلغى", "نفس RefIneligible، بنصه: «لهذا البيع طلب إلغاء بالفعل.» · «لهذا البيع مرتجع، فلا يمكن إلغاؤه.»"),
    ("<code>list</code> مرفوض أو خطأ الجسر", "تعذّر تحميل الطلبات", "RefJournal: «تعذّر تنفيذ الإجراء. حاول مرة أخرى.»"),
    ("<code>void_self_approval</code>", "رفض الخادم طلبًا", "RefServer: صف «رُفض الإلغاء» + السبب + «تم الاطلاع»"),
    ("<code>void_outside_business_day</code> · <code>void_approval_required</code> · <code>void_approval_invalid</code> · <code>void_requester_mismatch</code> · <code>void_requester_not_eligible</code> · <code>void_approver_not_eligible</code> · <code>already_reversed</code> · <code>conflict</code> · <code>validation_error</code> · <code>sale_not_found</code>", "رفض الخادم طلبًا", "نفس صف RefServer، بنص كل سبب"),
    ("<code>approval_unavailable</code>", "رفض داخل النافذة", "DialogRefused: يُمسح الرقم السري ويبقى المدير مختارًا"),
    ("<code>approval_invalid</code> · <code>approval_stale</code> · <code>no_operator_envelope</code> · <code>already_voided</code> · <code>has_return</code> · <code>not_same_day</code> · <code>void_unavailable</code> · خطأ الجسر", "رفض داخل النافذة", "نفس مكان DialogRefused، بنصه"),
    ("قائمة المديرين فارغة", "لا مدير للتأكيد", "DialogNoManagers: «تأكيد الإلغاء» معطّل"),
    ("قائمة المديرين مرفوضة", "لا مدير للتأكيد", "مكان قائمة المديرين، بنص السبب"),
]

# (id, point, recommendation)
DECISIONS = [
    ("OD-1", "التخطيط", "عمودان كما اليوم: البحث يلتصق بأعلى، وطلبات الإلغاء تملأ الارتفاع وتتمرر. رأس صفحة G-6 بلا سطر فرعي، لأن أي سطر فرعي نص جديد."),
    ("OD-2", "لون زري الإلغاء", "«إلغاء هذا البيع» و«تأكيد الإلغاء» بلون الخطر (اليوم: الأساسي الأخضر)، مثل «إلغاء البيع» في PK-3 و«إغلاق الوردية» في G-6. «تأكيد الإلغاء» معطّل بلا مدير ورقم سري، كما اليوم."),
    ("OD-3", "ألوان حالات الطلب", "«بانتظار الإرسال» و«تعذّر تأكيد الإرسال» محايدتان، لكل منهما رمزها (ساعة، إعادة). «تم الإلغاء» بلون النجاح. «رُفض الإلغاء» بلون الخطر مع حافة على جانب القراءة. اليوم يُلوَّن الصف المرفوض وحده."),
    ("OD-4", "شكل الرفض", "كل رفض يصبح تنبيه V5 (رمز + جملة) بدل الفقرة الحالية <code>v5-shift-alert</code>. النص لا يتغير."),
    ("OD-5", "تمرير القائمة بلوحة المفاتيح", "قائمة الطلبات منطقة قابلة للتركيز (<code>tabindex=0</code>) ليتمكن مستخدم لوحة المفاتيح من تمريرها حين لا يكون فيها زر (axe: <code>scrollable-region-focusable</code>)."),
    ("OD-6", "إشعار «سُجّل طلب الإلغاء»", "يجمع الكود اليوم الجملتين بمسافة، فلا تنتهي الثانية بنقطة. رُسم كما هو. إضافة النقطة تغيير نص صغير ينتظر موافقة المالك."),
    ("OD-7", "رقم البيع والمبلغ", "اليوم «الرقم — المبلغ» في سطر واحد بشرطة. في الصف وفي النافذة رُسما على طرفين بلا شرطة، كلاهما من اليسار لليمين بأرقام غربية."),
    ("OD-8", "التنقل", "<span class='ltr'>/app/void</span> ليست في القائمة، فلا يُحدَّد فيها عنصر. الطريق إلى الشاشة يبقى رابط «إلغاء بيع» في شريط التنبيهات، بلا تغيير."),
]

STYLE = """
  :root { --primary:#0f766e; --text:#0f1d2e; --muted:#53647a; --border:#d8dfe7; --bg:#f7f9fa; --surface:#fff; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--text); font-family:'Dubai','Segoe UI',Tahoma,Arial,sans-serif; font-size:15px; line-height:1.7; }
  main { max-inline-size:1180px; margin-inline:auto; display:grid; gap:28px; }
  h1 { margin:0; font-size:26px; } h2 { margin:0 0 8px; font-size:19px; }
  .status { display:inline-block; padding:2px 12px; border:1px solid #a35a00; border-radius:999px; background:#fdf1e0; color:#7d4500; font-weight:700; }
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
    <h1>إلغاء بيع (<span class="ltr">/app/void</span>): الشاشة على لغة G-6</h1>
    <p><span class="status">مسودة، تنتظر موافقة المالك</span> · Jira <span class="ltr">RT-654</span> · الشاشة من <span class="ltr">RT-530</span></p>
    <p>الشاشة شُحنت بعد اعتماد G-6 ولا مرجع لها. اليوم أزرارها «بحث» و«إلغاء هذا البيع» و«تم الاطلاع» حبوب بارتفاع نحو 22 بكسل،
      والتاريخ والأسماء بالخط أحادي المسافة فتتباعد الحروف العربية، ورأسها شريط الوردية الغائر.</p>
    <p><b>لا تغيير في السلوك</b> ولا في قواعد الرقم السري ولا في <code>POS_PULSE_FEATURE_SALE_VOID</code> ولا في فحوص العملية الرئيسية.
      <b>لا نص جديد:</b> كل نص منقول حرفيًا من <code>src/renderer/v5/void/void-copy.ts</code>.</p>
  </header>
"""

DRAWN = """
      <li><b>رأس صفحة G-6</b> بدل شريط الوردية الغائر، ولوحتان بعنوان (<code>panel</code> / <code>panel-head</code>).</li>
      <li><b>كل زر وحقل 44 بكسل فأكثر</b>، وكل اختيار مدير سطر كامل بارتفاع 44.</li>
      <li><b>العربية بخط Dubai</b>: التاريخ («17 أكتوبر، 10:58») والأسماء والنصوص. الأرقام فيها غربية بعرض ثابت.</li>
      <li><b>الخط أحادي المسافة للرموز والمبالغ فقط</b>: رقم البيع والمبالغ، من اليسار لليمين بأرقام غربية.</li>
      <li><b>التأكيد في نافذة V5</b>: الخلفية معطّلة، والتركيز يبدأ على «رجوع» كما اليوم (<code>initialFocusRef</code>).</li>
      <li><b>الرقم السري يُمسح بعد الضغط</b>، فحالة الرفض ترسم الحقل فارغًا والمدير ما زال مختارًا.</li>
      <li><b>البيانات وهمية:</b> لا بيع حقيقي ولا شخص حقيقي ولا رقم سري حقيقي.</li>
"""

FORCED_NOTES = """
      <li>كل حد يصبح بلون النص؛ حافة الصف المرفوض ووسمه 2 بكسل فأكثر.</li>
      <li>الأزرار المعطّلة بلون <code>GrayText</code>، وحلقة التركيز <code>Highlight</code>.</li>
      <li>الحالة لا تعتمد على اللون: لكل حالة رمزها (ساعة، إعادة، علامة صح، مثلث تحذير) ونصها.</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_vd.cjs</code> (نفس فحوص G-3 وG-6 وPK-3 في <code>../tools/capture-refs.cjs</code>):
      الاحتواء داخل الإطار، لا تدفق أفقي، لا نص أصغر من 12 بكسل، لا هدف أصغر من 44×44، لا اسم مقصوص، لا عنصر قابل للتركيز خلف النافذة،
      وaxe-core بلا مخالفات على الإطار، في كل الحالات وعلى العرضين. تُولَّد الملفات من <code>tools/gen_vd.py</code> وهذه الصفحة من
      <code>tools/gen_vd_spec.py</code>. صور التباين العالي محاكاة Chromium (<code>forcedColors: 'active'</code>). خط Dubai غير مثبّت
      على جهاز الالتقاط، فالصور بالخط البديل كما في G-6 وPK-3؛ الفحص على Windows عند التنفيذ.</p>
"""

FORCED_STATES = ("RefServer", "DialogRefused", "Found")


def load_states(tools: Path) -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_vd", tools / "gen_vd.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_vd"] = module  # dataclasses resolves its owner module by name
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
        return f'<figure><img src="captures/VD-{key}-{width}-light.png" alt=""><figcaption>{i + 1} · {title}</figcaption></figure>'

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/VD-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>VD-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("خريطة أسباب الرفض", table(["السبب", "العائلة", "الحالة المرسومة"], [row(a, b, c) for a, b, c in REFS])),
        section(
            "النصوص (كلها منقولة حرفيًا من " + SRC + ")",
            table(["المكان", "النص", "أين يظهر"], [row(*c) for c in COPY])
            + "<p><b>نصوص جديدة تنتظر موافقة المالك:</b> لا يوجد. التغيير الوحيد المقترح في النص هو النقطة في OD-6، ولم يُرسم.</p>",
        ),
        section("قرارات تنتظر المالك", table(["#", "النقطة", "المقترح"], [row(a, b, c) for a, b, c in DECISIONS])),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-654 · إلغاء بيع · مرجع مقترح</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_vd_spec.py")
    tools = Path(__file__).resolve().parent
    states = load_states(tools)
    (tools.parent / "VD-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote VD-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
