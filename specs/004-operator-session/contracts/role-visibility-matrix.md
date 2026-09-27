# Contract — Role Visibility Matrix

**Plan:** [../plan.md](../plan.md) (v1.1)
**Spec FRs codified:** FR-015 (Cashier-Forbidden Information catalogue),
FR-017 (manager surfaces), FR-018 (admin surfaces), FR-019
(information-layer enforcement), FR-024 (forced-close manager-only),
FR-029 (audit-log manager-only).

This document is the **canonical role visibility matrix** for 004 and
every feature that follows. It is the source of truth that:

- The renderer-side `<OperatorRouteGuard>` route table compiles against.
- The bridge-API role-enforcement helper (`requireRole`) consumes per call.
- `/speckit-tasks` references when scheduling per-route implementation work.
- Reviewers consult during the SC-003 walkthrough (cashier-route audit).

**One row per surface.** A surface is a route, a bridge call, a query, a
report, or any other "named information region" the cashier could
plausibly try to reach. The cell values are normative.

---

## Reading the matrix

| Symbol | Meaning |
|:--:|:--|
| ✅ | Reachable AND populated for this role. |
| 👀 | Reachable but renders only role-appropriate information (e.g., the manager surface for the manager's own branch only; cross-branch info is filtered server-side). |
| 🔒 | Reachable as a placeholder by 003's existing route, but cashier-forbidden information NEVER renders for this role; cashier sees a generic "this section is not available for your role" surface (FR-016). |
| ⛔ | NOT reachable for this role. The route MUST NOT resolve, the bridge call MUST refuse generically, and the search/quick-action results MUST NOT mention it. Tested by SC-003 walkthrough. |
| — | Out of scope for 004; documented for completeness so future features have the role-gating decision pre-made. |

**Default rule when this matrix is silent on a future surface**: the surface
is `⛔` for cashier and `👀` for manager and admin until a feature spec
adds an explicit row. New features that introduce new surfaces MUST add
rows here.

---

## Section 1 — Sign-in & boot routes

| Surface | Route / call | `cashier` | `manager` | `admin` | Notes |
|:--|:--|:--:|:--:|:--:|:--|
| Pairing surface | `/pairing` (002) | — | — | — | 002 owns this; 004 does not change it. Reachable when no device token is present, regardless of operator session (which is meaningless without a paired terminal). |
| Post-pairing landing | `/paired` (002) | — | — | — | 002 owns this; 004 routes onward to `/sign-in` from here. |
| **Sign-in surface (cashier path)** | `/sign-in` (cashier roster + PIN) | ✅ | ✅ | ✅ | All three roles use `/sign-in`. The roster IS visible for everyone, but only cashier rows appear in the list (managers / admins use a separate identifier+password form on the same route). |
| **Sign-in surface (manager / admin path)** | `/sign-in` (identifier+password form) | ✅ | ✅ | ✅ | Same `/sign-in` route; the form is part of the surface. The form being filled out before the cashier roster picker is normal use. |
| Sign-out trigger | `bridge.operator.signOut` | ✅ | ✅ | ✅ | Reachable from any signed-in role per FR-008. |

---

## Section 2 — 003 placeholder shell routes (post-sign-in)

These are the existing 003 placeholder routes. 004 does NOT introduce new
content for any of them; it only overlays role-gating. The "Notes" column
states what 004's overlay does.

| Surface | Route | `cashier` | `manager` | `admin` | Notes |
|:--|:--|:--:|:--:|:--:|:--|
| Sales surface (placeholder) | `/app/sales` (003) | ✅ | ✅ | ✅ | All roles reach the placeholder; sales business logic is owned by 005. |
| Cart surface (placeholder) | `/app/cart` (003) | ✅ | ✅ | ✅ | Placeholder; future feature owns. |
| Receipt / Checkout surface (placeholder) | `/app/checkout` (003) | ✅ | ✅ | ✅ | Placeholder; tender slots reserved by 003 stay layout-only per 003's exclusions. Future 005-checkout-payments owns. |
| Inventory surface (placeholder) | `/app/inventory` (003) | ✅ | ✅ | ✅ | Placeholder; future feature owns. |
| Settings surface (placeholder) | `/app/settings` (003) | 🔒 | ✅ | ✅ | The cashier's `/app/settings` route resolves to a generic "this section is not available for your role" surface. The 003 placeholder body MUST NOT render for cashier. (FR-016 / FR-019.) |
| Dashboard / KPI surface (placeholder) | `/app/dashboard` (003) | ⛔ | ✅ | ✅ | Reports and KPIs are in the Cashier-Forbidden Information catalogue (FR-015). Cashier route resolution returns the generic "this section is not available for your role" surface AND the route MUST be absent from cashier navigation, search, and quick-action results. |

**Cashier route enumeration test** (SC-003): A reviewer signed in as
cashier MUST be able to reach the four `✅` routes above plus `/sign-in`,
plus a "this section is not available for your role" surface for `🔒` and
`⛔` rows. They MUST NOT reach a `⛔` route via any of: navigation menu,
deep-link, route-restoration, refresh, search, quick-actions, tab restore.

---

## Section 3 — New 004 surfaces (operator-bound)

| Surface | Route / call | `cashier` | `manager` | `admin` | Notes |
|:--|:--|:--:|:--:|:--:|:--|
| Operator badge / role indicator | shell-region (003 slot) | ✅ | ✅ | ✅ | Always visible; renders this operator's own display name + role. Across roles, it shows different role badges, but all roles see *their own* indicator. |
| Operator settings surface | (none in 004) | — | — | — | Cashier-self-service PIN reset is OUT OF SCOPE (Hard Non-Implementation Boundaries). Future feature MAY add an operator-self-service surface; until then, no such surface exists. |
| **Cashier roster on `/sign-in`** | rendered surface | ✅ | ✅ | ✅ | Visible at sign-in time (before any operator session). The roster contents are constrained server-side to the terminal's branch; PII (email, phone) MUST NOT be rendered (FR-006). |
| **Takeover prompt** | modal (in `signingIn → takeoverPrompt → signedIn` flow) | ✅ | ✅ | ✅ | Triggered by `bridge.operator.signIn` returning `takeover_required`. Modal content is generic per FR-013 — no terminal name, no timestamp, no other-operator data. |
| **Stuck-shift list** | `/app/manager/stuck-shifts` | ⛔ | 👀 | 👀 | Manager / admin only. Filtered to the manager's authorised branches. Cashier MUST NOT reach this route AND MUST NOT see "this terminal has a stuck shift owned by another cashier" mentioned anywhere on cashier surfaces (FR-024(d)). |
| **Forced-close form** | within `/app/manager/stuck-shifts` | ⛔ | 👀 | 👀 | Reachable only via the stuck-shift list. Form fields: reason picker (fixed enum per FR-024(c)), optional free-text annotation. MUST NOT include any drawer-count entry, expected-total display, or variance display (FR-024(a) blind-close discipline). |
| **Cashier management surface** | `/app/manager/cashiers` | ⛔ | 👀 | 👀 | Lists cashiers on the manager's branch with PIN-management actions (reset, unlock per PR-5). MUST NOT show audit-log details on this surface; audit log is its own future feature (FR-029). |
| **Cashier PIN reset action** | `bridge.operator.resetCashierPin` | ⛔ | ✅ | ✅ | §A1-gated. Reachable from the cashier management surface. |
| **Cashier PIN unlock action** | `bridge.operator.unlockCashier` | ⛔ | ✅ | ✅ | §A1-gated. PR-3 release path b. |
| **Stuck-shift count badge** | nav-area badge widget (in NavRail / shell) | ⛔ | 👀 | 👀 | Displays the count of stuck shifts on the manager's branch. Cashier MUST NOT see this badge or its count. Badge MUST NOT render at 1024–1279 px icon-only viewport (badge text is invisible without the label context). S4 ships with a placeholder count of 0; live count wired in S5. |
| **Audit log surface** | (future feature) | ⛔ | — | — | FR-029 — manager-or-admin readable. 004 commits to "cashier ⛔" but does NOT design the manager/admin audit log surface itself; that's a future feature. |
| **List stuck shifts bridge call** | `bridge.operator.listStuckShifts` | ⛔ | ✅ | ✅ | T090 — manager/admin only. Cashier → `role_mismatch` refusal. Returns only display-safe fields (FR-013 / FR-032): `shift_id`, `cashier_display_name`, `terminal_label`, `opened_at`, `duration_minutes`. No financial data, no Clerk user ids, no branch/tenant ids. |
| **Forced-close audit-event detail** | within forced-close flow | ⛔ | 👀 | 👀 | T090 — manager/admin sees confirmation that the shift was force-closed (audit_event_id echoed). No financial data, no drawer count, no variance (FR-024 blind-close). |

---

## Section 4 — Cashier-Forbidden Information catalogue (FR-015 — normative restatement)

These are the *information items* (not routes) that MUST NOT be visible on
ANY cashier-reachable surface, regardless of how the cashier reaches it.
The bridge-API gate (`requireRole`) is the primary defence; the route
matrix above is the secondary navigation layer.

| Forbidden information item | Spec citation |
|:--|:--|
| Shift totals | FR-015 |
| Expected drawer cash | FR-015 |
| Expected change-fund | FR-015 |
| Declared cash count (this cashier's own MAY be partially reflected on their own close UI when the cashier types it; once submitted, even their own count MUST NOT be re-displayed on a cashier-reachable surface — FR-023) | FR-015 + FR-023 |
| Shortage | FR-015 |
| Overage | FR-015 |
| Variance | FR-015 |
| Reports (any kind) | FR-015 |
| KPIs (any kind) | FR-015 |
| Manager-review data | FR-015 |
| Audit log surfaces (the audit log itself; cashier-attributable audit *events* may be referenced indirectly, but the log is manager-only) | FR-015 + FR-029 |
| Admin / configuration surfaces | FR-015 |
| Other operators' shift data (any other cashier's shift, count, variance) | FR-024 |
| Stuck-shift list (the existence of stuck shifts on this or any terminal) | FR-024(d) |
| Stuck-shift forced-close audit-event details (the absent cashier MAY be informed *that* their shift was force-closed but MUST NOT see the financial details — Edge Cases) | FR-024 + Edge Cases |

The forbidden list is the **closed set** for cashier role within 004.
Future features MAY add to this list (e.g., 005-checkout-payments will
likely add several payment-related items); they MUST NOT remove items.

---

## Section 5 — Manager-visible information catalogue (FR-017 — informational)

Symmetrical to Section 4. These items ARE visible to manager (and admin)
on the appropriate manager surfaces:

- All cashier-visible information.
- The full Cashier-Forbidden Information catalogue from Section 4, scoped
  to the manager's authorised branches (FR-017).
- Stuck-shift list and forced-close action.
- Cashier management actions (PIN reset, PIN unlock per PR-5).

004 does NOT design the *layout* of every manager-visible surface (most
remain placeholders until later features); 004 only commits to *visibility*
and *reachability* for these items.

---

## Section 6 — Admin-visible information catalogue (FR-018 — informational)

- All manager-visible information, with branch scope expanded to all
  branches the admin is authorised for.
- Tenant-wide configuration surfaces (existence reserved by FR-018; layout
  out of scope for 004).

---

## Section 7 — How this matrix is enforced

### 7.1 Renderer (`<OperatorRouteGuard>`) — secondary UX defence

`<OperatorRouteGuard>` is a single React component that wraps every route
under `/app/*`. It reads the matrix above (compiled into a TS object that
mirrors the rows in this file) and the current `operatorSessionStore.role`,
and resolves to one of:

- The protected route's children (if the role is allowed).
- A generic "this section is not available for your role" surface (if the
  role is not allowed).
- A redirect to `/sign-in` (if no operator session exists).

**The route guard is UX-only.** It MUST NOT be relied on as the trust
boundary; AD-1 / FR-019 mandate bridge-surface enforcement as primary.

### 7.2 Bridge (`requireRole`) — primary trust-boundary defence

Every bridge-API handler in `src/main/operator/` calls `requireRole` at its
first instruction. The role catalogue mirrored in
`src/main/operator/role-enforcement.ts` SHOULD be derived from this
matrix (machine-generated or hand-mirrored — research §6's deferred decision).
The match between this matrix and the bridge-side enforcement is the
correctness invariant that the SC-003 walkthrough verifies.

### 7.3 Tests

- **Per-route tests** (Vitest + RTL): every `⛔` row gets a test that
  signs in as cashier, attempts to reach the route via every channel
  (navigation, deep-link, refresh), and asserts the generic "not
  available" surface renders without leakage.
- **Per-bridge-call tests** (Vitest, main-side): every `⛔` row whose
  surface is bridge-bound gets a test that calls the bridge with a
  cashier session and asserts `OperatorRefusal { category: 'role_mismatch' }`.
- **SC-003 walkthrough**: 20+ access paths attempted as cashier reach
  zero `⛔` rows. The list of paths is itself derived from this matrix.

---

## Section 8 — When this matrix changes

Adding, removing, or modifying a row is a **specification-level change**.
It MUST be performed by:

1. Updating this matrix in the relevant feature's spec / plan.
2. Re-running `/speckit-clarify` if the change introduces ambiguity (e.g.,
   adding a new role).
3. Re-running `/speckit-analyze` to verify cross-artifact consistency.
4. The implementation feature's PR includes the matrix change AND the
   corresponding test additions / removals.

The matrix MUST NOT drift between features — every feature that adds a
new surface adds a row here in the same PR. PR review gate refuses
features that add new operator-attributable surfaces without an explicit
matrix update (P12 / P16).

---

**End of role visibility matrix.** The matrix is the canonical truth that
both layers (route guard + bridge `requireRole`) compile against. Adding
a route or a bridge call without updating this matrix is a defect under
P12 + FR-019.
