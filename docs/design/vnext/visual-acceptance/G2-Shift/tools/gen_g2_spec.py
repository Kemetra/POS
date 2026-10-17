"""Generate G2-Spec.html (RT-658): the states, the copy table and the owner decisions.

Usage: python -I gen_g2_spec.py   (writes into this script's parent folder, G2-Shift/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

TAKEN = "مأخوذ حرفيًا"

# (place, text, source). Every line is verbatim from src/renderer/v5/shift/shift-copy.ts
# (SHIFT_COPY, MOVEMENT_REASON_LABELS, the refusal map) or src/renderer/v5/park/park-copy.ts.
COPY = [
    ("عنوان صفحة الكاشير", "«الوردية»", "<code>SHIFT_COPY.title</code>"),
    ("عنوان صفحة المدير", "«حالة الوردية»", "<code>SHIFT_COPY.managerTitle</code>"),
    ("بطاقة الفتح", "«فتح وردية» · «مبلغ الافتتاح في الدرج» · «فتح الوردية»", "<code>openHeading</code> · <code>floatLabel</code> · <code>openCommit</code>"),
    ("مبلغ غير صالح", "«أدخل مبلغًا صحيحًا بخانتين عشريتين على الأكثر.»", "<code>invalidAmount</code>"),
    ("بعد الفتح", "«فُتحت الوردية.» + «الذهاب إلى البيع»", "<code>opened</code> · <code>goToSale</code>"),
    ("بطاقة الملخص", "«وردية مفتوحة منذ ‹التاريخ›» · «مبلغ الافتتاح» · «إجمالي الإيداعات» · «إجمالي السحوبات»", "<code>openSince</code> · <code>floatRow</code> · <code>payInsRow</code> · <code>payOutsRow</code>؛ التاريخ من <code>formatHumanDateTime</code>"),
    ("الحركات", "«إيداع نقدي» · «سحب نقدي» · «المبلغ» · «السبب» · «ملاحظة (اختياري، دون بيانات شخصية)» · «إلغاء» · «تسجيل»", "<code>payIn</code> · <code>payOut</code> · <code>amountLabel</code> · <code>reasonLabel</code> · <code>noteLabel</code> · <code>cancel</code> · <code>record</code>"),
    ("أسباب الحركة", "«إيداع بنكي» · «تزويد الفكة» · «مصروف نثري» · «أخرى»", "<code>MOVEMENT_REASON_LABELS</code>"),
    ("سحب مرفوض", "«لم يُقبل السحب، ولم يُسجَّل شيء. راجع المدير.»", "<code>pay_out_not_accepted</code>"),
    ("بعد الحركة", "«سُجّل الإيداع.» / «سُجّل السحب.»", "<code>recordedIn</code> · <code>recordedOut</code>"),
    ("بطاقة الإغلاق", "«إغلاق الوردية» · «عُدّ النقد في الدرج وأدخله. لا يظهر المبلغ المتوقع قبل تسجيل العدّ.» · «النقد المعدود في الدرج» · «تسجيل العدّ وإغلاق الوردية»", "<code>closeHeading</code> · <code>blindHint</code> · <code>countLabel</code> · <code>closeCommit</code>"),
    ("موافقة المدير", "«موافقة المدير» · «لا يُغلق هذا العدّ إلا بموافقة مدير مسجَّل على هذا الجهاز، برقمه السري.» · «المدير» · «الرقم السري للمدير» · «اعتماد وإغلاق»", "<code>approvalTitle</code> · <code>approvalBody</code> · <code>managerLegend</code> · <code>pinLabel</code> · <code>approveCommit</code>"),
    ("بعد الإغلاق", "«أُغلقت الوردية.» · «فرق العدّ المعتمد: ‹المبلغ›» (للإغلاق المعتمد فقط)", "<code>closed</code> · <code>varianceLabel</code>"),
    ("الإغلاق مع مبيعات معلّقة", "«توجد مبيعات معلّقة على هذا الجهاز. استأنفها أو اطلب من المدير إلغاءها ثم أغلق الوردية.» · «3 مبيعات معلّقة على هذا الجهاز» · «عرض مبيعاتي المعلّقة»", "<code>parked_sales_present</code> · <code>terminalParkedCount</code> · <code>PARK_COPY.showMyParked</code> (كما في PK3-ShiftClose)"),
    ("تعذّرت القراءة", "«تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.» + «إعادة المحاولة»", "<code>unavailable</code> · <code>retry</code>"),
    ("بطاقة الحالة", "«حالة الوردية على هذا الجهاز» · «تحديث» · «لا توجد وردية مفتوحة.»", "<code>statusHeading</code> · <code>refresh</code> · <code>noOpenShift</code>"),
    ("مجموعات العدد", "«وقائع الوردية غير المؤكَّدة على الخادم» (بانتظار الإرسال · بانتظار إعادة المحاولة · متوقفة · بانتظار مسار المدير) · «خارج إقران هذا الجهاز» (وقائع غير مرسلة · ورديات مفتوحة) · «نشاط درج لم يكتمل» (صرف مرتجعات · مبيعات لم تكتمل) · «محاولات مرفوضة في الوردية المفتوحة (منذ آخر تشغيل)» (سحب غير مقبول · إغلاق بفرق دون موافقة · موافقة مدير غير مقبولة)", "<code>queue*</code> · <code>stranded*</code> · <code>pending*</code> · <code>probe*</code>"),
    ("تنبيه الإقران السابق", "«تنبيه: على هذا الجهاز سجلات وردية من إقران سابق تعذّر إرسالها. قبل إلغاء ترخيص أي جهاز أو إعادة تعيينه، يجب إغلاق الوردية المفتوحة وتفريغ طابور المزامنة.»", "<code>strandedWarning</code>"),
    ("الرقم السري للمدير", "«الرقم السري للمدير على هذا الجهاز» · «يُستخدم لاعتماد فرق العدّ…» · «الرقم السري الجديد (6 إلى 8 أرقام)» · «تأكيد الرقم السري» · «الرقم السري الحالي (عند التغيير فقط)» · «حفظ الرقم السري»", "<code>enrollHeading</code> · <code>enrollHint</code> · <code>newPinLabel</code> · <code>confirmPinLabel</code> · <code>currentPinLabel</code> · <code>enrollCommit</code>"),
    ("نتيجة الحفظ", "«حُفظ الرقم السري لهذا الجهاز.» · «الرقمان غير متطابقين.»", "<code>enrolled</code> · <code>pinMismatch</code>"),
]

# (id, point, recommendation). Pending the owner.
DECISIONS = [
    ("G2-D1", "حالات زائدة على قائمة المهمة",
     "رُسمت أيضًا موافقة المدير (CloseApproval) والإغلاق بفرق معتمد (ClosedApproved) وتعذّر القراءة (Unavailable، MgrUnavailable) وحفظ الرقم السري (MgrPinSaved، MgrPinError)، لأنها جزء من المسار نفسه على <code>main</code>. <b>التوصية:</b> تُعتمد ضمن G-2."),
    ("G2-D2", "الأعداد في صفحة المدير",
     "المهمة تقول «المبالغ وحدها LTR بأرقام جدولية». الأعداد (طابور المزامنة والمحاولات) كميات، وDESIGN.md يجعل الكميات LTR جدولية أيضًا، فرُسمت كذلك. <b>التوصية:</b> كما رُسمت؛ والتواريخ والكلمات العربية بخط Dubai دائمًا."),
    ("G2-D3", "تخطيط شاشة الكاشير",
     "بلا وردية: بطاقة الفتح وحدها. مع وردية: بطاقة الملخص وبطاقة الإغلاق جنبًا إلى جنب (كما هي الأعمدة اليوم)، والمبلغ المتوقع لا يظهر في أي حالة. <b>التوصية:</b> كما رُسم."),
    ("G2-D4", "بعد الإغلاق",
     "يبقى إشعار «أُغلقت الوردية.» فوق بطاقة الفتح، لأن الشاشة على <code>main</code> تعيد قراءة الحالة فتعرض نموذج الفتح. <b>التوصية:</b> كما رُسم، بلا سلوك جديد."),
    ("G2-D5", "التنقل في صفحة المدير",
     "«لوحة المتابعة» هي العنصر الحالي، لأن الصفحة تُفتح من بطاقة «حالة الوردية» فيها (كما في الورديات العالقة في G-6). <b>التوصية:</b> كما رُسم."),
    ("G2-D6", "نص «الذهاب إلى البيع»",
     "رابط على <code>main</code>، ورُسم كزر داخل إشعار النجاح (نمط إجراء الإشعار في G-6). <b>التوصية:</b> كما رُسم."),
    ("G2-D7", "سطر الرفض",
     "<code>ShiftAlert</code> اليوم فقرة <code>role=alert</code> بلا رمز؛ ترسمه المراجع بتشريح الإشعار (رمز تحذير + جملة) في المكان نفسه. <b>التوصية:</b> كما رُسم."),
]

NOT_DRAWN = """
      <li>«جارٍ تحميل حالة الوردية…» و«جارٍ تحميل المديرين…»: سطر نصي واحد في مكان البطاقة، بلا حالة مرسومة.</li>
      <li>شريط «لا توجد وردية مفتوحة…» في الإطار (<code>ShiftNotice</code>): جزء من الإطار وليس من صفحة الوردية، وخارج RT-658.</li>
      <li>بقية أسباب الرفض (مثل <code>drawer_activity_pending</code> و<code>approver_invalid</code>): تظهر بنصها الحرفي في مكان الرفض المرسوم نفسه.</li>
"""

DRAWN = """
      <li><b>مفردات G-6:</b> رأس الصفحة <code>.screen-head</code> (عنوان h1 بلا شريط غائر)، والبطاقات <code>.panel</code> برأس <code>.panel-head</code>، والنوافذ <code>.dialog</code> فوق ستار، والإشعارات برمز وجملة. تُستبدل بها <code>.v5-shift-titlebar</code> و<code>v5-shift-panel</code> و<code>v5-shift-facts</code>.</li>
      <li><b>الخط:</b> كل كلمة عربية، ومنها التاريخ «17 أكتوبر، 08:05»، بخط Dubai. المبالغ وحدها (والأعداد، G2-D2) LTR بخط mono وأرقام جدولية، وكذلك حقل المبلغ.</li>
      <li><b>العدّ الأعمى:</b> لا يظهر المبلغ المتوقع في أي حالة؛ فرق العدّ يظهر بعد الإغلاق المعتمد فقط.</li>
      <li><b>الإغلاق مع مبيعات معلّقة:</b> النص والعدد والزر ومكان الإشعار (بين الحقل وزر الإغلاق) كما في <code>PK3-ShiftClose</code>؛ الجديد فقط أن الشاشة كاملة (الملخص بجانبها) ورأس G-6.</li>
      <li><b>الأدوار:</b> صفحة الكاشير بإطار الكاشير («نقطة البيع» وحدها)، وصفحة المدير بإطار المدير الكامل.</li>
      <li><b>لا سلوك جديد:</b> لا حقل ولا نداء ولا قدرة جديدة؛ قواعد الوردية والحساب والجسر خارج النطاق.</li>
"""

FORCED_NOTES = """
      <li>كل حد (البطاقة، الزر، الحقل، القائمة، الشارة) يصبح حدًّا بلون النص؛ وحدّ التحذير 2 بكسل.</li>
      <li>الأزرار المعطّلة بلون <code>GrayText</code>، وحلقة التركيز <code>Highlight</code>، والعنصر الحالي في التنقل <code>Highlight</code>.</li>
      <li>العدد غير الصفري في صفحة المدير شارة بإطار، لا لون فقط.</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_g2.cjs</code> (نفس فحوص G-3 وG-6 وPK-3 في <code>../tools/capture-refs.cjs</code>): الاحتواء داخل الإطار، لا تدفق أفقي،
      لا نص أصغر من 12 بكسل، لا هدف أصغر من 44×44، لا اسم مقصوص، لا عنصر قابل للتركيز خلف النافذة، وaxe-core بلا مخالفات على الإطار.
      النتيجة: 40 ملفًا، صفر إخفاق. تُولَّد الملفات من <code>tools/gen_g2.py</code> وهذه الصفحة من <code>tools/gen_g2_spec.py</code>.</p>
"""

HEADER = """
  <header>
    <h1>الوردية (G-2): الفتح والحالة والحركات النقدية والإغلاق وحالة الوردية للمدير</h1>
    <p><span class="status">معتمد من المالك (<span class="ltr">2026-10-17</span>)</span> · Jira <span class="ltr">RT-658</span> (التعليق <span class="ltr">12455</span>) · تغلق الفجوة G-2 في الوثيقة 15</p>
    <p>وافق المالك على هذه المراجع كما رُسمت، وعلى القرارات G2-D1 حتى G2-D7 كما أوصي بها (Jira <span class="ltr">RT-658</span>، التعليق <span class="ltr">12455</span>). دُمجت في <code>main</code> عبر <span class="ltr">#736</span> (<code>0725cfa</code>).</p>
    <p><b>المرجع السلوكي:</b> شاشات RT-17 على <code>main</code> (<code>src/renderer/v5/shift/</code>) وحالة <code>PK3-ShiftClose</code> (RT-471/RT-445). الشكل على مفردات G-6 (RT-478).
      لا سلوك جديد ولا نص جديد: كل النصوص حرفية من <code>shift-copy.ts</code> و<code>park-copy.ts</code>.</p>
    <p><b>نصوص جديدة بانتظار الموافقة:</b> لا يوجد.</p>
  </header>
"""

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

FORCED_STATES = ("ParkedBlocked", "CloseApproval", "MgrStranded")


def load_states(tools: Path) -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_g2", tools / "gen_g2.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_g2"] = module  # dataclasses resolves its owner module by name
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
        return f'<figure><img src="captures/G2-{key}-{width}-light.png" alt=""><figcaption>{i + 1} · {title}</figcaption></figure>'

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/G2-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>G2-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض). الحالات 1–14 للكاشير (<code>/app/shift</code>) و15–20 للمدير (<code>/app/shift/manager</code>).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("ما لم يُرسم", f"<ul>{NOT_DRAWN}</ul>"),
        section("النصوص (حرفية من الكتالوج الموجود)", table(["المكان", "النص", "المصدر", "الحالة"], [row(a, b, c, TAKEN) for a, b, c in COPY])),
        section("قرارات المالك (معتمدة 2026-10-17، RT-658 التعليق 12455)", table(["#", "النقطة", "ما رُسم والتوصية"], [row(a, b, c) for a, b, c in DECISIONS])),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-658 G-2 · الوردية · مرجع مقترح</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g2_spec.py")
    tools = Path(__file__).resolve().parent
    states = load_states(tools)
    (tools.parent / "G2-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote G2-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
