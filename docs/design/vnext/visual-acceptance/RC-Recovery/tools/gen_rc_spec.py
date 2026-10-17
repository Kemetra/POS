"""Generate RC-Spec.html (RT-656): the states, the copy table, the refusal map and the owner decisions.

Usage: python -I gen_rc_spec.py   (writes into this script's parent folder, RC-Recovery/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

PENDING = "بانتظار قرار المالك"

# (place, text, source). Every string is RECOVERY_COPY / recoveryRefusalMessage verbatim.
COPY = [
    ("عنوان الصفحة (h1)", "«المبيعات المعلقة»", "<code>RECOVERY_COPY.title</code>"),
    ("وضع الاستعادة", "«دخلت لإنهاء دفع معلّق على هذه الطرفية. لا يمكن البيع حتى يُكمَل الدفع أو يُلغى.»", "<code>recoveryMode</code>"),
    ("التحميل", "«جارٍ التحميل…»", "<code>loading</code>"),
    ("لوحة الدفع", "«دفع معلّق» · فارغة: «لا يوجد دفع معلّق على هذه الطرفية.»", "<code>stuckTitle</code> · <code>noneStuck</code>"),
    ("حقائق الدفع", "«الموظف» · «عدد الأصناف» · «الإجمالي» · «نقدي مدفوع» · «بطاقة مدفوعة» · «قسيمة مستخدمة» · «المتبقي»", "<code>owner</code> … <code>remaining</code>؛ سطر الدفع الصفري لا يظهر"),
    ("أزرار الدفع", "«إكمال البيع» · «إلغاء الدفع»", "<code>complete</code> · <code>cancelPayment</code>"),
    ("لوحة المبيعات", "«مبيعات محفوظة لموظفين آخرين» · فارغة: «لا توجد مبيعات محفوظة لموظفين آخرين.»", "<code>heldTitle</code> · <code>noneHeld</code>"),
    ("سطر البيع", "الاسم أو «موظف آخر» · «مسودة» / «في الدفع» · «معلّقة» · الإجمالي · «عدد الأصناف ‹n›» · «إلغاء البيع»", "<code>someoneElse</code> · <code>draft</code> · <code>handedOff</code> · <code>parked</code> · <code>cancelSale</code>"),
    ("نافذة الإجراء", "العنوان = اسم الإجراء · «رجوع» · «تأكيد»", "<code>RECOVERY_ACTION_TITLE</code> · <code>back</code> · <code>approve</code>"),
    ("النقدية", "«المتبقي: ‹مبلغ›» · «النقدية المستلمة للمتبقي»", "<code>remaining</code> · <code>cashReceived</code>"),
    ("تأكيدات الإلغاء", "«أرجعتُ النقدية المدفوعة للعميل (‹مبلغ›)» · «ألغيتُ دفع البطاقة على جهاز البطاقة»", "<code>confirmCash</code> · <code>confirmCard</code>"),
    ("الرقم السري", "«أدخل رقمك السري لتأكيد هذا الإجراء.» · «الرقم السري — ‹اسم المدير›»", "<code>approvalBody</code> · <code>pinLabel</code>"),
    ("لا رقم سري", "«لا يوجد لك رقم سري مدير مفعّل على هذه الطرفية. سجّله من شاشة الوردية، ثم عُد.»", "<code>noPin</code>"),
    ("النتائج", "«اكتمل البيع. الباقي للعميل: ‹مبلغ›» · «أُلغي الدفع وسُجّل الإرجاع.» · «أُلغي البيع المحفوظ.»", "<code>completed</code> + <code>change</code> · <code>cancelledPayment</code> · <code>cancelledSale</code>"),
]

# (reason, outcome)
REFS = [
    ("<code>listHeld</code>: <code>role_mismatch</code>", "رُسمت (Refused): «هذه الشاشة للمدير فقط.»"),
    ("<code>listHeld</code> رُفض أو تعذّر", "رُسمت (Unavailable): «تعذّر تنفيذ الإجراء. حاول مرة أخرى.» (OD-3)"),
    ("<code>listApprovers</code>: <code>approvers: []</code>", "رُسمت (NoPin)"),
    ("<code>listApprovers</code>: <code>session_locked</code>", "رُسمت (ApproverLocked): «الجهاز مقفل.»"),
    ("<code>request</code>: <code>approval_unavailable</code>", "رُسمت (WrongPin)"),
    ("سائر الأسباب (<code>not_found</code>، <code>approval_stale</code>، <code>cash_insufficient</code>، …)", "نصها من <code>recoveryRefusalMessage</code> في نفس مكان الخطأ في النافذة (كما WrongPin)، بلا حالة منفصلة"),
]

# (id, point, recommendation)
DECISIONS = [
    ("OD-1", "رأس الصفحة والتنقل", "رأس G-6: «المبيعات المعلقة» وحده بلا سطر فرعي (لا نص جديد)، والعنصر الحالي في التنقل «لوحة المتابعة» لأن الصفحة تُفتح من بطاقتها، كما رسم G-6 «الورديات العالقة». بديل: سطر فرعي بنص البطاقة الموجود «دفع معلّق، أو مبيعات محفوظة لموظفين آخرين.». <b>التوصية:</b> بلا سطر فرعي."),
    ("OD-2", "التاريخ والوقت", "الشاشة على <code>main</code> لا تعرض <code>started_at</code> ولا <code>updated_at</code>، فلا تاريخ في المراجع. إن أراد المالك وقتًا لكل سطر فهو نص جديد وتغيير عرض يُقرَّر منفصلًا، ويُكتب بخط Dubai وأرقام غربية (<code>ar-EG-u-nu-latn</code>). <b>التوصية:</b> كما على main، بلا وقت."),
    ("OD-3", "تعذّر تحميل القائمة", "النص الحالي «تعذّر تنفيذ الإجراء. حاول مرة أخرى.» يتكلم عن إجراء لا عن تحميل، ولا زر لإعادة المحاولة. رُسم كما هو. نص مخصص أو زر إعادة محاولة سلوك جديد خارج RT-656. <b>التوصية:</b> كما رُسم الآن، ومتابعة النص في عمل منفصل إن أراد المالك."),
    ("OD-4", "التركيز بعد رفض الرقم السري", "على main يُمسح الرقم السري ويتعطل «تأكيد» فيضيع التركيز. المرجع WrongPin يضع التركيز في حقل الرقم السري. هذا نقل تركيز فقط بلا تغيير في السلوك. <b>التوصية:</b> اعتماده ضمن تنفيذ RT-656."),
    ("OD-5", "زرا الإلغاء", "«إلغاء الدفع» و«إلغاء البيع» زران محايدان كما على main، لا بلون الخطر؛ كل منهما يفتح نافذة تأكيد برقم المدير السري. <b>التوصية:</b> محايدان."),
    ("OD-6", "التحميل", "على main نص عادي؛ المرجع يرسمه إشعارًا محايدًا (نفس النص) كبقية صفحات G-6. <b>التوصية:</b> كما رُسم."),
    ("OD-7", "نافذة «إلغاء البيع» لا تسمّي البيع", "كما على main: العنوان والرقم السري فقط. إضافة اسم الموظف والإجمالي في النافذة تغيير عرض بلا نص جديد. <b>التوصية:</b> كما على main، ويمكن إضافتها لاحقًا."),
]

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
    <h1>المبيعات المعلقة للمدير: مراجع الصفحة على رأس G-6</h1>
    <p><span class="status">مسودة · بانتظار موافقة المالك</span> · Jira <span class="ltr">RT-656</span> · السلوك من <span class="ltr">RT-441</span></p>
    <p><b>التصنيف:</b> مراجع شكل فقط. السلوك كما على <code>main</code> (<code>src/renderer/v5/recovery/</code>)، والبيانات من الأداة <code>#/dev/recovery-proof</code>. الإطار ورأس الصفحة واللوحات والأزرار من G-6 (<span class="ltr">RT-478</span>). كل نص مأخوذ حرفيًا؛ <b>لا نص جديد</b>.</p>
    <p>خارج النطاق: سلوك الاستعادة، وجسر الاستعادة، والعملية الرئيسية.</p>
  </header>
"""

DRAWN = """
      <li><b>رأس G-6:</b> العنوان «المبيعات المعلقة» في <code>screen-head</code> بدل شريط الوردية <code>v5-shift-mgr-head</code>، واللوحتان بشكل <code>panel</code> / <code>panel-head</code> من G-6.</li>
      <li><b>الدفع المعلّق</b> على البداية بعرض 360 (300 في 1024)، و«المتبقي» أكبر رقم في الصفحة؛ والمبيعات المحفوظة تملأ الباقي وتُمرَّر.</li>
      <li><b>الإجماليات فقط:</b> لا بنود، ولا اسم تعليق، ولا معرّف موظف؛ الموظف غير المعروف «موظف آخر». سطر دفع صفري لا يظهر.</li>
      <li><b>الحالات وسوم بنص</b> («مسودة»، «في الدفع»، «معلّقة») لا بلون وحده.</li>
      <li><b>النافذة</b> تركيزها الأول على «رجوع» كما على main، و«تأكيد» معطّل حتى يكتمل المطلوب؛ كل ما خلفها خامل.</li>
      <li><b>الخط Dubai</b> لكل نص عربي، و<b>الأرقام غربية LTR جدولية</b> للمبالغ والأعداد فقط (<code>1,284.50 EGP</code>). لا تاريخ في الشاشة (OD-2).</li>
      <li><b>لم يُرسم:</b> تحميل الموافِق داخل النافذة («جارٍ التحميل…» في نفس المكان)، وانتظار الإرسال (الأزرار معطّلة).</li>
"""

FORCED_NOTES = """
      <li>كل لوحة وزر وحقل ووسم وإشعار حدّه بلون النص؛ «المتبقي» والتحذير بحد 2 بكسل.</li>
      <li>العنصر الحالي في التنقل <code>Highlight</code>، والزر المعطّل <code>GrayText</code>، وحلقة التركيز <code>Highlight</code>.</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_rc.cjs</code> (فحوص G-3 وG-6 وPK-3 المشتركة في <code>../tools/capture-refs.cjs</code>): الاحتواء داخل الإطار، لا تدفق أفقي، لا نص أصغر من 12 بكسل،
      لا هدف أصغر من 44×44 (هدف خانة الاختيار سطرها كله كالراديو)، لا اسم مقصوص، لا عنصر قابل للتركيز خلف النافذة، وaxe-core بلا مخالفات. 36 ملفًا، صفر إخفاق.
      الملفات من <code>tools/gen_rc.py</code> وهذه الصفحة من <code>tools/gen_rc_spec.py</code>.</p>
"""

FORCED_STATES = ("Typical", "CancelPayment", "Completed")


def load_states(tools: Path) -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_rc", tools / "gen_rc.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_rc"] = module  # dataclasses resolves its owner module by name
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
        return f'<figure><img src="captures/RC-{key}-{width}-light.png" alt=""><figcaption>{i + 1} · {title}</figcaption></figure>'

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/RC-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>RC-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("خريطة أسباب الرفض", table(["السبب", "الحالة"], [row(a, b) for a, b in REFS])),
        section("النصوص (كلها مأخوذة، لا نص جديد)", table(["المكان", "النص", "المصدر"], [row(*c) for c in COPY])),
        section(
            f"قرارات المالك ({PENDING})",
            table(["#", "النقطة", "المقترح"], [row(a, b, c) for a, b, c in DECISIONS]),
        ),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-656 · المبيعات المعلقة · مرجع</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_rc_spec.py")
    tools = Path(__file__).resolve().parent
    states = load_states(tools)
    (tools.parent / "RC-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote RC-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
