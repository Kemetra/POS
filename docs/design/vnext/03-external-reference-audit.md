# 03 — External-reference audit and applicability notes

> RT-104 scope item 3. References captured on Confluence "Technology & Reference Radar"
> (page 7962659, UI/frontend section 2026-09-30) plus those named in RT-106 (ERPNext POS, Daftra,
> RuoYi Vue Pro, Khepri/Claude Design). Radar operating rule applies: *a promising link does not
> become an implementation decision* — Audit → bounded PoC when warranted → Implementation only
> after evidence and owner approval.

## Verdict summary (proposed radar status)

| Reference | Class | Proposed radar status | How it influences VNext (bounded) |
|---|---|---|---|
| awesome-design-md (VoltAgent) | AI/design-system guidance (format) | **Adopted — format only** (on owner approval) | The VNext design language is written so it can become the repo `docs/DESIGN.md` in DESIGN.md structure (VN-S1). No brand file copied. |
| Impeccable (pbakaus) | AI-design guidance (process) | **Adopted — review step only** (already used in repo) | `audit` / `critique` / `harden` as a review gate on each VN slice; RT rules win on conflict; RT supplies RTL/numeral checks it lacks. `.impeccable/design.json` must be regenerated from the approved language (VN-S1). |
| Component Gallery | Component reference | **Reference-only** | Naming/behaviour research for combobox, alert vs toast, table, dialog; cite upstream system (e.g. GOV.UK, Carbon, Fluent). |
| Refero Styles | Inspiration / AI-design | **Reference-only** | Research on dense operational UIs only; ToS forbids scraping/republishing; third-party brand identities — never an RT source. |
| 21st.dev | Component reference | **Reference-only** | Study ARIA/markup patterns; never paste (per-author licenses, extra deps, LTR physical classes, motion-heavy). |
| Kinetics | Motion reference | **Reference-only** | Idea of named motion tokens only; cashier motion ≤150–220ms, no springs/bounce. License unverified. |
| Colorion | Inspiration (colour) | **Rejected for this role** | Mood palettes without contrast validation; RT tokens are measured. |
| What Ships | Inspiration (launch videos) | **Rejected for this role** | Not operational UI. |
| HyperFrames (HeyGen) | Motion/video tooling | **Rejected for product UI** | HTML→MP4 renderer; could be revisited separately for training videos (out of scope). |
| ERPNext POS | Behaviour reference | **Reference-only** (unchanged) | Opening/closing entry framing, numpad field model, past orders → return; GPL-3.0, no code copy (CLAUDE.md §4). Customer-first rule conflicts with walk-in pharmacy. |
| Daftra | Regional benchmark | **Research candidate → priority audit** | Egyptian cashier vocabulary (وردية/جلسة), counted-cash session close, e-receipt expectations. Proprietary: no assets/copy. Its KB was not readable from this session → needs a human walkthrough (VN-S0 input). |
| RuoYi Vue Pro | Admin design-system | **Reference-only** (unchanged, RT-32) | Not relevant to the POS (Vue, admin, no RTL). |
| Khepri / Claude Design workflow | Process lesson | **Not on radar** — add as process note | Lesson from RT-27: a design handoff tool can default exploratory features ON and invent rules (4-char card ref, voucher `min()`, threshold discounts). VNext rule: every handoff is reconciled against RT-24 + specs before use, brainstorm features default OFF. |
| Tower Blue (RT-27 v3) | Design handoff | **Reference-only** | Layout/interaction reference; token bundle not retrievable from Atlassian and not adopted (OD-1). |

The detailed audit (canonical URLs, licensing, verification status, font measurements, numeral
measurements, WCAG notes) follows. Network caveat: several sites were blocked by the session
proxy; facts from search snippets are marked **UNVERIFIED** where not confirmed.

---

---

## 1. Summary table

| # | Reference | Canonical URL | What it is | Class | License / adoption constraints | Recommendation |
|---|---|---|---|---|---|---|
| 1 | Refero Styles | https://styles.refero.design (parent: https://refero.design) | Beta library of 2,000+ "DESIGN.md" style breakdowns taken from real product websites. The parent Refero library holds 130k+ web/iOS screenshots. | Inspiration + AI-design guidance | Proprietary. Styles is free in beta; the main Refero library has Free and paid plans. The ToS allows use in client/internal work (moodboards, research) but forbids scraping, automated extraction and republishing. Content is **third-party brand identities**. | **Reference only.** Use it to research dense operational UIs. Never adopt a brand's DESIGN.md as the RT system. |
| 2 | awesome-design-md | https://github.com/VoltAgent/awesome-design-md | Curated repo of 73 DESIGN.md files taken from brand sites (Stripe, Apple, Claude, Tesla…). DESIGN.md is a plain-markdown design-system format introduced by Google Stitch. | AI-design guidance / design-system guidance (format) | MIT for the repo. It says it does "not claim ownership of any site's visual identity", so the content is **third-party brand identities**. | **Influence, bounded to the format only.** Author RT's own `DESIGN.md` (tokens, type, RTL rules) in this structure. Copy no brand file. |
| 3 | 21st.dev | https://21st.dev (source: https://github.com/serafimcloud/21st) | YC-backed community registry of 12k+ shadcn/ui-format React + Tailwind + Radix components. Code is copied into your repo. Also offers the "Magic" AI generator. | Component reference | Platform code is MIT. Each component belongs to its **individual author**, so check per item. Freemium: search snippets say 2 free copies/day and a membership for unlimited copies and premium templates (**UNVERIFIED**, site blocked). Many components depend on framer-motion or extra npm packages, which would change the lockfile. | **Reference only.** Study patterns (command palette, combobox, number input). Re-derive in-house and never paste code. Items are marketing-leaning, mostly LTR with physical `ml-/mr-` classes, and motion-heavy. |
| 4 | The Component Gallery | https://component.gallery | By Iain Bean: 60 component types × 95 design systems, about 2,676 examples, linking to each system's docs. | Component reference / design-system guidance | Free index. Each linked system keeps its own license. Nothing to copy from the index itself. | **Influence (naming and behaviour research).** Use it to compare how GOV.UK, Carbon, Fluent and others do combobox, toast, table and alert, and to settle component names. High value, low risk. |
| 5a | Kinetics | https://kinetics.colorion.co (repo: https://github.com/ckissi/kinetics) | 153+ spring-physics micro-interactions. Each one ships CSS, React and an "AI prompt" with stiffness/damping readouts. By Csaba Kissi. | Motion reference | Described as "open source". **License not verified** (repo page gave no license). | **Reference only.** Borrow the idea of named, parameterised motion tokens. Cashier motion must be short and non-bouncy, and must honour `prefers-reduced-motion`. |
| 5b | Colorion | https://colorion.co (+ sub-tools: palettegenerator., material., 2colors., mobilepalette.colorion.co) | Curated palette gallery and generators by Csaba Kissi, with copy-HEX tools. | Inspiration (colour) | Free site. **No explicit palette license found** (UNVERIFIED). Palettes carry no contrast or accessibility validation. | **Do not use** for RT tokens. RT already has an approved teal clinical direction, and its tokens must be contrast-validated, not taken from mood palettes. |
| 6 | What Ships | https://whatships.com (repo: https://github.com/dingyi/whatships.com) | Index of 2,000+ startup **launch videos** posted on X, plus a directory of launch-video and mockup tools. | Inspiration (marketing video) | Repo code is MIT. The videos, trademarks and product names belong to their owners. | **Do not use.** It covers marketing launch films, not operational UI, and has no bearing on a cashier terminal. |
| 7 | HyperFrames (HeyGen) — verified | https://github.com/heygen-com/hyperframes | Apache-2.0 framework that renders HTML/CSS/GSAP/Lottie compositions to deterministic MP4 through headless Chrome and FFmpeg (Node 22+). Released 2026-04-17. | Motion reference (video tooling) | Apache-2.0, no paid tiers. The README says it is explicitly **not** for in-app UI animation. | **Do not use in the product.** At most, a later, separate option for cashier training or demo videos (out of scope). |
| 8 | Impeccable | https://impeccable.style (repo: https://github.com/pbakaus/impeccable) | By Paul Bakaus (jQuery UI). Design skill for AI agents with 24 commands (`craft`, `audit`, `critique`, `polish`, `harden`…), 61 deterministic detector rules (CLI and extension, no LLM) and anti-pattern guidance. Grew out of Anthropic's frontend-design skill. | AI-design guidance | Apache-2.0, free. | **Influence (process tool, bounded).** Already in use in this repo and session. Use `audit`/`critique`/`harden` as a review gate. Its taste defaults (e.g. "distinctive" fonts, boldness) do **not** override RT's approved direction, WCAG, or the cashier's need for density and speed. It has no RTL/Arabic-specific rules, so RT must supply them. |
| 9 | ERPNext POS | https://github.com/frappe/erpnext (`erpnext/selling/page/point_of_sale/`); docs https://docs.frappe.io/erpnext/user/manual/en/point-of-sales | Frappe's browser POS. The flow is POS Opening Entry → item selector / cart with numpad (Qty/Discount/Rate) → payment → past orders and returns → POS Closing Entry. Since v13, POS Invoices are consolidated into one Sales Invoice at closing. | Inspiration (reference behaviour) | ERPNext is **GPL-3.0**. CLAUDE.md §4 says it is reference behaviour only, with **no ERPNext code copied**. | **Reference only (behaviour).** Useful for shift open/close, the numpad-field model and the returns entry point. Its shortcuts (Ctrl+Enter checkout, Ctrl+Q/D/R field, Ctrl+Backspace delete, Shift+Ctrl+C close) are a vocabulary to compare against, not to adopt. Offline robustness is weak by community account (third-party offline POS apps exist for this reason). |
| 10 | Daftra (دفترة) | https://www.daftra.com ; POS KB https://docs.daftra.com/en/user_manual/point-of-sales-guide-pos/ | Proprietary cloud ERP + POS from Izam Web Solutions (HQ Giza, Egypt, and the US). Arabic/English. Offline invoicing with later sync, receipt printers, scanners, scales, cashier sessions/shifts with counted-cash close, **Egyptian ETA e-receipt integration**, and a keyboard-shortcuts KB page. | Inspiration (regional conventions) | Proprietary SaaS and commercial product. **Do not copy UI, assets or copy.** Observe only through public docs and store listings. | **Reference only, high priority.** It is the closest regional analogue. Use it to benchmark the Arabic terms cashiers already know (e.g. جلسة/وردية, إغلاق الجلسة), session-close with counted cash, and what e-receipt (ETA) fields Egyptian cashiers expect. Details were **not directly verified** because the KB was blocked, and the shortcut list could not be read. |
| 11 | RuoYi-Vue-Pro (芋道) | https://github.com/YunaiV/ruoyi-vue-pro | Chinese Spring Boot + Vue 3 (Element Plus / Vben) admin framework with RBAC, multi-tenancy, workflow, and ERP/Mall modules. The README mentions a Mall POS (not verified). | Design-system guidance (admin) | MIT. The stack is Java/Vue. No RTL/i18n was evident. | **Do not use** for POS. The stack does not match (Vue, not React), it is an admin/back-office UI, and it has no RTL. At most it is marginal IA reference for Admin-Console, which is outside this repo's scope. |

---

## 2. Per-reference notes

### 2.1 Refero Styles
- URLs: https://styles.refero.design · https://refero.design/pricing · ToS https://doc.refero.design/legal/terms-of-use (last updated 2026-08-03 per search snippet). There is also an unofficial MCP: https://github.com/fidgetcoding/refero-design-mcp.
- What it is: "Design taste, extracted". You search by brand, mood, colour, type or URL, and each style breaks down into colours, type, spacing, components and a DESIGN.md for agents. It is a spin-off of the Refero screenshot library.
- POS relevance: the only useful part is research on dense data tables, keyboard-first apps and checkout screens. Nearly all catalogued brands are Western LTR marketing sites.
- Constraints: every style is a third-party brand identity, and the ToS forbids automated extraction or republishing. Feeding a brand DESIGN.md to an agent imports someone else's identity, which conflicts with RT's own approved visual authority (spec 022 design handoff).
- Verdict: **reference only.**

### 2.2 awesome-design-md
- URL: https://github.com/VoltAgent/awesome-design-md (MIT, about 119k stars at fetch time).
- What it is: 73 DESIGN.md files. DESIGN.md is a plain-markdown, agent-readable design-system document (Google Stitch origin) that covers tokens, typography, colour, components and layout.
- POS relevance: the **format** helps. A repo-local `DESIGN.md` for RT that restates tokens, RTL rules, numeral policy, density and focus rules would give Claude, Impeccable and other agents one grounding file. The brand contents do not help.
- Verdict: **influence, bounded.** Adopt the file structure. Write all content from RT tokens and the owner-approved handoff. Copy no brand file.

### 2.3 21st.dev
- URLs: https://21st.dev · https://github.com/serafimcloud/21st (MIT for the platform) · Lovable integration notes https://docs.lovable.dev/tips-tricks/21stdev.
- What it is: shadcn-registry-format components (`npx shadcn add …`) from many authors. Authors keep authorship and can sell templates.
- POS risks:
  - Per-component provenance and license vary.
  - Items often pull new dependencies (framer-motion, etc.), which CLAUDE.md §10 forbids without authorisation.
  - The style is showcase and marketing, with gradients, shaders and heavy motion.
  - Components are mostly LTR and seldom use logical properties.
  - The Constitution's "no copy-paste, re-derive" discipline applies in spirit.
- Verdict: **reference only.** Read the markup and ARIA of a combobox or command palette, then build RT's version test-first.

### 2.4 The Component Gallery
- URL: https://component.gallery (Iain Bean, since 2019, built with Astro + Airtable).
- POS relevance: settling names and behaviour for combobox/autocomplete (product search), toast vs alert (sync state), table, badge, empty state, skeleton, modal/dialog and segmented control across 95 systems. Several of those systems document RTL (e.g. Fluent, Carbon).
- Verdict: **influence** as a research index. Cite the upstream system in design notes, not the gallery.

### 2.5 Kinetics and Colorion (same author, Csaba Kissi)
- Kinetics: https://kinetics.colorion.co · https://github.com/ckissi/kinetics (license **UNVERIFIED**). A third-party guide at https://github.com/peditx/kinetics notes it "always respect[s]" `prefers-reduced-motion`.
- Colorion: https://colorion.co plus palette sub-tools. Palettes are mood-based with no contrast validation. License **UNVERIFIED**.
- POS relevance: motion in a cashier terminal should confirm state changes (item added, payment settled, error) in ≤150–200 ms, without overshoot or bounce, and must never delay the next scan. Spring tokens with high damping are acceptable as a *parameterisation* idea only.
- Verdict: Kinetics is **reference only**. Colorion is **do not use**.

### 2.6 What Ships
- URLs: https://whatships.com · https://github.com/dingyi/whatships.com (MIT code; "third-party video content remain[s] the property of their respective owners").
- It is a gallery of X-posted product launch videos plus a tools directory (Ultramock, MOVO, ui.camera…).
- Verdict: **do not use.** It is marketing video, not an operational UI pattern source.

### 2.7 HyperFrames — identity verified as HeyGen's
- URL: https://github.com/heygen-com/hyperframes (Apache-2.0). Needs Node 22+, FFmpeg and headless Chrome (Puppeteer). Output is MP4. The README states it is for video rendering, not in-app animation.
- Verdict: **do not use** in the POS. It could be considered later, separately, for training clips.

### 2.8 Impeccable
- URLs: https://impeccable.style · https://github.com/pbakaus/impeccable (Apache-2.0) · background https://www.latent.space/p/skill-engineering-design, https://www.a16z.news/p/impeccable-by-design.
- Contents: 24 commands, 61 deterministic detector rules (overused fonts, grey-on-colour, nested cards, dated easing, spacing, some a11y), and `harden` (error handling, i18n, text overflow, edge cases).
- Gaps for RT: no RTL/Arabic, numeral or bidi rules were found, and its taste defaults lean toward "distinctive" and "bold".
- Verdict: **influence as a review process.** Run `audit`/`critique`/`harden` on RT screens. RT's constitution, spec 022 authority and WCAG win on conflict. Add RT-specific RTL and numeral checks alongside it.

### 2.9 ERPNext POS
- Source: https://github.com/frappe/erpnext/tree/develop/erpnext/selling/page/point_of_sale (GPL-3.0). Docs: https://docs.frappe.io/erpnext/user/manual/en/point-of-sales, POS Invoice consolidation https://docs.frappe.io/erpnext/user/manual/en/pos_invoice_consolidation.
- Verified from source (`pos_controller.js`, `pos_item_cart.js`):
  - Components are Item Selector, Item Cart (with numpad), Item Details (serial/batch), Payment, and Past Order List/Summary.
  - An Opening Entry dialog is required. The code assumes one active opening voucher per user.
  - The cart blocks adding items until a customer is selected and validates stock.
  - Shortcuts: Ctrl+Enter checkout; Ctrl+E edit cart; Ctrl+Q/D/R select the numpad field; Ctrl+Backspace delete; Shift+Ctrl+Backspace remove; Ctrl+F form view; Shift+Ctrl+C close POS.
  - The numpad works by "select a field, then type digits". Pressing the same field again deselects it. Discount is capped at 100%.
- Relevance:
  - Good reference for session/shift framing, numpad field semantics, and past orders → returns.
  - Poor reference for scanner-first flow, Arabic RTL density and offline robustness.
  - The mandatory customer-first rule conflicts with walk-in pharmacy retail.
- Verdict: **reference only.** No code copy (CLAUDE.md §4, GPL).

### 2.10 Daftra
- URLs: https://www.daftra.com · POS guide https://docs.daftra.com/en/user_manual/point-of-sales-guide-pos/ · sessions https://docs.daftra.com/en/tutorial/pos-sessions-list/ · closing https://docs.daftra.com/en/tutorial/closing-a-pos-session/ · shortcuts https://docs.daftra.com/en/tutorial/keyboard-shortcuts-in-pos/ · ETA e-receipt https://docs.daftra.com/en/user_manual/linking-daftra-to-the-electronic-receipt-system/ · desktop app https://www.daftra.com/en/pos-desktop-application/ · Android app `com.izam.daftraPos`.
- Evidence (from search snippets, since the pages were blocked):
  - Offline invoicing with automatic sync.
  - Receipt printer, barcode scanner and electronic scale support.
  - Product images, units, expiry and serials.
  - Cash movement tracking and a session-close comparison.
  - Closing a session means date/time, a summary, entering counted cash, and choosing whether the balance goes to Staff or Treasury.
  - Integration with the ETA e-invoice and e-receipt systems.
  - POS settings: default client, invoice layout template, enabled and default payment methods.
- Relevance: the most relevant regional benchmark for Egyptian cashier vocabulary, session-close UX and e-receipt expectations. **Note:** RT's VAT/fiscal work is deferred (008-v2), so ETA-receipt UI is out of the current scope. Observe it without designing for it.
- Verdict: **reference only (priority benchmark).** It is a proprietary competitor: no assets, screenshots or copy may be reused. Next step: an owner-approved manual walkthrough of its public docs, or a trial run by a human, to capture its shortcut map. That was not possible here.

### 2.11 RuoYi-Vue-Pro
- URL: https://github.com/YunaiV/ruoyi-vue-pro (MIT; related orgs https://github.com/yudaocode). Stack is Spring Boot + Vue 3 Element Plus / Vben (Ant Design Vue) / Vue 2.
- Verdict: **do not use** for the POS (Vue, admin-oriented, no RTL evidence). Irrelevant to Kemetra/POS.

---

## 3. Design-language guidance (evidence-based)

### 3.1 Arabic UI fonts (all SIL OFL 1.1, measured from Google Fonts binaries)

| Font | Designer | Axes / weights | Western 0–9 | Arabic-Indic ٠–٩ (U+0660–0669) | U+066B / U+066C (Arabic decimal / thousands sep.) | Digit widths (tabular?) |
|---|---|---|---|---|---|---|
| **Noto Sans Arabic** | Google | variable `wght` 100–900 + `wdth` | yes | yes | yes | **Both sets tabular by default** (all 572 u); has `pnum` for proportional |
| **IBM Plex Sans Arabic** | Abbink, Bold Monday, Apelian, Morcos | 7 static weights (no variable) | yes | yes | yes | Western tabular (600 u); Arabic-Indic **proportional**, no `tnum` |
| **Cairo** | Mohamed Gaber (Kufi-based, extends Titillium) | variable `wght` 200–1000 + `slnt` | yes | yes | yes | Western tabular (560 u); Arabic-Indic **proportional**, no `tnum` |
| **Tajawal** | Boutros Fonts | 7 static weights | yes | yes | **NO** (missing; falls back or shows tofu) | **Both proportional**, no `tnum`. Poor for money columns |

Implications:
- For price, quantity and total columns that must align, **Noto Sans Arabic** is the safest choice because its digits are tabular in both scripts. Plex Arabic and Cairo align only if Western digits are used.
- Tajawal is **not recommended** for money: its digits are proportional and it lacks the Arabic decimal and group separators.
- All are OFL. Self-host through `@fontsource/*` (no CDN, for offline use). Keep the OFL text alongside the files. Adding an npm font package is a dependency change and needs authorisation (CLAUDE.md §10). Note the repo's existing `no-brand-font` guard test.
- Sources: https://fonts.google.com/noto/specimen/Noto+Sans+Arabic · https://fontsource.org/fonts/ibm-plex-sans-arabic · https://fonts.google.com/specimen/Cairo · https://github.com/googlefonts/tajawal

### 3.2 Arabic-Indic vs Western digits (Egypt)
- CLDR/ICU: `ar-EG` defaults to the `arab` numbering system. Measured in Node 22 ICU:
  - `Intl.NumberFormat('ar-EG',{style:'currency',currency:'EGP'}).format(1234.5)` → `‏١٬٢٣٤٫٥٠ ج.م.‏`. This uses Arabic-Indic digits, U+066C/U+066B separators, and **U+200F RLM marks embedded**.
  - `ar-EG-u-nu-latn` → `‏1,234.50 ج.م.‏`.
  - Bare `ar` → `1,234.5` (Latin).
  - So digit choice is an explicit decision, and the locale tag must be pinned. Source: https://hexdocs.pm/ex_cldr_numbers/Cldr.Number.System.html, https://helw.net/2025/05/31/arabic-numbers-and-regions/
- Usage: W3C ALREQ lists Arabic-Indic digits as typical for Egypt (https://w3c.github.io/alreq/). Popular and secondary sources report both systems in use in Egypt. Arabic-Indic appears on signage and some price tags, while Western digits are common on phones, price tags and printed receipts (https://en.wikipedia.org/wiki/Eastern_Arabic_numerals, https://www.inside-egypt.com/arabic-numerals-in-egypt.html). These are low-authority sources, so the owner should confirm against real Egyptian pharmacy receipts.
- Bidi: Arabic-Indic digits are bidi class **AN**, Western digits are **EN** (ALREQ; https://github.com/w3c/alreq/issues/85). Mixed runs such as barcodes, SKUs, batch numbers and phone numbers must be isolated (`<bdi>` / `dir="ltr"` / `unicode-bidi: isolate`).
- Recommendation to decide:
  - Pick **one** numeral system per surface and hold it consistently. A common Egyptian retail choice is Western digits for codes, barcodes, SKUs and the receipt, and optionally Arabic-Indic for prose.
  - Always display barcode and scanned input in Western digits, since scanners emit ASCII.
  - Normalise ٠–٩ and ۰–۹ to ASCII on input (https://www.sultanbyte.com/arabic-digits-web-forms-validation).
  - Strip RLM and check glyph support before sending ICU output to a thermal printer.

### 3.3 WCAG 2.2 targets and focus (sources: w3.org Understanding docs, via search snippets)
- **2.5.8 Target Size (Minimum), AA:** targets must be ≥ **24×24 CSS px**. The exceptions are Spacing (a 24 px circle centred on each undersized target must not intersect another target or circle), Equivalent, Inline, User-agent control, and Essential. The 2.5.5 Enhanced (AAA) level is 44×44. Cashier practice: at 1024 px, keep primary tender and numpad keys well above 44 px. Dense row actions can sit at the 24 px floor with spacing. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- **2.4.11 Focus Not Obscured (Minimum), AA:** the focused element must be at least partly visible, not hidden by author content such as a sticky header or footer or a non-modal panel. Failure technique F110; fix C43 (`scroll-padding`). This matters for a fixed totals bar or tender footer over the cart list. https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- **2.4.13 Focus Appearance, AAA:** the indicator area must be ≥ a **2 CSS px thick perimeter** of the component, with **≥3:1 contrast** between focused and unfocused pixels. Not required at AA, but it is the right target for a keyboard-first terminal. Pair it with 2.4.7 Focus Visible (AA) and 1.4.11 Non-text Contrast. Techniques: C40 (two-colour indicator), C41. https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
- Note: the brief's label "focus appearance (2.4.11/2.4.13)" is only partly right. In final WCAG 2.2, 2.4.11 is *Focus Not Obscured*, and Focus Appearance is 2.4.13.

### 3.4 Reduced motion and forced colours in Electron/Chromium
- **prefers-reduced-motion:** Chromium maps it from the Windows setting, which is Windows 10 *Settings › Ease of Access › Display › Show animations* and Windows 11 *Settings › Accessibility › Visual effects › Animation effects*. The page cannot override it. It means "reduce non-essential motion", not "no feedback", so replace motion with instant state and colour changes. Test with the Chromium flag `--force-prefers-reduced-motion` or DevTools emulation. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion · https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/accessibility/reduced-motion-simulation
- **forced-colors (Windows Contrast Themes):**
  - Use `@media (forced-colors: active)`.
  - Chromium overrides author colours with system colours (`Canvas`, `CanvasText`, `ButtonText`, `Highlight`, `LinkText`, `GrayText`…) and drops `box-shadow` and background images.
  - Focus rings built from `box-shadow` **disappear**. Use `outline` (a transparent outline becomes visible in forced colours).
  - State shown only by background tint (selected row, sync status badge) also disappears. Add border, icon or text.
  - Use `forced-color-adjust: none` sparingly (e.g. product images or brand swatches).
  - `-ms-high-contrast` is deprecated.
  - In the main process, Electron exposes `nativeTheme.shouldUseHighContrastColors` and the `updated` event.
  - Sources: https://blogs.windows.com/msedgedev/2020/09/17/styling-for-windows-high-contrast-with-new-standards-for-forced-colors/ · https://blogs.windows.com/msedgedev/2024/04/29/deprecating-ms-high-contrast/ · https://www.electronjs.org/docs/latest/api/native-theme · http://adrianroselli.com/2021/02/whcm-and-system-colors.html

---

## 4. Unverified / not done
- Pages that could not be fetched directly (search snippets only): 21st.dev pricing, the Kinetics and Colorion licenses, and all Daftra KB content (including the actual shortcut map).
- The RuoYi Mall "POS" module was not verified.
- Offline behaviour of current ERPNext POS: sources conflict (official v13 docs say offline works; community offline-POS apps claim it is weak). Not tested.
- Egyptian receipt numeral convention: secondary sources only. Needs owner confirmation against real pharmacy receipts.
