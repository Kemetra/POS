# rt9 combined verification — 2026-10-23 (RT-754 / RT-446 / RT-781)

Build: POS main `e33fca25`, packaged win-unpacked (unsigned), `POS Pulse.exe` sha256 f31ce3d2…851f, `app.asar` 4a8ac6a5…2dc (pos-build-hashes.txt).
Launcher `D:\rt9combo-launch.sh`, profile `D:\rt9combo-userdata`, lab api `rt9-api:79537b34` on :13000, Descope operators.
Driver: `D:\rt9-lab\bench\pos.ps1` (SendInput + PrintWindow, no CDP) and `posq.ps1`/`q.sh` (same, one process per key sequence).
Lab DB baseline 10:36:35Z: sales 88, sale_tenders 11, audit_events 2390, park audit 0, platform_support_sessions 0, pairing_codes 31.
Pairing: owner minted 10:37Z and paired + signed in the Store Manager (rt9-operator) themself. Code minted by the agent at 10:42Z was never used (pending, expires 12:42Z).

## RT-754 (1280x800 then 1024x768, DPI 96, scale 100%)
- Sign-in: done by the owner (not witnessed, not keyboard-recorded).
- Dashboard → Sale: Tab order top link «حالة الوردية» → 4 cards → rail. Enter on «نقطة البيع» lands focus on the scan field.
- Scan add (simulated keyboard-wedge burst, not a real scanner): OK. Search add: type → Tab ×3 (parked, refresh, results) → Enter: OK, focus back to scan.
- Qty +: OK. Delete: OK, focus moves to the remaining row's «حذف».
- Undo: the chip lives 8 s (UNDO_NOTICE_MS), focus pauses it. From the deleted row it takes 7 Shift+Tabs to reach «تراجع»; reached in a fast burst, Enter restored the line, «تم التراجع.», focus to scan. With slower stepping the chip expired first (observation O-1).
- Handoff «تسليم السلة للدفع» → «المتابعة إلى الدفع» → Checkout: **focus lands on the «نقدي» tender tile** at 1280 and 1024 (R-dev F1 = BODY; RT-761 target met on packaged main).
- Cash: amount 10 → 16 Tabs (exact + 3 quick + 12 keypad keys) to «تأكيد الدفع النقدي» → Enter → «تأكيد الدفع» focused → Enter → completion (7.25, change 2.75, no receipt yet).
- **Completion: «بيع جديد» holds focus (Enter starts a new sale; Tab moves to the rail) but no focus indicator is drawn until the user Tabs back to it** (1280 and 1024). Finding F-A.
- Card at 1024: card tile → reference «A1B2» → «تأكيد معالجة جهاز البطاقات» → «تأكيد الدفع» → completion 473.25. The UNKNOWN path was not exercised.
- Focus-not-obscured: 1280 Sale (2 lines) + Checkout + cash entry + completion; 1024 Sale with 13 lines (scrolling cart, 60 Tab stops) + Checkout + card: every focused control fully visible, the cart scrolls the focused row into view, nothing under the action column, notices strip or header. 1024 Checkout collapses the order summary into «عرض الأصناف».
- Observation O-2: one of 14 simulated scans (700 ms spacing, right after a route change) produced no line (main logged 13 `cart.line.add`); a repeat of 3 scans at the same spacing added 3/3. Not reproduced.
- Operator error (mine): Shift+Tab onto the rail «لوحة المتابعة» + Enter left Checkout once; going back through «نقطة البيع» restored the handed-off cart.
- NOT yet: forced colors (--force-high-contrast), scale above 100% (--force-device-scale-factor=1.25), runbook AC.

## RT-446
- S1 park → next customer → resume: **FAIL**. After a completed sale, resume is refused `checkout_in_progress`. Boundary: `src/main/cart/park/park-store.ts:216-222` + `OPEN_PAYMENT` (74-80). The completed cart is `frozen_handed_off`, its attempt is `settled`, and its tender line stays `applied`, so it counts as an open payment. Reported to the parent.
- S2: parks 2..5 OK (count shown 5), 6th refused in the dialog «وصل هذا الجهاز إلى الحد الأقصى: 5 مبيعات معلّقة…» with «عرض المبيعات المعلقة». Swap while full: the review offers «علّق البيع الحالي واستأنف المحدد», but activating it is refused `checkout_in_progress` (same root cause as S1).
- S7: no shift is open; only the cashier role opens one → needs a cashier sign-in.
- Owner set cashier PINs (3 local records 11:09Z) and the manager PIN on the terminal.
- S6 PASS (UI): idle lock → «دخول موظف آخر» → owner signed in RTB Cashier Two: parked count 0, list «لا توجد مبيعات معلّقة» while the manager had 5. Bridge-level preview by id not attempted.
- S7 part 1 PASS: Cashier Two opened a shift (float 100.00, 14:53 local); close with counted 100 refused: «توجد مبيعات معلّقة… 5 مبيعات معلّقة على هذا الجهاز» + «عرض مبيعاتي المعلّقة» (count only, no owner/label/amount).
- S3 sign-out PASS: Cashier Two signed out («تأكيد تسجيل الخروج»); owner signed the manager in (new operator session 11bcb41d). DB: 5 parked carts keep session dfe481da (not re-attached); only the unparked active cart (84fbce40) was re-bound. Restart half NOT yet.
- S4/S5 catalogue change (owner ran 446-s4s5-apply.sql, 12:01:02Z; before-values 446-s4s5-before.txt): RT9 Item 03 7.25→8.00; «باراسيتامول شراب أطفال 120 مل» is_active→false. POS catalogue refreshed 12:02Z.
- S4 PASS: review «تغيّر سعر الصنف منذ التعليق» old 7.25 / new 8.00 / +0.75; «أبقِ البيع الحالي» left S2-b parked at 725 minor; then «علّق الحالي، اقبل التغييرات واستأنف» → cart.resume 12:04:11Z, line at 8.00.
- S2 swap-while-full PASS in the fresh session (count stayed 5, current cart parked). Confirms S1's cause is a completed sale in the SAME operator session.
- S8 PASS (UI): no «تراجع» offered after resume.
- S5 PASS: review «لم تعد في الكتالوج، وستُحذف…» with «ستُحذف»; accept → cart.line.remove reason unavailable_on_resume 12:04:59Z; 2 lines remain. (Refuse path exercised on S4 only.)
- S9: recovery card «مبيعات محفوظة لموظفين آخرين» lists parked sales with no labels; «إلغاء البيع» asks for the manager PIN («أدخل رقمك السري لتأكيد هذا الإجراء»). Nothing cancelled as of 12:09Z (PIN not entered). Note: the list shows the manager's own parked sales from earlier sessions as «موظف آخر».

- S3 restart PASS: POS restarted (forced-colors launch 12:11Z), owner signed the manager in: 5 parked carts still parked; local audit shows cart.reattached only for the unparked active cart.
- S9 NOT VERIFIED (owner decision 12:2xZ: record and continue). Owner typed the manager PIN on «إلغاء البيع» in recovery: refused «انتهى التأكيد أو لا يخص هذا الإجراء» (approval_invalid), no manager_approval.* audit row. Cause (code, e33fca25): recovery `heldRows` (manager-recovery.ts:303-323) lists carts of OTHER operator SESSIONS, so the manager's own parked sales from earlier sessions show as «موظف آخر» with a cancel button; the cancel resolver `othersHeldCart` (326-330) returns null when owning_operator_id == the manager → approval_invalid before the PIN is checked (four-eyes C6). Finding F-C: the list offers an action that can never succeed and the copy blames expiry. A valid S9 run needs a cashier-parked sale cancelled by a manager. Owner re-enrolled the manager PIN at 12:18:07Z while trying.
- S7 part 2 (close allowed after clearing) NOT VERIFIED: the 5 parked sales are the manager's own (see S9) and could not be cleared in this run.
- RT-754 forced colors (--force-high-contrast, 1280x800): Checkout tiles, selected (system highlight) and disabled (dashed/grey) states, focus rings, cash entry, «تأكيد الدفع النقدي», «تأكيد الدفع», completion all distinct and readable. Record only. (Operator slips: 15 Tabs from «بالضبط» hit backspace twice; the amount was re-set and paid 50.00, change 7.50.)

## RT-781 (Admin-Console 567f102, api image 79537b34, Backend-Core main 24196757 PIN)
- Owner approvals relayed by the parent 2026-10-23: (a)–(d) "Approve all", S4/S5 "Approve", runbook "Footer comment", 1.25 emulation OK.
- (a) The permission check refused the agent's update; the OWNER ran it (is_platform_admin=true on b74f1728; before false, 781-before-user.txt). Owner reset that lab user's password with Set-LabOwnerPassword.ps1 (argon2id in rt9-api; agent never saw it). The first script version wrote an empty hash (PowerShell 5.1 quote stripping); fixed and dry-run tested before the owner re-ran it.
- Harness: lab api runs with a Secure cookie → own origin https://<Host>. https proxy (self-signed) for the owner's browser; console-proxy-http.mjs on :4782 for the agent pane rewrites ONLY Origin http://localhost:4782 → https://localhost:4782 (owner-chosen). Plain http gave 403 origin_rejected (correct behaviour).
- (b) createTenant 201: 01a16893-e5fe-788d-9038-8b75371bb2d4 "RT781 lab support target" (11:44:45Z).
- (c) open 201: session 01a16894-0322-788d-9038-bc4e340a9105, customer_support, ticket RT-781, expires 12:44:53Z, cap 19:44:53Z. Bar (781-01-open-bar.jpg): purpose, ticket, tenant, «للقراءة فقط», remaining «ساعة واحدة · حتى 12:44 UTC», renew, end.
- renew via the bar button: 200, renewed_at 11:45:37Z, expires 12:45:37Z, notice «جُدّدت جلسة الدعم حتى … 12:45 UTC» (781-02-renewed-bar.jpg). Audit: platform.support_session.opened 11:44:53 + renewed 11:45:37, actor_label platform_support, tenant B (781-db-after-renew.txt).
- expire: check after 12:45:37Z.

## Tracking (parent, 2026-10-23)
- RT-836: resume blocked after a completed sale (S1 FAIL boundary).
- RT-837: manager cancel of own held cart (S9 / F-C).
- Park limit decision (no default limit, Console-configurable) has its own Planning issue superseding spec 024 K2; S2 stays PASS against spec 024 as written.

- RT-754 scale 125% (emulated: --force-device-scale-factor=1.25, window client 1280x800 physical = 1024x640 CSS; Windows display setting unchanged): Cashier Two (owner signed in, open shift). Sale (12 Tab stops) all visible; Checkout arrival focus on «نقدي»; Checkout stops visible; cash entry: the tender column becomes a scroll region, keypad bottom row (00/0/backspace) fully visible when focused but flush with the region bottom; «تأكيد الدفع النقدي» and «تأكيد الدفع» visible; completion 10.00 then «بيع جديد» → empty Sale with focus on scan. F-A reproduced at 125%: no visible ring on «بيع جديد» on arrival.
