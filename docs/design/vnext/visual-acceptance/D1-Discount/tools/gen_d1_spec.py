"""Generate D1-Spec.html (RT-853, RT-699 slice D1): the states, the copy table, the refusal map,
the open owner decisions and the checks. Visual DRAFT, awaiting owner sign-off.

Usage: python -I gen_d1_spec.py   (writes into this script's parent folder, D1-Discount/)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

SHIPPED = "مأخوذ (شُحن)"
OWNER = "مأخوذ (قرار المالك)"
NEW = "<b>جديد — للاعتماد</b>"


def load_gen(tools: Path):
    spec = importlib.util.spec_from_file_location("gen_d1", tools / "gen_d1.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_d1"] = module  # dataclasses resolves its owner module by name
    spec.loader.exec_module(module)
    return module


def copy_table(g) -> list[tuple[str, str, str, str]]:
    """(place, text, basis, status)."""
    return [
        ("زر فتح الخصم (رأس السلة)", f"«{g.S_DISCOUNT}»", "OD-28-11 والوثيقة 28 §4.1", OWNER),
        ("أسباب الخصم", " · ".join(f"«{label}» (<code>{code}</code>)" for code, label in g.REASONS), "OD-28-9، الوثيقة 28 §11.2", OWNER),
        ("سطر الخصم (سلة، دفع، إيصال)", "«خصم 10%» للنسبة · «خصم» وحده للمبلغ · والمبلغ بعلامة <span class='ltr'>−</span>", "OD-28-11", OWNER),
        ("صف المجموع", f"«{g.S_DISCOUNT_TOTAL}»", "OD-28-11 (للإيصال)؛ استعماله في السلة والدفع OD-3", OWNER + " · OD-3"),
        ("إزالة الخصم", f"«{g.S_REMOVE_DISCOUNT}»", "<code>LiveSaleCart.tsx</code> (D4)", SHIPPED),
        ("نافذة الموافقة", f"«{g.S_APPROVAL_TITLE}» · «{g.S_MANAGER_LEGEND}» · «{g.S_PIN_LABEL}» · «{g.S_CANCEL}»", "<code>shift-copy.ts</code> (نمط RT-114)", SHIPPED),
        ("الدفع والإتمام", f"«{g.S_PAY}» · «{g.S_BACK}» · «{g.S_ORDER}» · «{g.S_ORDER_SUBTOTAL}» · «{g.S_TENDER}» · «{g.S_DUE}» · «{g.S_NEW_SALE}» · «{g.S_RECEIPT_PENDING}»", "<code>checkout/</code> و<code>PaymentSurface.tsx</code>", SHIPPED),
        ("السلة", f"«{g.S_CART}» · «{g.S_NOTE}» · «{g.S_DELETE}» · «{g.S_SUBTOTAL}» · «{g.S_TAX}» · «{g.S_GRAND}» · «{g.S_PARK}» · «{g.S_VOID}» · «{g.S_SCAN_PAUSED}»", "<code>v5/sale/</code> و<code>scan-messages.ts</code>", SHIPPED),
        ("عنوان النافذة", f"«{g.N_SHEET_TITLE}»", "الوثيقة 28 §4.1", NEW),
        ("تنبيه الكاشير في النافذة", f"«{g.N_SHEET_NEEDS_APPROVAL}»", "§4.1", NEW),
        ("نوع الخصم", f"«{g.N_KIND}» · «{g.N_KIND_PCT}» · «{g.N_KIND_AMT}»", "OD-28-1 = C", NEW),
        ("القيمة", f"«{g.N_VALUE}» · «{g.N_HELP_PCT}» · «حتى إجمالي الصنف: 90.00 EGP.»", "OD-28-2 = A، §3.1", NEW),
        ("السبب", f"«{g.N_REASON}» · «{g.N_REQUIRED}» · «{g.N_PICK_REASON}»", "OD-28-9 (مطلوب في المسارين)", NEW),
        ("المعاينة", f"«{g.N_PREVIEW_GROSS}» · «{g.N_PREVIEW_DISCOUNT}» · «{g.N_PREVIEW_NET}» · «{g.N_PREVIEW_NOTE}»", "§4.1 خطوة 2: المعاينة للعرض فقط ويحسب main المبلغ", NEW),
        ("زر الكاشير", f"«{g.N_REQUEST_APPROVAL}»", "§4.1 خطوة 3", NEW),
        ("زر المدير", f"«{g.N_APPLY}»", "§4.2 (بلا موافقة)", NEW),
        ("نص الموافقة", f"«{g.N_APPROVAL_BODY}»", "صياغة <code>approvalBody</code> للخصم", NEW),
        ("ملخص الموافقة", f"«{g.N_APPROVE_ITEM}» · «{g.N_APPROVE_DISCOUNT}» · «{g.N_APPROVE_REASON}»", "الموافقة تربط القيمة والسبب (§3.1، §4.1)", NEW),
        ("زر الاعتماد", f"«{g.N_APPROVE_COMMIT}»", "مقابل «اعتماد وإغلاق» في الوردية", NEW),
        ("صاحب الموافقة على السطر", "«بموافقة: ‹اسم المدير›»", "§4.1 خطوة 6 (O2)، وفي مسار المدير اسمه هو", NEW),
        ("مبلغ أكبر من الإجمالي", f"«{g.N_OVER_GROSS}»", "§3.2؛ <code>invalid_payload</code> إن وصل إلى main (OD-6)", NEW),
        ("الموافقة غير صالحة", f"«{g.N_APPROVAL_INVALID}»", "<code>approval_invalid</code> (OD-7)", NEW),
        ("الموافقة قديمة", f"«{g.N_APPROVAL_STALE}» · زر «{g.N_BACK_TO_SHEET}»", "<code>approval_stale</code> (OD-7)", NEW),
        ("تغيير كمية صنف مخصوم", f"«{g.N_LINE_DISCOUNTED}» · والبديل «{g.N_LINE_DISCOUNTED_HINT}»", "OD-28-7؛ الرمز الجديد (مثال الوثيقة 28 §7: <code>line_discounted</code>) يحدده RT-854 (OD-4)", NEW),
        ("خصم ثانٍ", f"«{g.N_ALREADY_APPLIED}»", "OD-28-6؛ الرمز الجديد (مثال §7: <code>discount_already_applied</code>) يحدده RT-854 (OD-5)", NEW),
        ("الدفع بإجمالي صفر", f"«{g.N_ZERO_DUE}»", "OZ-1 = Z-A", NEW),
        ("إجراء الإتمام", f"«{g.N_COMPLETE}»", "OZ-1 = Z-A: إجراء واحد (OD-8)", NEW),
        ("الإتمام بإجمالي صفر", f"«{g.N_ZERO_PROOF}» + <span class='ltr'>0.00 EGP</span>", "بلا «تم استلام المبلغ» ولا «الباقي للعميل»، وبلا «اكتمل البيع» (قاعدة <code>CompletionPanel</code>)", NEW),
    ]


REFUSALS = [
    ("كاشير بلا <code>approval_id</code>: <code>manager_attribution_required</code>", "لا يصل إليه المسار المرسوم: زر الكاشير يطلب الموافقة دائمًا. إن ظهر يعرض «يحتاج الخصم موافقة مدير قبل تطبيقه.»"),
    ("<code>approval_invalid</code> (منتهية، مستهلكة، نوع أو موضوع آخر)", "ApprovalInvalid: داخل نافذة الموافقة، يُمسح الرقم السري ويُطلب من جديد"),
    ("<code>approval_stale</code> (تغيّر إصدار السطر)", "ApprovalStale: داخل النافذة، والزر الأساسي «رجوع إلى الخصم»"),
    ("<code>invalid_payload</code>: مبلغ أكبر من الإجمالي، نسبة خارج 1–100، رمز غير قانوني", "SheetOverGross: خطأ تحت الحقل والزر معطّل قبل أي نداء؛ النسبة تقبل رقمًا صحيحًا فقط"),
    ("خصم ثانٍ على السطر (OD-28-6)", "SecondRefused: تنبيه في عمود المبلغ"),
    ("تغيير كمية سطر مخصوم (OD-28-7)", "QtyRefused (بعد الضغط) أو QtyDisabled (معطّل مسبقًا): OD-4"),
    ("سلة مجمّدة أو معلّقة أو لجلسة أخرى · <code>unauthorized_discount</code> · رفض الدفع 3b", "رموز موجودة ونصوصها كما هي؛ لا حالة جديدة"),
]

DECISIONS = [
    ("OD-1", "مكان زر «خصم»", "<b>المرسوم (أ):</b> زر واحد «خصم» في رأس السلة يعمل على الصنف المحدد (آخر صنف أضيف افتراضيًا، أو الصف الذي عليه التركيز)، ويُعطَّل بلا تحديد. <b>(ب)</b> زر ثالث في عمود إجراءات كل صف: يضيق عمود الاسم، وعند 1024 يقل عن 60 بكسل. <b>(ج)</b> زر في عمود المبلغ. التوصية (أ)."),
    ("OD-2", "النصوص الجديدة", "كل نص موسوم «جديد» في جدول النصوص يُعتمد كما رُسم أو يُعدَّل."),
    ("OD-3", "صف «إجمالي الخصم» في السلة والدفع", "قرار المالك OD-28-11 خصّ الإيصال. المرسوم: يظهر الصف نفسه في عمود المبلغ بالسلة وفي ملخص الطلب بالدفع، و«الإجمالي الحالي» هو الصافي. التوصية: نعم، ليطابق ما يراه الكاشير الإيصال."),
    ("OD-4", "تغيير كمية صنف مخصوم", "<b>(أ)</b> QtyRefused: الأزرار تعمل ويظهر الرفض بعد الضغط. <b>(ب)</b> QtyDisabled: الأزرار معطّلة على الصف المخصوم مع «أزل الخصم لتغيير الكمية.»، ويبقى نص الرفض احتياطًا. التوصية (ب). اسم الرمز يحدده RT-854."),
    ("OD-5", "خصم ثانٍ", "المرسوم: «خصم» يُعطَّل حين يكون للصنف المحدد خصم (Discounted)، ونص الرفض في SecondRefused احتياط إن رفض main. اسم الرمز يحدده RT-854."),
    ("OD-6", "مبلغ أكبر من الإجمالي", "يُمنع في النافذة قبل أي نداء (خطأ تحت الحقل والزر معطّل). إن وصل إلى main يعود <code>invalid_payload</code> بالنص نفسه."),
    ("OD-7", "صياغة <code>approval_invalid</code> و<code>approval_stale</code>", "شاشتا الإلغاء والاسترداد تصوغانهما بشكل مختلف؛ المقترح هنا خاص بالخصم. في القديمة يعود الكاشير إلى نافذة الخصم ليراجع ثم يطلب الموافقة."),
    ("OD-8", "اسم إجراء الإتمام بإجمالي صفر", "<b>المرسوم:</b> «إتمام البيع» (جديد). <b>البديل:</b> «تأكيد الدفع» الموجود. التوصية «إتمام البيع» لأنه لا دفع."),
    ("OD-9", "الإيصال", "سطر «خصم 10%  −9.00» تحت كل صنف مخصوم (بلا عملة)، و«إجمالي الخصم» فوق سطر الإجمالي الموجود في المحرّك (<code>Subtotal:</code>) الذي يحمل الصافي. بإجمالي صفر لا يُطبع قسم «طريقة الدفع». العرض الضريبي مفتوح مع 008-v2."),
]

DRAWN = """
      <li><b>الحساب من القاعدة لا باليد:</b> كل مبلغ يحسبه <code>tools/gen_d1.py</code> بقاعدة §3.2: <code>floor((gross × P + 50) / 100)</code> مرة واحدة على إجمالي السطر. مثال §5: 2 × 45.00 بنسبة 10% = −9.00. ومثال التقريب: 29.50 بنسبة 15% = 4.425 تُقرَّب إلى 4.43.</li>
      <li><b>المعاينة للعرض فقط:</b> النافذة تُظهر إجمالي الصنف والخصم والصافي، ويحسب main المبلغ النهائي (§4.1). لا يرسل العرض مبلغًا.</li>
      <li><b>السبب مطلوب في المسارين:</b> الزر معطّل حتى يُختار سبب (SheetNoReason). الأسباب الأربعة بنصها، والشرطة المائلة جزء من النص.</li>
      <li><b>مسار الكاشير:</b> «طلب موافقة المدير» يفتح نافذة RT-114 كما تُرسم في G2-CloseApproval: اسم المدير ورقمه السري، مع ملخص ما يُعتمد (الصنف والخصم والسبب). الرقم يُمسح بعد كل ضغط.</li>
      <li><b>مسار المدير أو المسؤول:</b> «تطبيق الخصم» مباشرة بلا نافذة موافقة (§4.2)، والتنقل بإدخالاته السبعة.</li>
      <li><b>السلة:</b> سطر الخصم تحت الصنف مزاحًا للداخل، بالنوع والسبب و«بموافقة: …»، والمبلغ في عمود الإجمالي، و«إزالة الخصم» في عمود الإجراءات (أي دور، D4). يبقى إجمالي الصنف كما هو.</li>
      <li><b>إجمالي صفر (OZ-1 = Z-A):</b> الدفع بلا بطاقات طرق الدفع، ومبلغ مستحق 0.00، وإجراء إتمام واحد؛ ثم الإتمام بلا «تم استلام المبلغ» ولا «الباقي».</li>
      <li><b>الإيصال معاينة على الشاشة فقط</b> داخل نافذة G6P، لا الورقة المطبوعة.</li>
      <li><b>لم يُرسم:</b> الضريبة (OD-28-10)، والحد الأقصى لكل مستأجر، والخصم على البيع كله (OD-28-5)، وربط المفاتيح.</li>
      <li><b>يحتاج تحققًا في RT-854 وRT-855 وRT-856</b> (الوثيقة 28 §11.3): الوصول إلى الدفع بلا سطر دفع، وتقفيل الوردية، وفتح الدرج، والإيصال بلا سطر دفع. الإطارات ترسم النتيجة المقصودة لا سلوكًا مُشاهَدًا.</li>
"""

FORCED_NOTES = """
      <li>كل حد (البطاقة، الزر، الحقل، المعاينة، ملخص الموافقة) يصبح بلون النص؛ والصف المحدد بإطار <code>Highlight</code>.</li>
      <li>سطر الخصم مميّز بخط جانبي ونص «خصم»، لا باللون وحده. الأزرار المعطّلة <code>GrayText</code>.</li>
"""

FORCED_STATES = ("SheetPercent", "Approval", "Discounted", "ZeroCheckout")

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
    <h1>الخصم اليدوي على الصنف (RT-699 D1): مراجع الشاشات</h1>
    <p><span class="status">مسودة — بانتظار اعتماد المالك (OD-1…OD-9)</span> · Jira <span class="ltr">RT-853</span> · من <span class="ltr">RT-699</span> · تخدم <span class="ltr">RT-855</span></p>
    <p><b>المرجع:</b> <a href="../../28-rt699-manual-discount-contract.md">الوثيقة 28</a> (§2، §4، §5، §7، §11) على <code>main@146673ba</code>، وقرارات المالك في RT-699 (التعليقان 12975 و13690، ومنها OZ-1 = Z-A). الشكل: سلة Direction B كما شُحنت، ونافذة الموافقة RT-114، وورقة G-6 مستوردة كما هي.</p>
    <p>مراجع تصميم فقط، بلا كود تشغيل. الأسماء والأسعار عيّنات.</p>
  </header>
"""

CHECKS = """
    <p>أُنتجت الصور وفُحصت بـ<code>tools/capture_d1.cjs</code> (فحوص G-3 وG-6 وPK-3 المشتركة): الاحتواء داخل الإطار، لا تدفق أفقي، لا نص أصغر من 12 بكسل،
      لا هدف أصغر من 44×44، لا عنصر قابل للتركيز خلف النافذة، وaxe-core بلا مخالفات على الإطار — 34 ملفًا بلا فشل. الملفات من
      <code>tools/gen_d1.py</code> وهذه الصفحة من <code>tools/gen_d1_spec.py</code>.</p>
"""


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
        return (
            f'<figure><a href="D1-{key}-{width}.html"><img src="captures/D1-{key}-{width}-light.png" alt=""></a>'
            f"<figcaption>{i + 1} · D1-{key} · {title}</figcaption></figure>"
        )

    return "".join(one(i, k, t) for i, (k, t) in enumerate(states))


def forced_figures(states: list[tuple[str, str]]) -> str:
    return "".join(
        f'<figure><img src="captures/D1-{k}-1280-forced.png" alt=""><figcaption>{t} · تباين عالٍ</figcaption></figure>'
        for k, t in states
        if k in FORCED_STATES
    )


def build(g) -> str:
    states = [(k, t) for k, t, _ in g.STATES]
    states_body = (
        f'<div class="grid">{figures(states)}</div>'
        "<p>الصور تتناوب بين 1280 و1024 للاختصار. لكل حالة ملفان <code>D1-&lt;State&gt;-1024.html</code> و<code>-1280.html</code> "
        "والصور في <code>captures/</code> (فاتح وتباين عالٍ لكل عرض).</p>"
        f'<div class="grid">{forced_figures(states)}</div>'
    )
    sections = [
        section(f"الحالات ({len(states)} حالة × 1024×768 و1280×800)", states_body),
        section("ما رُسم وما التزم به", f"<ul>{DRAWN}</ul>"),
        section("خريطة الرفض (الوثيقة 28 §7)", table(["الحالة في العقد", "الإطار"], [row(a, b) for a, b in REFUSALS])),
        section("النصوص — كل نص «جديد» يحتاج اعتماد المالك", table(["المكان", "النص", "الأساس", "الحالة"], [row(*c) for c in copy_table(g)])),
        section("قرارات مطلوبة من المالك", table(["#", "النقطة", "المقترح"], [row(a, b, c) for a, b, c in DECISIONS])),
        section("التباين العالي", f"<ul>{FORCED_NOTES}</ul>"),
        section("الفحوص المنفّذة على الملفات", CHECKS),
    ]
    return (
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>DRAFT · RT-853 D1 · الخصم اليدوي على الصنف</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>\n{HEADER}\n{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def main() -> None:
    tools = Path(__file__).resolve().parent
    out = tools.parent / "D1-Spec.html"
    out.write_text(build(load_gen(tools)), encoding="utf-8", newline="\n")
    print(f"[OK] wrote {out}")


if __name__ == "__main__":
    main()
