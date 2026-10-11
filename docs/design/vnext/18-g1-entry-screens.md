# 18 — G-1 entry-screen references: design brief (PROPOSED)

> **Status: PROPOSED.** The owner approved this brief on 2026-10-11, including the §6 decisions
> as recommended. The references are built in
> [`visual-acceptance/G1-Entry-screens/`](visual-acceptance/G1-Entry-screens/G1-Spec.html) and are
> waiting for owner visual approval. Until that approval they stay PROPOSED, not FROZEN.
> Jira **RT-246** (Work Mode: Planning). It blocks **RT-244** (W1-D). It closes gap **G-1** in
> [15 §6](15-vnext-freeze-package.md).
>
> **Precedence.** UX/UI Constitution, then [`DESIGN.md`](../../DESIGN.md), then the Visual
> Acceptance Pack. The pack is a reference for states and layout only (RT-246 comment 11147).
> RT-24 and the merged code are the behaviour authority: a reference never shows behaviour
> that `main` does not have.

## 1. Job and audience

- **Who.** A cashier or manager at the very start of a shift: standing, a customer may already be
  waiting, and this is the first screen of the day. The admin pairs the terminal once.
- **Mode.** Operate. The visitor succeeds when they are signed in, with the fewest decisions.
- **Why now.** The packaged re-audit (14, F-14) found sign-in broken on the first screen of the
  shift: three cards scattered, the PIN pad below the fold at 1024, bilingual and English labels,
  and «No cashiers available» in English. Ready and pairing are English-only (A18).

## 2. Outcome and proof

- **Primary act.** Cashier: pick your name, then type your PIN. Manager: sign in with identifier
  and password.
- **Proof.** At both widths, the PIN pad is fully in view the moment a cashier is selected, even
  with a long roster. No screen claims a path that does not work.

## 3. Direction: one stage, two zones (structural thesis)

The sign-in screen is a single centred stage with two zones, using the Direction B reading order.

- **Inline start (right): "who are you".** The roster, the widest zone. It scrolls inside its own
  region. Each cashier is a 60px tile (52px at 1024) with an initials badge and the name; long
  Arabic names wrap to two lines.
- **Inline end (left): "prove it".** A fixed column of 320px (296px at 1024). It is in the same
  place as the money column, which keeps the commit position consistent across the product.
  - Before selection: a quiet prompt, «اختر اسمك من القائمة لإدخال الرقم السري.». The keypad
    stays visible but disabled, so selecting a name never reflows the layout.
  - After selection: the name, the masked PIN dots and the LTR keypad (1-2-3 on top), with the
    commit at the bottom.
  - This column never moves and never scrolls.
- **Manager entry is demoted.** It is no longer a third permanent column. A secondary button,
  «دخول المدير», sits under the roster and swaps the inline-end column to the identifier and
  password form. «رجوع» swaps it back. This removes the scattered-cards failure (F-14) and keeps
  one primary per region.
- **Context strip.** The top of the stage carries the «POS Pulse» wordmark (OD-5), the branch
  name and the terminal label. There is no connection pill (A4 / X-2: no real signal).
- **Ready and pairing** use the same stage as a single centred card of about 440px, with the
  wordmark, one sentence and one commit.

**Rejected:** keeping three columns (this is the F-14 failure), and a full-screen two-step wizard
(it hides who is selected while the PIN is typed).

## 4. The eight references (×1024 / ×1280, light + forced-colors)

| # | State | What it must show | Copy source |
|---|---|---|---|
| 1 | Roster (typical) | 6 cashiers; the PIN column waiting | proposed: «اختر اسمك من القائمة لإدخال الرقم السري.» |
| 1b | Roster, long (both widths) | 18 cashiers, some long names; the roster scrolls inside its region; the PIN pad stays in view | — |
| 2 | Manager sign-in | the form in the inline-end column; identifier input `dir="ltr"`; password | shipped labels: «البريد الإلكتروني أو اسم المستخدم», «كلمة المرور», «تسجيل الدخول» |
| 3 | Cashier PIN entry | the selected tile is highlighted (Teal Wash + inline-start bar); name; 4 of 6 dots filled; LTR keypad; commit «دخول» | name is data |
| 4 | Wrong PIN | the inline error above the dots; dots cleared; the keypad still usable | shipped `invalid_input`: «بيانات الدخول غير صحيحة. حاول مرة أخرى.». **Not** a factor-specific «الرقم السري غير صحيح» (P11 / PR-2) |
| 4b | Lockout (own file) | the same slot, `rate_limited` | shipped: «محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.» |
| 5 | Roster unreachable | a warning notice in the roster zone; no tiles; manager entry still offered, but **not** as an offline path; the PIN column says «لا يمكن إدخال الرقم السري قبل تحميل القائمة.» | proposed, see §6 |
| 6 | Ready after restart | card: wordmark, terminal label, one sentence, «متابعة» | M-F1: «الجهاز مرتبط وجاهز.» · «متابعة» |
| 7 | Pairing | card: a single free-text code field (mono, LTR); commit; status slot | proposed, see §6. The code length is server-defined (`pairing-http.md`), so it is **not** a segmented field |
| 8 | Manager re-sign-in prompt | the shipped `ReauthDialog` (#630) over the screen it interrupts; M-A3 notice | shipped `REAUTH_COPY` + M-A3. This is a capture of the shipped component; any delta is flagged, not redesigned |

## 5. Constraints a builder must not break

- Role nouns «الكاشير» / «المدير» (UX-12). These replace the code's «صيدلي» / «صيادلة هذا الفرع».
- Arabic only: no «Staff code · كود الموظف», no English empty state.
- Dubai stack and the DESIGN.md mono stack only. The references do **not** copy the I3 pack's
  Google Fonts (IBM Plex Mono / Noto Sans Arabic).
- PIN dots, the keypad, codes and terminal ids are LTR-isolated Western digits. Mono is used only
  for codes and ids (UX-03). Text is never below 12px.
- Visible 2px focus at every step. Labels, help text and errors are linked programmatically (UX-11).
- Keypad keys are 56×56 (60×64 comfortable), with an 8px gap. The commit is 56/60px, full column
  width.
- One filled-teal primary per region.
- Not in scope: takeover, lock and first-PIN set. These are not part of G-1.

## 6. Decisions for the owner (recommended answer first)

1. **Layout.** The two-zone stage, with manager entry swapping the inline-end column (§3).
2. **Role nouns.** «الكاشير» / «المدير» everywhere on these screens.
3. **Roster unreachable, sign-in copy (proposed).** «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.»
   There is **no** «أعد المحاولة» button: today the roster is fetched only on mount, so a retry
   button would be new behaviour that belongs to RT-244 scope if wanted. The manager button stays,
   with no hint that it works offline: on `main`, both paths need the backend (MD-1).
4. **Pairing copy (proposed Arabic for all outcomes).**
   - Title «ربط الجهاز»; hint «أدخل رمز الربط الظاهر في لوحة الإدارة.»; field «رمز الربط»;
     commit «ربط الجهاز» / «جارٍ الربط…».
   - Invalid «الرمز غير صحيح. تحقق منه وحاول مرة أخرى.»; expired «انتهت صلاحية الرمز. أنشئ رمزًا
     جديدًا.»; used «هذا الرمز مُستخدم من قبل.»; other branch «الجهاز مسجّل لفرع آخر. اطلب من
     المشرف فكّه.»; too many «محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.»; no connection
     «لا يوجد اتصال. تحقق من الشبكة وحاول مرة أخرى.»; other «تعذّر الربط. حاول مرة أخرى.»
5. **PIN waiting prompt (proposed).** «اختر اسمك من القائمة لإدخال الرقم السري.»
6. **Smaller copy changes (proposed).** The screen title is «تسجيل الدخول» (it was «تسجيل دخول
   الصيدلي»). The roster heading is «الكاشير في هذا الفرع». The PIN commit is «دخول». The full
   copy table is in `G1-Spec.html`.

## 7. Delivery

- Folder `visual-acceptance/G1-Entry-screens/`: `G1-<State>-1024.html` / `-1280.html`, plus one
  `G1-Spec.html` carrying the classification, the deltas and the copy table.
- Captures: Playwright Chromium, light and `forcedColors: 'active'`, for every reference at both
  widths (the in-app browser cannot emulate forced colours).
- Every file is classified **PROPOSED** until the owner approves the visuals. After approval, it
  becomes visual FROZEN / behaviour APPROVED, and 15 §6 (G-1) and `visual-acceptance/index.html`
  are updated.
