"""Generate G6R-Spec.html (RT-660): the states, the copy table, the refusal map and the owner decisions.

Status: DRAFT, pending owner approval. The decisions RD-1…RD-10 are proposed, not decided.

Usage: python -I gen_g6r_spec.py   (writes into this script's parent folder, G6-Returns/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

TAKEN = "منسوخ حرفيًا"

# (place, text, source). Every string is copied verbatim; check_g6r_copy.py proves it.
COPY = [
    ("عنوان الشاشة", "«المرتجعات»", "<code>ReturnsRoute.tsx</code> (ScreenSection)"),
    ("البحث", "«البحث عن بيع» · «رقم البيع» · «بحث»", "<code>SaleLookup.tsx</code>"),
    ("رقم فارغ", "«أدخل رقم البيع.»", "<code>ReturnNotice.tsx</code> (<code>empty</code>)"),
    ("رفض البحث", "نص السبب من <code>REFUSAL_COPY</code> (مثل <code>sale_not_found</code> و<code>card_tender_blocked</code> و<code>offline</code>)", "<code>returns-messages.ts</code>"),
    ("اختيار الأصناف", "«اختر الأصناف المرتجعة» · «بيع رقم» · «مباع · مُرجع سابقًا · سعر الوحدة» · «أُرجع بالكامل» · «بحث عن بيع آخر» · «احسب مبلغ الاسترداد»", "<code>LinePicker.tsx</code>"),
    ("أسماء أزرار الكمية", "«إنقاص ‹الصنف›» · «كمية ‹الصنف›» · «زيادة ‹الصنف›»", "<code>LinePicker.tsx</code> (aria-label)"),
    ("الملخص", "«ملخص الاسترداد» · الصنف / الكمية / المبلغ · «إجمالي الاسترداد» · «طريقة الاسترداد: نقدًا فقط.» · «تعديل الكميات» · «تأكيد الإرجاع»", "<code>RefundSummary.tsx</code>"),
    ("النتيجة", "«نتيجة المرتجع» · «رقم البيع» · «مبلغ الاسترداد النقدي» / «المبلغ المطلوب» · «مرجع الخادم» · «تحقّق مجددًا» · «مرتجع جديد»", "<code>ReturnOutcome.tsx</code>"),
    ("سطر النتيجة", "<code>OUTCOME_COPY.confirmed / unconfirmed / submitFailed / mayBeRecorded</code> ونص السبب", "<code>returns-messages.ts</code>"),
    ("صرف النقد", "كل نصوص <code>PAYOUT_COPY</code> و<code>DRAWER_FAILURE_COPY</code>، و«بدأ الصرف:»", "<code>returns-messages.ts</code> و<code>PayoutPanel.tsx</code>"),
    ("السجل", "«سجل المرتجعات على هذا الجهاز» · «تحقّق من غير المؤكدة» · الأعمدة · «إعادة تحميل السجل» · <code>OUTCOME_COPY.historyEmpty</code>", "<code>ReturnsHistory.tsx</code>"),
    ("حالة الصف", "«قيد الإرسال» · «مسجَّل على الخادم» · «صُرف نقدًا» · «مرفوض» · «غير مؤكد»", "<code>STATE_LABELS</code>"),
    ("إجراء الصف", "«صرف» · «إكمال الصرف» · «طباعة نسخة» (والاسم المسموع «‹الإجراء› ‹رقم البيع›»)", "<code>PAYOUT_COPY.history*</code>"),
    ("بوابة الشاشة", "«المرتجعات غير مفعّلة على هذا الجهاز.» (ومثلها <code>role_denied</code> و<code>bridgeMissing</code>)", "<code>ReturnsRoute.tsx</code>"),
]

# (reason or phase, drawn as)
REFS = [
    ("البحث: <code>empty</code>", "LookupBlank"),
    ("البحث: <code>sale_not_found</code>", "LookupNotFound"),
    ("البحث: أي رفض آخر (مثال <code>card_tender_blocked</code>، <code>offline</code>)", "LookupRefused وLookupOffline؛ النمط نفسه لكل سبب"),
    ("الحساب: رفض (مثال <code>quantity_out_of_range</code>)", "SelectRefused؛ النمط نفسه لكل سبب"),
    ("الإرسال: <code>confirmed</code>", "PayoutReady (والنتيجة فوق الصرف)"),
    ("الإرسال: <code>unconfirmed</code>", "OutcomeUnconfirmed («تحقّق مجددًا»)"),
    ("الإرسال: رفض", "OutcomeRefused؛ وبلا صف في السجل مع سبب قد يلي الإرسال: OutcomeMayBeRecorded"),
    ("الإرسال: فشل النداء", "OutcomeFailed"),
    ("الصرف: <code>ready</code> / أثناء الفتح", "PayoutReady / PayoutOpening"),
    ("الصرف: <code>paid</code> (درج / بلا درج / فشل الإيصال / فشل النسخة)", "PayoutPaid / PayoutNoDrawer / PayoutSlipFailed / PayoutReprintFailed"),
    ("الصرف: <code>drawer_failed</code> قابل للإعادة / غير معروف", "PayoutDrawerFailed / PayoutDrawerUnknown"),
    ("الصرف: <code>confirm_manual</code>", "PayoutConfirmManual (التركيز على «إلغاء»)"),
    ("الصرف: <code>interrupted</code>", "PayoutInterrupted"),
    ("الصرف: <code>wait</code> (مثال <code>another_payout_in_progress</code>)", "PayoutWait"),
    ("الصرف: <code>refused</code> (مثال <code>already_paid_out</code>)", "PayoutRefused، بلا زر"),
    ("الصرف: <code>unknown</code>", "PayoutUnknown"),
    ("السجل: فارغ / صفوف / فشل النسخة / فشل التحميل", "HistoryEmpty / HistoryRows / HistoryReprintFailed / HistoryFailed"),
    ("البوابة: <code>feature_disabled</code> / <code>role_denied</code> / بلا جسر", "Disabled؛ النمط نفسه للثلاثة"),
]

PENDING = "مقترح، بانتظار المالك"

# (id, point, proposal)
DECISIONS = [
    ("RD-1", "مكان المراجع", "مجلد مستقل <code>G6-Returns/</code> بالبادئة <code>G6R</code>، يستورد <code>G6-Manager/g6.css</code> المجمّد كما هو ويضيف <code>g6r.css</code> لما تحتاجه المرتجعات فقط. <code>G6-Returns-*</code> في G6-Manager يبقى مرجع الإطار، وهذه المراجع تحل محله للمحتوى."),
    ("RD-2", "ألوان الحالات", "تبقى دلالة الألوان كما شُحنت: الرفض وعدم التأكيد بلون الخطر مع رمز ×، والتأكيد بالأخضر، وألوان الصرف كما في <code>PayoutPanel</code> (محايد / نجاح / تنبيه / خطر). البديل: الرفض بالكهرماني كما في صفحات G-6 الأخرى."),
    ("RD-3", "التخطيط", "الخطوة فوق السجل كما شُحنت. السجل يملأ الباقي ويتمرر جدوله. في النتيجة المؤكدة يقف الإعلان والحقائق بجانب «صرف النقد» (عمودان داخل اللوحة) ليتسع كل شيء في 1024×768."),
    ("RD-4", "التركيز", "عنوان الخطوة يأخذ التركيز (<code>useFocusOnMount</code>)، ويُرسم بحلقة التركيز المشتركة. في تأكيد الصرف اليدوي يقع التركيز على «إلغاء»."),
    ("RD-5", "وسم حالة الصف", "وسم G-6 نفسه مع رمز لكل حالة: ساعة لقيد الإرسال، وعلامة صح لمسجَّل، وورقة نقد لصُرف، و× لمرفوض، وعلامة استفهام لغير مؤكد. «قيد الإرسال» محايد (اللون الأزرق المشحون ليس في لوحة G-6)."),
    ("RD-6", "الصنف المُرجع بالكامل", "وسم محايد «أُرجع بالكامل» مع علامة صح مكان أزرار الكمية (كان نصًا عاديًا)."),
    ("RD-7", "أزرار الكمية", "مجموعة واحدة بحد واحد: − ‹الكمية› +، كل زر 44 بكسل، والزر المعطّل بلون خافت."),
    ("RD-8", "الأرقام", "المبالغ والرموز (رقم البيع، مرجع الخادم) LTR بخط أحادي وأرقام جدولية. الوقت نص عربي بأرقام غربية كما يكتبه <code>formatReturnTime</code>، لا خط أحادي."),
    ("RD-9", "تسلسل الأزرار", "كما شُحن لكل خطوة: زر رئيسي واحد لكل منطقة، والبقية ثانوية، و«بحث عن بيع آخر» شفاف."),
    ("RD-10", "النصوص", "لا نص جديد: كل نص منسوخ حرفيًا من الشفرة المشحونة (يثبته <code>tools/check_g6r_copy.py</code>). عناوين الملفات وهذه الصفحة توثيق فقط."),
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
  a { color:var(--primary); }
  ul { margin:0; padding-inline-start:20px; }
"""

HEADER = """
  <header>
    <h1>محتوى المرتجعات على عناصر G-6 المشتركة: مراجع RT-660</h1>
    <p><span class="status">مسودة: بانتظار موافقة المالك</span> · Jira <span class="ltr">RT-660</span> · السلوك <span class="ltr">RT-15</span> كما شُحن · الإطار <span class="ltr">RT-501</span> وG-6 (<span class="ltr">RT-478</span>)</p>
    <p><b>التصنيف:</b> مراجع شكل فقط. السلوك والنصوص كما هي على <code>main</code> في <code>src/renderer/returns/</code>؛ لا حالة ولا نداء ولا قدرة جديدة. البيانات (أسماء، أرقام، أوقات) للتوضيح فقط.</p>
    <p>تحل هذه المراجع محل «G6-Returns» في حزمة G-6، الذي كان يرسم الإطار فقط بمحتوى بديل.</p>
  </header>
"""

DRAWN = """
      <li><b>عناصر G-6 المشتركة:</b> الإطار والتنقل واللوحة ورأسها والزر والحقل والتنبيه (رمز + جملة) ووسم الحالة وقائمة الحقائق، من <code>g6.css</code> المجمّد بلا تعديل.</li>
      <li><b>ما أُضيف في <code>g6r.css</code>:</b> أزرار الكمية، والجدول، وصندوق الإجمالي، ووسما الخطر والمحايد، وتخطيط النتيجة والصرف. لا شيء آخر.</li>
      <li><b>لا نجاح إلا بتأكيد الخادم:</b> «تم تسجيل المرتجع» وحده أخضر؛ غير المؤكد يعرض «تحقّق مجددًا» ولا يبدو مكتملًا.</li>
      <li><b>الصرف صادق:</b> «سُجّل الصرف» فقط بعد تسجيل main له؛ فشل الدرج يقول إنه لم يُسجَّل شيء؛ الصرف اليدوي خطوة ثانية تركيزها الأول «إلغاء».</li>
      <li><b>المبلغ الأكبر:</b> «إجمالي الاسترداد» و«المبلغ المستحق للعميل» أكبر رقم في الخطوة، LTR بأرقام جدولية.</li>
      <li><b>كل هدف 44 بكسل فأكثر</b>، ولا نص أصغر من 12 بكسل، والحالة لا تعتمد على اللون وحده.</li>
      <li><b>لم يُرسم:</b> حالة «جارٍ تحميل السجل…» (سطر نص فقط)، ورفض السجل (نفس تنبيه الرفض)، و«هذا المرتجع مسجَّل من قبل» (<code>replayed</code>، نفس شكل التأكيد).</li>
"""

FORCED_NOTES = """
      <li>كل حد (اللوحة، الزر، الحقل، الجدول، أزرار الكمية، صندوق الصرف، الإجمالي) يصبح حدًّا بلون النص؛ وحدّا التنبيه والخطر 2 بكسل.</li>
      <li>الأزرار المعطّلة بلون <code>GrayText</code>، وحلقة التركيز وعنوان الخطوة المركّز <code>Highlight</code>، والصفحة الحالية في التنقل <code>Highlight</code>.</li>
      <li>المعنى لا يعتمد على اللون: لكل حالة صف رمزها، ولكل تنبيه رمز نبرته.</li>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_g6r.cjs</code> (نفس فحوص G-3 وG-6 وPK-3 في <code>../tools/capture-refs.cjs</code>): الاحتواء داخل الإطار،
      لا تدفق أفقي، لا نص أصغر من 12 بكسل، لا هدف أصغر من 44×44، لا اسم مقصوص، وaxe-core بلا مخالفات على الإطار. النصوص فُحصت بـ<code>tools/check_g6r_copy.py</code>:
      كل نص عربي في الملفات موجود حرفيًا في الشفرة المشحونة أو بيانات العينة. تُولَّد الملفات من <code>tools/gen_g6r.py</code> وهذه الصفحة من <code>tools/gen_g6r_spec.py</code>.</p>
    <p>الصور التُقطت على Linux بلا خط Dubai (الخط البديل)، كما في الحزم السابقة؛ الخط على Windows هو Dubai.</p>
"""

FORCED_STATES = ("LookupNotFound", "SelectPicked", "Quote", "PayoutDrawerFailed", "HistoryRows")


def load_states(tools: Path) -> list[tuple[str, str]]:
    spec = importlib.util.spec_from_file_location("gen_g6r", tools / "gen_g6r.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_g6r"] = module  # dataclasses resolves its owner module by name
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
        return f'<figure><img src="captures/G6R-{key}-{width}-light.png" alt=""><figcaption>{i + 1} · {key} · {title}</figcaption></figure>'

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/G6R-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def build(states: list[tuple[str, str]]) -> str:
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>G6R-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("خريطة الحالات والرفض في RT-15", table(["الحالة في الشفرة", "المرجع"], [row(a, b) for a, b in REFS])),
        section("النصوص (لا نص جديد)", table(["المكان", "النص", "المصدر", "الحالة"], [row(a, b, c, TAKEN) for a, b, c in COPY])),
        section("قرارات للمالك", table(["#", "النقطة", "المقترح", "الحالة"], [row(a, b, c, PENDING) for a, b, c in DECISIONS])),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>RT-660 G-6 Returns · مرجع</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>{HEADER}{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    # The pack folder is this script's parent: no path is taken from the command line.
    if len(sys.argv) != 1:
        sys.exit("usage: python -I gen_g6r_spec.py")
    tools = Path(__file__).resolve().parent
    states = load_states(tools)
    (tools.parent / "G6R-Spec.html").write_text(build(states), encoding="utf-8")
    print(f"[OK] wrote G6R-Spec.html ({len(states)} states)")


if __name__ == "__main__":
    main()
