# rt9 combined re-verification — 2026-10-23 (RT-446 S1/S7b/S9, RT-754 AC4, RT-782 lab AC)

## Builds and lab
- POS `origin/main` `5dc16c5a` (includes RT-836 #814 `1eac12f9`, RT-837 #815 `34445183`, RT-840 #816 `4d60cf9f`), unsigned packaged `win-unpacked` built in a temporary worktree.
  `POS Pulse.exe` sha256 `22fa3784…f6dc224`, `app.asar` `52ac03fd…7d873` (`pos-build-hashes.txt`). Electron 44.5.1.
  The asar contains the RT-840 helper: `function Mm(e){e?.focus({focusVisible:!0})}`.
- Admin-Console `origin/main` `1cafbe9` (RT-782 #183), `vite build` with `VITE_API_BASE_URL` empty (same origin), served by `console-proxy-http.mjs` on http://localhost:4782 (rewrites only Origin `http://localhost:4782` → `https://localhost:4782`, as in RT-781).
- Lab api `rt9-api:79537b34` (image `sha256:f5f32624…db755c4`), :13000; migration `0062_platform_support_sessions` applied (2026-10-21 20:04:39Z). Backend-Core `main` `24196757` = PIN.
- Launcher `D:\rt9rerun-launch.sh` (same feature flags as rt9combo; `POS_PULSE_FEATURE_SALE_TENDERS_SINCE` unset, so no tenders sent). Fresh profile `D:\rt9rerun-userdata`, new terminal «RT bench 96895000» paired by the owner.
- Driver: `pos.ps1` / `posq.ps1` (SendInput keys + PrintWindow, no CDP, no mouse on the POS). Sign-ins and all PINs typed by the owner.
- Owner approval (this session, AskUserQuestion): "Approve all" for (1) platform-admin flag, (2) two test tenants, (3) suspend the second one, (4) one support session each, (5) :4782 proxy, (6) normal POS test activity. For (3) the owner later said «اتصرف انتا», and the agent ran the approved suspend SQL itself.

Lab DB 14:24:20Z → 15:20:01Z: sales 93 → 97, sale_tenders 11 → 11, audit_events 2403 → 2414, platform_support_sessions 1 → 3, pairing_codes 33 → 36, tenants 2 → 4 (both new ones soft-deleted).

## RT-446
- S1 (1280×800, manager, same operator session):
  - park «R1-park» (RT9 Item 01, 10.00) 14:29:53Z;
  - cash sale RT9 Item 03 7.25 to completion;
  - «بيع جديد» → «المبيعات المعلّقة» → «استئناف البيع»: `cart.resumed` 14:32:26Z, line intact, count 1 → 0. **PASS**.
  - Sub-check: re-parked as «S1b-park» 14:32:49Z, completed a second cash sale (Item 02 25.50), then with Item 03 in the cart resumed S1b. The review offered «علّق البيع الحالي واستأنف المحدد»; accepted → `cart.parked` + `cart.resumed` 14:34:00Z. **PASS** (A5).
- S7 first half (re-checked in passing): RT227 Cashier One opened a shift (float 100.00, 14:41:54Z) and parked «C-park» (25.50, 14:43:19Z). Close with counted 100: refused «توجد مبيعات معلّقة على هذا الجهاز… 3 مبيعات معلّقة على هذا الجهاز» + «عرض مبيعاتي المعلّقة» (count only).
- S9:
  - The manager's «مبيعات محفوظة» lists the cashier's held sale under «RT227 Cashier One» and the manager's own as «أنت». Every row offers «إلغاء البيع» (`446r-s9-03-recovery.png`).
  - First attempt: the fresh terminal had no manager PIN. The dialog says «لا يوجد لك رقم سري مدير مفعّل على هذه الطرفية. سجّله من شاشة الوردية، ثم عُد.» and «تأكيد» is disabled (truthful cause). The owner enrolled the PIN.
  - Off-driver (done by the owner; not seen by the agent; recorded in local audit):
    - 14:51:26Z `manager_approval.granted` + `cart.held_cancelled_by_manager` on «C-park» (cashier-owned);
    - 14:56:00Z and 14:56:05Z, approvals + cancels of the manager's own «M-own» and the 7.25 held cart (`manager_cancelled_held`);
    - 14:56:26–48Z, a manager cart was parked, resumed and voided;
    - 14:59:30Z, the cashier parked a new 10.00 sale.
  - Witnessed:
    - 15:00:00Z wrong PIN → «الرقم السري غير صحيح أو غير مفعّل.» (`manager_approval.refused`; names the PIN, not expiry);
    - 15:04:41Z correct PIN → `manager_approval.granted` + `cart.held_cancelled_by_manager` on the cashier's 10.00 sale, then «أُلغي البيع المحفوظ.» and «لا توجد مبيعات محفوظة.». **PASS**.
- S7 second half: with 0 held sales the cashier closed with counted 100 → «أُغلقت الوردية.» (15:06:36Z, normal, variance 0). **PASS**.
- Local audit: 0 payloads contain a park label or `park_label` (`local-pos-reads.txt`).
- Observation (copy): the dashboard card «المبيعات المعلقة» still reads «دفع معلّق، أو مبيعات محفوظة لموظفين آخرين.», though the panel now also lists the manager's own sales («أنت»).

## RT-754 AC4 (F-A re-check, keyboard Enter path)
- 1280×800: two cash completions; 1024×768: one card completion; 125% emulated (`--force-device-scale-factor=1.25`, 1280×800 physical = 1024×640 CSS): one cash completion.
- In every case the arrival capture (no key pressed) shows «بيع جديد» with **no focus ring**. Tab → the rail «لوحة المتابعة» shows a ring. Shift+Tab → «بيع جديد» shows the ring. So focus is on «بيع جديد» but `:focus-visible` is not matched on arrival. **FAIL**.
- First failing boundary: `src/renderer/v5/checkout/CompletionPanel.tsx` mount effect → `focusVisibly()` (`src/renderer/v5/foundation/focus-visibly.ts`, `focus({ focusVisible: true })`). In packaged Electron 44.5.1 the ring is not drawn. The unit tests run in jsdom and cannot show this.
- Not regressed: Checkout arrival focus on «نقدي» (1280, 1024, 125%); «تأكيد الدفع» after the cash confirm shows a ring; focused controls are fully visible at 125% (the keypad's last key and «تأكيد الدفع النقدي»).

## RT-782 lab AC (Console `1cafbe9`, api image `79537b34`)
- (1) is_platform_admin true on `b74f1728` at 14:27:28Z (owner ran `RT782-Admin-On.cmd`).
- (2) createTenant 201 ×2 at 15:15:06Z: normal `01a16954-7918-7559-99ae-18555b5c5b06`, suspended-target `01a16954-7925-7559-99ae-4db1a7981a9c` (no members).
- Directory `/platform/tenants`: 3 of 3. The member «RT9 Lab Tenant» shows «أنت عضو فيها» with only «فتح المؤسسة»; the test tenants show «بدء جلسة دعم». The soft-deleted RT-781 tenant is not listed. No status words (known contract gap; the static note «المؤسسة الموقوفة تُفتح جلستها للقراءة فقط.» is shown).
- Normal: the drawer (purpose «دعم العملاء», ticket `RT-782`) returned 201, session `01a16955-845f-7559-99ae-7197bef2b47e`, expires 16:16:14Z. The bar shows «وصول دعم», «تعمل الآن داخل: RT782 normal target», «الغرض: دعم العملاء», «التذكرة: RT-782», «للقراءة فقط», «متبقٍّ: ساعة واحدة», renew and end; no break-glass. Ended from the bar → `/current/end` 200 (15:16:46Z, end_reason operator).
- (3) status → suspended at 15:17:46Z (agent ran the approved SQL).
- Suspended: the drawer returned 201, session `01a16957-c96f-7559-99ae-8844fa1624c7`, expires 16:18:43Z; the same read-only bar with no break-glass. Ended → 200 (15:19:11Z).
- Audit: `platform.support_session.opened`/`.ended` ×2 each, actor_label `platform_support`.
- Not captured live: the request body. A fetch logger in the page was refused by the agent permission check. The response shows purpose and ticket_ref only; the body key set is covered by the merged e2e (`postDataJSON`).
- Observation: the bar for the suspended tenant does not say the tenant is suspended (the session response has no tenant status).
- Reverts: status → active 15:19:51Z; soft-delete 204 ×2 (15:19:52Z); is_platform_admin → false 15:20:01Z. Left: 2 ended session rows, 4 audit rows, 2 soft-deleted tenants.
