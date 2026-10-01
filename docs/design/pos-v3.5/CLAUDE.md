> ## ⚠️ HISTORICAL — REFERENCE ONLY, NOT AUTHORITATIVE
>
> This folder is the **historical POS v3.0/v3.5 design handoff**. Nothing in it governs current
> POS-Pulse work: not the visuals, not the behaviour, not the copy. Do not implement from it.
>
> | For | Current authority |
> |:--|:--|
> | Visual design system | [`docs/DESIGN.md`](../../DESIGN.md), the approved RT-104 VNext language ([`docs/design/vnext/`](../vnext/README.md)) |
> | Cashier behaviour and transaction semantics | Jira **RT-24** (Cashier UX & Transaction Behavior Map) |
> | Current code behaviour | GitHub `main` |
>
> What v3.5 shows that is superseded: dark default (now light-first), navy `#1f4e7a` (now
> pharmacy teal `#0f766e`), the One-Accent Rule (teal may fill the primary commit), Inter (now
> Dubai), and the v3.5 layouts (the active sale now uses VNext Direction B). Its feature and
> tender scope is not product scope; current scope comes from Jira RT.
>
> Use it only as a reference for intent, and re-derive anything you take from it against the
> authorities above. Banner only — nothing below was rewritten or deleted.

# CLAUDE.md — POS v3.0 terminal implementation

You are implementing **POS v3.0**, an Arabic-first (RTL) pharmacy/retail point-of-sale terminal
built on the **Retail Tower OS — POS Pulse** design system.

## Read first
1. `README.md` — the full handoff spec (screens, tokens, rules).
2. Open `POS-Terminal-prototype.html` in a browser and walk every screen and flow.
3. `design-reference/pos-app.jsx` + `design-reference/kit.css` — authoritative behavior, copy,
   and styling. Lift exact strings, money math, and class names from here.

## The job
Recreate the prototype **in this codebase's existing environment** (the POS-Pulse repo is
Electron 40 + React 19 + Tailwind 4) using its established primitives, tokens, and patterns —
**not** by pasting the prototype JSX/CSS. The prototype's class names (`.btn`, `.cart-pane__*`,
`.tender-slots`, `.pin-pad__*`, `.account-row`, `.roster-list__*`, …) already map 1:1 to the
shipped stylesheet (`src/renderer/styles/tailwind.css`), so map them straight across. Reuse the
existing `Button`, `Input`, `PinPad`, `Badge`, `Card`, `DataTable`, `StatusBanner`, `Toast`,
`Dialog`, `NavRail`, `TopBar`, `OperatorBadge`, `ConnectionIndicator`. Do not build restyled
lookalikes. If no codebase exists, choose an appropriate stack and implement there.

## Non-negotiables
- **RTL default**, Arabic operator copy; **Latin/mono** for IDs, SKUs, barcodes, member numbers,
  and all money; **Latin numerals on receipts**.
- **Dark theme is the default**; light is a token-override toggle only — add no new components for
  it. Persist theme in `localStorage`.
- **Money in minor units (piasters).** 14% VAT applies to `vatable:true` lines only; medicines
  (`vatable:false`) are VAT-exempt. Never round for aesthetics.
- **Persistent banners** for offline/degraded/syncing state — **never** toasts. Toasts are only
  for ephemeral acknowledgements of user actions.
- **One-Accent Rule** (teal = nav active tab + focus rings only) and **Status-Color Containment**
  (semantic colors only on badges/banners/callouts, never decorative).
- **No emoji, no second font, no glassmorphism, no gradient text, no metric-hero cards.**
- Every accountable action (sign-in, shift open/close, Rx dispense, void, line removal, refund,
  sale) must be **audit-logged** and attributable to the signed-in operator. Sales persist locally
  and sync up when online; offline → queued. Honesty-first copy throughout.
- Touch-target floor **44×44px**. Honor `prefers-reduced-motion`.

## Scope checklist
Sign-in · open shift · sale/cart (search, category chips, product grid, pack/unit sell, Rx gate,
interaction warnings, expiry/stock, hold/void) · tender (cash/card/voucher/credit/insurance
co-pay) · receipt + reprint · returns/refund slip · audit log · dashboard · close shift / Z-report
· inventory · settings · customer-facing display (F8). Keyboard shortcuts: `/` `F2` `F3` `F8` `Esc`.

Ask the user before adding any screen, field, or content not present in the prototype.
