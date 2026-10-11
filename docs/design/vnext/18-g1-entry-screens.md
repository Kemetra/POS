# 18 — G-1 entry-screen references: design brief (APPROVED)

> **Status: APPROVED.** The references are visual FROZEN / behaviour APPROVED.
>
> - **Brief:** on 2026-10-11 the owner approved this brief and §6 items 1–5 as recommended.
> - **References and copy:** later the same day, the owner approved the references and every
>   proposed string, including §6 items 6–8 («موافق على الشكل والنصوص»).
> - **Where:** [`visual-acceptance/G1-Entry-screens/`](visual-acceptance/G1-Entry-screens/G1-Spec.html).
> - **Jira:** **RT-246** (Work Mode: Planning). It blocks **RT-244** (W1-D) and closes gap **G-1** in
>   [15 §6](15-vnext-freeze-package.md).
>
> **Precedence.** The UX/UI Constitution comes first, then [`DESIGN.md`](../../DESIGN.md), then the
> Visual Acceptance Pack. The pack is a reference for states and layout only (RT-246 comment 11147).
> RT-24 and the merged code are the behaviour authority, so a reference never shows behaviour that
> `main` does not have.

## 1. Job and audience

- **Who.** A cashier or manager at the very start of a shift: standing, a customer may already be
  waiting, and this is the first screen of the day. The admin pairs the terminal once.
- **Mode.** Operate. The visitor succeeds when they are signed in, with the fewest decisions.
- **Why now.** The packaged re-audit (14, F-14) found sign-in broken on the first screen of the
  shift:
  - three cards scattered;
  - the PIN pad below the fold at 1024;
  - bilingual and English labels;
  - «No cashiers available» in English.

  Ready and pairing are English-only (A18).

## 2. Outcome and proof

- **Primary act.** Cashier: pick your name, then type your PIN. Manager: sign in with identifier
  and password.
- **Proof.**
  - At both widths, the PIN pad is fully in view the moment a cashier is selected, even with a long
    roster.
  - The keypad sits at the same place in every sign-in state.
  - No screen claims a path that does not work.

## 3. Direction: one stage, two zones (structural thesis)

The sign-in screen is a single centred stage with two zones, using the Direction B reading order.

- **Inline start (right): "who are you".** The roster, the widest zone.
  - It is a two-column grid that scrolls inside its own region.
  - Each cashier is a 60px tile (52px at 1024) with a one-letter badge (the first letter of the
    name) and the name.
  - Long Arabic names wrap to two lines, then clamp. The full name stays in the accessible name.
- **Inline end (left): "prove it".** A fixed column of 340px (304px at 1024). It sits where the
  money column sits, which keeps the commit position consistent across the product.
  - **Before selection:** a quiet prompt, «اختر اسمك من القائمة لإدخال الرقم السري.». The keypad
    stays visible but disabled, so selecting a name never reflows the layout.
  - **After selection:** the name, then the masked PIN dots, then a reserved feedback slot, then the
    LTR keypad (1-2-3 on top). The commit «دخول» is at the bottom.
  - The column never moves and never scrolls. Its header height and the feedback slot (sized for
    the longest refusal at 304px) are fixed.
- **Manager entry is demoted.** It is no longer a third permanent column.
  - A secondary button, «دخول المدير», sits under the roster. It swaps the inline-end column to the
    identifier and password form, and «رجوع» swaps it back.
  - This removes the scattered-cards failure (F-14) and keeps one primary per region.
- **Context strip.** It carries the «POS Pulse» wordmark (OD-5) and the terminal label. The label
  is admin free text, so it is shown in `<bdi>` in the body font.
  - **No branch name.** The renderer has only `branch_id` on `main`. Showing a name needs a new
    bridge field (§A4) and a fallback for a null `branch_name`, which is an RT-244 decision.
  - **No connection pill.** There is no real signal for one (A4 / X-2).
- **Ready and pairing** use the same stage as a single centred card of about 440px, with the
  wordmark, one sentence and one commit.
- **Spacing.** Entry screens are outside the sale workspace, so their gutters are wider than the
  DESIGN.md density profiles (24/16/20 at 1280 and 16/12/16 at 1024). Target sizes and type do not
  change.

**Rejected:**

- keeping three columns, which is the F-14 failure;
- a full-screen two-step wizard, which hides who is selected while the PIN is typed.

## 4. The references: 11 states (×1024 / ×1280, light + forced-colors)

| # | State | What it must show | Copy source |
|---|---|---|---|
| 1 | Roster (typical) | 6 cashiers; the PIN column waiting | proposed: «اختر اسمك من القائمة لإدخال الرقم السري.» |
| 1b | Roster, long (both widths) | 18 cashiers. Two long names wrap to two lines. The roster scrolls inside its region, and the PIN pad stays in view. | — |
| 2 | Manager sign-in | the form in the inline-end column; identifier input `dir="ltr"`; password | shipped labels: «البريد الإلكتروني أو اسم المستخدم», «كلمة المرور», «تسجيل الدخول» |
| 3 | Cashier PIN entry | the selected tile is highlighted (Teal Wash + inline-start bar); name; 4 of 6 dots filled; LTR keypad; commit «دخول» | name is data |
| 4 | Wrong PIN | the inline error in the reserved slot between the dots and the keypad; dots cleared; the keypad still usable | shipped `invalid_input`: «بيانات الدخول غير صحيحة. حاول مرة أخرى.». **Not** a factor-specific «الرقم السري غير صحيح» (P11 / PR-2) |
| 4b | Lockout | the same slot, `rate_limited` | shipped: «محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.» |
| 5 | Roster unreachable (`no_connection`) | a warning notice in the roster zone; no tiles. Manager entry is still offered, but **not** as an offline path. The PIN column says «لا يمكن إدخال الرقم السري قبل تحميل القائمة.». Any other roster refusal shows «تعذّر تحميل قائمة الكاشير.» in the same slot. | proposed, see §6 |
| 5b | Roster empty | the roster loaded with zero cashiers. This is a neutral notice, not a warning, and it does not mention the connection. | proposed, see §6 |
| 6 | Ready after restart | card: wordmark, terminal label, one sentence, «متابعة» | M-F1: «الجهاز مرتبط وجاهز.» · «متابعة» |
| 7 | Pairing | card: a single free-text code field (mono, LTR), the commit and a status slot | proposed, see §6. The code length is server-defined (`pairing-http.md`), so it is **not** a segmented field |
| 8 | Manager re-sign-in prompt | an HTML replica of the shipped `ReauthDialog` (#630), over the shipped M-A3 `ReauthRequiredNotice` on the screen it interrupts | shipped `REAUTH_COPY` + M-A3. Any delta is flagged, not redesigned |

## 5. Constraints a builder must not break

- **Role nouns.** «الكاشير» / «المدير» (UX-12). These replace the code's «صيدلي» / «صيادلة هذا
  الفرع».
- **Arabic only.** There is no «Staff code · كود الموظف», no English empty state and no English
  per-tile «Cashier» label.
- **Fonts.** The Dubai stack and the DESIGN.md mono stack only. The references do **not** copy the
  I3 pack's Google Fonts (IBM Plex Mono / Noto Sans Arabic).
- **Digits and type.**
  - PIN dots, the keypad and codes use LTR-isolated Western digits.
  - Mono is for codes, ids and keypad digits (as on the shipped cash keypad). It is not used for the
    terminal label.
  - Text is never below 12px.
- **Focus and labels (UX-11).** A visible 2px focus at every step. Labels, help text and errors are
  linked programmatically.
- **Sizes.** Keypad keys are 56×56 (60×64 comfortable), with an 8px gap. The commit is 56/60px and
  spans the full column width.
- **Teal.** One filled-teal primary per region. The badge in the PIN-column header uses Teal Wash,
  not a teal fill.
- **Forced colours.**
  - Selected and current states use `Highlight` with `forced-color-adjust: none`. This follows the
    shipped precedent in `v5/checkout/checkout.css` and `v5/frame/frame.css`.
  - DESIGN.md's "product images only" wording predates that precedent and needs an update.
  - PIN dots and the wordmark do not un-force.
- **Out of scope.** Takeover, lock and first-PIN set are not part of G-1. `PinPad` is rendered only
  by sign-in; the lock screen imports only its length limits.

## 6. Owner decisions (all approved as written, 2026-10-11)

1. **Layout.** The two-zone stage, with manager entry swapping the inline-end column (§3).
2. **Role nouns.** «الكاشير» / «المدير» everywhere on these screens.
3. **Roster unreachable, sign-in copy (proposed).** «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.»
   - There is **no** «أعد المحاولة» button. Today the roster is fetched only on mount, so a retry
     button would be new behaviour; if wanted, it belongs to RT-244 scope.
   - The manager button stays, with no hint that it works offline. On `main`, both paths need the
     backend (MD-1).
4. **Pairing copy (proposed Arabic).**
   - Title «ربط الجهاز»; hint «أدخل رمز الربط الظاهر في لوحة الإدارة.»; field «رمز الربط»; commit
     «ربط الجهاز» / «جارٍ الربط…».
   - Invalid «الرمز غير صحيح. تحقق منه وحاول مرة أخرى.»
   - Expired «انتهت صلاحية الرمز. أنشئ رمزًا جديدًا.»
   - Used «هذا الرمز مُستخدم من قبل.»
   - Other branch «الجهاز مسجّل لفرع آخر. اطلب من المشرف فكّه.»
   - Too many attempts «محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.»
   - No connection «لا يوجد اتصال. تحقق من الشبكة وحاول مرة أخرى.»
   - Other «تعذّر الربط. حاول مرة أخرى.»
5. **PIN waiting prompt (proposed).** «اختر اسمك من القائمة لإدخال الرقم السري.»
6. **Smaller copy changes (proposed).**
   - The screen title is «تسجيل الدخول» (it was «تسجيل دخول الصيدلي»).
   - The roster heading is «الكاشير في هذا الفرع».
   - The PIN commit is «دخول».
   - The manager panel's back control is «رجوع» (it was «← العودة إلى قائمة الكاشير»).
7. **Roster refusals and empty roster (proposed).**
   - `no_connection` uses item 3's string, which replaces «تعذّر الوصول إلى الخادم. حاول مرة أخرى.».
   - Any other refusal shows «تعذّر تحميل قائمة الكاشير.».
   - A roster that loaded empty shows «لا يوجد كاشير مسجّل في هذا الفرع.», with «الدخول بالرقم السري
     يحتاج كاشيرًا مسجّلًا في هذا الفرع.» in the PIN column.
8. **The remaining pairing outcomes (proposed).**
   - Session active «أنهِ البيع الحالي وسجّل الخروج قبل ربط الجهاز مرة أخرى.»
   - Already paired «هذا الجهاز مربوط بالفعل.»
   - Empty input «أدخل رمز الربط.»

The full copy table, with the shipped string each one replaces, is in `G1-Spec.html`.

## 7. Delivery

- **Files.** The folder `visual-acceptance/G1-Entry-screens/` holds `G1-<State>-1024.html` /
  `-1280.html` (22 files) and `G1-Spec.html`, which carries the classification, the deltas and the
  copy table.
- **Tools.** `tools/gen_g1.py` writes the HTML. `tools/capture_g1.cjs` takes the captures and checks
  fit, the 12px floor, the 44px floor, axe, name wrapping and that the keypad stays in place.
- **Captures.** Playwright Chromium, light and `forcedColors: 'active'`, for every reference at both
  widths. The in-app browser cannot emulate forced colours. These captures emulate the Chromium
  palette; they are not the real Windows contrast theme.
- **Classification.** All files are visual FROZEN / behaviour APPROVED (owner, 2026-10-11).
  15 §6 (G-1) and `visual-acceptance/index.html` list them.
