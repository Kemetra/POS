# 19 — D-M1: cashier PIN-status read and the Manager → Cashiers surface (APPROVED)

> **Status: APPROVED.** The references are visual FROZEN / behaviour PENDING the implementation slice.
>
> - **Brief:** on 2026-10-12 the owner approved this brief and decisions D1, D3 and D4 as
>   recommended («موافق على الاقتراحات التلاتة، ابدأ ارسم»). D2 was withdrawn (§2 rule 9).
> - **References and copy:** later the same day the owner approved the G-3 references and every
>   string marked "proposed" in §5 (D5): «موافق على الشكل والنصوص». They are in
>   [`visual-acceptance/G3-Cashiers/`](visual-acceptance/G3-Cashiers/G3-Spec.html).
>
> - **Jira:** **RT-251** (Work Mode: **Planning**; no implementation here). It closes decision
>   **D-M1** and gap **G-3** in [15](15-vnext-freeze-package.md) §6–§7.
> - **Baseline:** POS `origin/main@7593c79f`.
> - **Precedence:** the same as [18](18-g1-entry-screens.md). RT-24 and the merged code are the
>   behaviour authority, and a reference never shows behaviour that `main` does not have.

## 1. What happens today

The Manager → Cashiers screen (RT-235, `routes/app/manager/CashierManagement.tsx`) is at
`/app/manager/cashiers`. Only manager and admin can open it.

**What the screen shows**
- It lists the device roster (`operator.listBranchRoster()`), but has **no PIN data**.
- Every row shows the same three English buttons, whatever the cashier's state: «Set first PIN»,
  «Reset PIN» and «Unlock» (N-11).
- There is one unconfirmed PIN field, and every string is English.

**What the actions do on a wrong state**
| Action | Wrong state | Result |
|---|---|---|
| Set first PIN | A PIN already exists | Refused with `state_invalid` |
| Reset PIN | No PIN on this terminal | Refused with `invalid_input`; the screen shows a generic English error |
| Unlock | Not locked | Answers `state_invalid`, which the screen treats as success. It emits `cashier.pin.unlock` even when there is no row |

**Main-side facts the read must respect** (`src/main/operator/`)
- **PIN records:** `cashier_pin_records`, keyed by (tenant, branch, terminal, `user_id`).
  `cashier_clerk_user_id` holds the roster `id`. A partial unique index covers it.
- **Lockout:** 5 failures set `lockout_until = now + 5 min`. **Locked means
  `lockout_until > now`**, and it **ends on its own**. A failure count of 1–4 with no lockout
  still signs in.
- **Row lookup:** sign-in, reset and unlock find the row by
  `cashier_clerk_user_id = <roster id>`. Provision writes that column from the roster `id`, and
  its duplicate check also matches `user_id`. Rows exist only for **this** terminal; re-pairing
  purges every other terminal's rows.
- **Roster:** the device roster (Backend-Core `cashier-admissions/roster`) is online only. It
  carries `operator_id`, `user_id` and `display_name`, and `user_id` never crosses the bridge.
  Provision fetches a second roster with the manager's JWT; that is the only place re-auth (M6)
  can arise.

## 2. The read contract (proposed)

A **new manager-only bridge method**. It does **not** extend `listBranchRoster`: that method has
no role gate because the sign-in screen uses it, so adding status to it would tell anyone at the
sign-in screen who is locked out.

```ts
// src/shared/bridge-api.ts (OperatorBridgeAPI)
listCashierPinStatus(): Promise<ListCashierPinStatusResponse>;

type CashierPinState = 'no_pin' | 'ready' | 'locked';

interface CashierPinStatus {
  id: string;            // the roster id (operator_id), as listBranchRoster gives today
  display_name: string;
  pin: CashierPinState;
  locked_until?: string; // ISO 8601, only when pin === 'locked' (see §7 D3)
}

type ListCashierPinStatusResponse =
  | { kind: 'cashiers'; cashiers: CashierPinStatus[] }
  | { kind: 'refused'; category: 'not_signed_in' | 'role_mismatch' | 'no_connection' | 'invalid_input' };
```

**Main-side rules**

1. `requireRole(['manager','admin'])` is the **first** call (AD-1). A cashier gets
   `role_mismatch`.
2. **Scope** comes from `pairingStore.getStatus()`, never from the renderer. If the terminal is
   not paired, the answer is `invalid_input`.
3. **Roster source:** the **device roster**, the one this screen lists today.
   - It needs no manager JWT, so the list keeps loading after the manager's JWT expires.
   - Re-auth (M6) stays on provision, the only action that presents the JWT.
   - An unreachable backend gives `no_connection`, the same as today.
4. **The state of each roster entry**, evaluated in this order:
   | State | Condition |
   |---|---|
   | `locked` | A row matches `cashier_clerk_user_id = id` in scope, and `lockout_until > now` |
   | `ready` | That row exists, and it is not locked |
   | `no_pin` | No such row |
5. **The match is the sign-in match** (`cashier_clerk_user_id = id`), because that row decides
   whether the PIN works.
   - Provision's wider duplicate check (`user_id OR cashier_clerk_user_id`) differs only for a
     row keyed by `user_id` alone. The 019 provision writer cannot create such a row (017
     OQ-D6-1).
   - The implementation adds a test that pins this. If such a row ever appears, the slice stops
     and asks; it does not invent a state.
6. **What never crosses the bridge:** `pin_hash`, `pin_salt`, `failed_attempt_count`, `user_id`,
   tenant, branch and terminal ids. The response uses fixed enums, and its only text is
   `display_name`.
7. **Read-only.** It writes nothing and emits no audit event, the same as `listBranchRoster`. It
   is **not** on `LOCKED_ALLOWED_CHANNELS`, so a locked session cannot read it.
8. **No Backend-Core change.** The device roster already carries both ids.
9. **No "not activated" state.** The device roster rejects the **whole** list if any entry lacks
   a non-empty `user_id` (`cashier-admission-client.ts` `parseRosterEntry` / `interpretRoster`),
   so every listed cashier has one.
   - Provision's `not_ready` can then only come from the *manager-JWT* roster disagreeing with
     the device roster.
   - That stays an inline refusal in the dialog (M-K10), not a badge.

**What «جاهز» does and does not mean.** «جاهز» means *a PIN is set on this terminal and it is not
locked out*. It does **not** promise that sign-in will succeed. Online admission, unsealing the
stored hash (safeStorage) and the pairing epoch can still refuse. The copy says no more than
that.

**Loading and re-reading.**
- On the first load, the panel shows the muted line «جارٍ تحميل القائمة…» and no rows.
- On a re-read, the rows that are already shown stay. Every row action stays disabled under the
  shared pending guard until the answer arrives, and then the rows are replaced in one step.
- If the session locks or signs out while the read is in flight, main re-checks the session after
  the roster await, as provision does (RT-358), and answers `not_signed_in`. A lock never shows
  stale rows to the next person.

**Freshness: no polling.** A lock ends on its own after 5 minutes, so a «مقفل» badge can go stale
while the screen is open. The screen re-reads:
- after every action, success or refusal;
- on «إعادة المحاولة»;
- when the screen mounts.

An unlock that finds the lock already expired keeps today's behaviour: it counts as unlocked,
and then the list re-reads.

**Owed by the implementation slice** (not here): a §A4 bridge-security re-check for the new
channel, and the preload key-list and contract tests.

## 3. State → action matrix (M1–M6)

| # | State | Row shows | Primary action | Other actions | Never shown |
|---|---|---|---|---|---|
| M1 | Roster unreachable / refused | the screen notice (M-K1), no rows | «إعادة المحاولة» | — | every row action |
| M2 | `no_pin` | badge «بدون رقم سري» | «تعيين أول رقم سري» | — | change PIN, unlock |
| M3 | `ready` | badge «جاهز» | — | «تغيير الرقم السري» (see §7 D1) | first PIN, unlock |
| M4 | `locked` | badge «مقفل» (+ «حتى ‹الوقت›», see §7 D3) | «فك القفل» | «تغيير الرقم السري» (see §7 D1) | first PIN |
| M5 | Setting a PIN (first or change) | a dialog with two fields | «حفظ» | «إلغاء» | — |
| M6 | Session expired (provision only, RT-247) | the shipped M-A3 notice | «تسجيل الدخول» | — | «حفظ» |

**Empty roster:** «لا يوجد كاشير مسجّل في هذا الفرع.», the same fact as on sign-in.

**Change PIN on a locked row** also clears the lock, because reset sets `lockout_until = NULL`.
The success copy is M-K2b, and the re-read then shows the row as «جاهز».

**One action at a time:** while a call is pending, every row action is disabled. This keeps
today's shared pending guard.

## 4. PIN entry (M5)

- **Two fields:** «الرقم السري الجديد» and «تأكيد الرقم السري».
  - Digits only and LTR (`inputmode="numeric"`, `type=password`), 4–6 digits (`PIN_RE` in
    `pin-management.ts`; the 6–8 rule is the manager-PIN rule, not this one).
  - The hint is «من 4 إلى 6 أرقام.».
- **Validation runs in the renderer before any call:**
  - wrong length: «الرقم السري من 4 إلى 6 أرقام.»;
  - the two fields differ: M-K3 «الرقمان غير متطابقين.».
  - In both cases the fields clear and focus goes back to the first field. Main still validates
    with `PIN_RE`; the renderer check only saves a round trip.
- **Dialog behaviour:**
  - The title names the cashier inside `<bdi>`.
  - «حفظ» stays disabled until both fields hold 4–6 digits.
  - Escape and «إلغاء» close the dialog only while nothing is pending (the RT-235 dialog guard).
- **Secrets:** the PIN is never logged, never echoed, and never placed in any text node. This is
  the existing PR-1 rule.

## 5. Copy (proposed unless marked approved)

| ID | Where | Arabic | Tone | Status |
|---|---|---|---|---|
| M-K0 | Screen title | «إدارة الكاشير» | — | the link label already ships |
| M-K0b | Under the title | «الرقم السري لكل كاشير على الجهاز ‹الجهاز›» (the terminal label in `<bdi>`, as the entry strip shows it today) | — | proposed |
| M-K0c | List heading | «الكاشير في هذا الفرع» · «‹n› كاشير» | — | proposed (the heading matches sign-in) |
| M-K0d | First load | «جارٍ تحميل القائمة…» | neutral | proposed |
| M-K1 | Roster unreachable (M1) | «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.» + button «إعادة المحاولة» | warning | **approved (D4, 2026-10-12)** |
| M-K1b | Roster refused, other cause | «تعذّر تحميل قائمة الكاشير.» + «إعادة المحاولة» | warning | proposed (matches sign-in) |
| M-K2 | First PIN set | «تم تعيين الرقم السري لـ ‹الاسم›.» | success | **in 15** |
| M-K2b | PIN changed | «تم تغيير الرقم السري لـ ‹الاسم›.» | success | proposed |
| M-K2c | Unlocked | «تم فك القفل عن ‹الاسم›.» | success | proposed |
| M-K3 | PIN mismatch | «الرقمان غير متطابقين.» | warning | **in 15** |
| M-K4 | Wrong length | «الرقم السري من 4 إلى 6 أرقام.» | warning | proposed |
| M-K5 | Badges | «بدون رقم سري» · «جاهز» · «مقفل» | neutral / success / warning | **in 15** |
| M-K6 | Lock time | «حتى ‹HH:MM›» (Western digits, `<bdi dir="ltr">`) | — | per §7 D3 |
| M-K7 | Actions | «تعيين أول رقم سري» · «تغيير الرقم السري» · «فك القفل» · «حفظ» · «إلغاء» | — | the first and third are **in 15**; «تغيير الرقم السري» per §7 D1 |
| M-K8 | Dialog | title «تعيين أول رقم سري لـ ‹الاسم›» / «تغيير الرقم السري لـ ‹الاسم›»; fields «الرقم السري الجديد» · «تأكيد الرقم السري»; hint «من 4 إلى 6 أرقام.» | — | proposed |
| M-K9 | Generic failure | «تعذّر تنفيذ العملية. حاول مرة أخرى.» | danger | proposed |
| M-K10 | Provision refused `not_ready` (inline in the dialog) | «لا يمكن تفعيل هذا الكاشير الآن. تواصل مع المشرف.» | warning | proposed |
| M-A3 | Session expired (M6) | «انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.» + «تسجيل الدخول» | warning | **approved (RT-247)** |

`‹الاسم›` is the roster `display_name`. It is admin free text, so it sits in `<bdi>`. No string
interpolates a PIN, an id or a refusal category.

## 6. The G-3 references (APPROVED 2026-10-12)

There are ten states, each at 1024×768 and 1280×800, in light and forced colours.
- They are in [`visual-acceptance/G3-Cashiers/`](visual-acceptance/G3-Cashiers/G3-Spec.html).
- They are drawn in the manager frame as it is on `main` today: the labelled nav panel, 208 px at
  1280 and 140 px at 1024. There is no current nav entry, because the screen opens from the
  Dashboard link.
- The references are fixed-size pages, so the 1024×600 floor (RT-313 / RT-407) is **not** drawn.
  The implementation slice checks it in the real frame: the list scrolls inside the panel and
  the dialog scrolls inside its scrim.

1. The list, mixed: `no_pin`, `ready` and `locked` rows.
2. A long list (18 rows), so the list scrolls and the header stays in view.
3. M5 first PIN, empty.
4. M5 with a mismatch (M-K3).
5. M5 change PIN (D1).
6. Success notice (M-K2) with the row now «جاهز».
7. Unlock done (M-K2c) with the row now «جاهز».
8. M1 roster unreachable.
9. Empty roster.
10. M6 session expired.

The tooling is the G-1 kit: one `gen_g3.py`, one `capture_g3.cjs`, a `G3-Spec.html` copy table,
and captures checked for fit, the 12 px and 44 px floors, axe and names that wrap.

## 7. Decisions for the owner

- **D1 — APPROVED 2026-10-12 as recommended. Keep «تغيير الرقم السري» for a ready or locked cashier?** Reset ships today, but the M3
  and M4 rows in 15 do not list it. Dropping it would take away a working action: a cashier who
  forgot their PIN. **Recommendation: keep it as a secondary action**, named «تغيير الرقم السري».
- **D2 — Withdrawn.** A fourth "not activated" badge cannot occur; see §2 rule 9. Provision's
  `not_ready` stays an inline refusal (M-K10).
- **D3 — APPROVED 2026-10-12 as recommended. The lock end time:** show «حتى ‹HH:MM›» beside «مقفل», or just «مقفل»? **Recommendation:
  show it.** It is an absolute time, and it tells the manager that waiting also works.
- **D4 — APPROVED 2026-10-12 as recommended. Roster-unreachable wording.** Three versions exist:
  - the M1 row: «… — تحقق من الاتصال»;
  - M-K1: «… تحقق من الاتصال ثم أعد المحاولة.»;
  - the shipped sign-in string: «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.».

  **Recommendation: the sign-in string, plus a «إعادة المحاولة» button.** There is one string per
  fact, and the button carries the retry. Sign-in has no retry; this screen does, because the
  manager is already signed in and a re-read is safe.
- **D5 — APPROVED 2026-10-12. The copy in §5** marked "proposed", approved with the references.

## 8. Delivery

This PR is docs-only:
- this brief;
- the G-3 references and their tools (`tools/gen_g3.py`, `tools/capture_g3.cjs`);
- pointers in [15](15-vnext-freeze-package.md), the README and the visual-acceptance index.

The owner approved the references and the copy (D5) on 2026-10-12.

Implementation is a separate Jira slice: the main read and IPC, the renderer screen, and tests,
with the §A4 re-check.
