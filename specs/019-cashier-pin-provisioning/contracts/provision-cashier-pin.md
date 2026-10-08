# Contract: `operator.provisionCashierPin`

Main-process action exposed via the typed preload bridge (Constitution III: renderer reaches main only through `bridge-api.ts`). Sibling to `operator.resetCashierPin`. **New IPC channel — owes §A4 bridge-security review (P8).**

## Request

```ts
interface ProvisionCashierPinRequest {
  /** Client-generated UUID v4 — P5 idempotency key. */
  event_id: string;
  /**
   * The cashier to provision, by the roster `id` the renderer already holds
   * (the provider subject / session `operator_id`, as in reset and unlock).
   * Main resolves the PROVIDER-NEUTRAL user_id (028 §16 = DP-2 users.id)
   * from the manager roster entry with that `id`; user_id never crosses the
   * bridge. (FR-2 / FR-3; amended by RT-235.)
   */
  target_cashier_id: string;
  /** Plaintext 4–6 digit PIN — consumed by the main-process verifier, never persisted in plaintext, never logged, never returned. */
  initial_pin: string;
}
```

> **RT-235 amendment (2026-10-06):** the request originally carried `target_user_id`, but the renderer-facing roster deliberately carries no `user_id` (Constitution VII, RT-116), so no UI could ever call the action. Provision now takes the same `target_cashier_id` as reset and unlock (the roster `id`); the handler looks up that manager-roster entry and reads its `user_id` main-side. A `target_cashier_id` that is not on the roster, or whose entry carries no `user_id`, is `not_ready` (FR-11). The row is still born keyed on `user_id`. No new IPC channel, no new field crosses the bridge upward.

## Response

```ts
type ProvisionCashierPinResponse =
  | { kind: 'pin_provisioned'; audit_event_id: string }   // success; echoes event_id
  | OperatorRefusal;                                       // see refusal categories
```

## Refusal categories (no row created)

| Category | Trigger |
|:--|:--|
| `role_mismatch` | active operator is not manager/admin (FR-4) |
| `not_ready` | the cashier is not on the roster, or the rostered cashier has no provider-neutral `user_id` yet (FR-11) — **never** falls back to a clerk-keyed row |
| `state_invalid` | a record already exists for this cashier-on-terminal (incl. a legacy clerk-keyed row) — directs to reset (FR-5) |
| `invalid_input` | terminal not paired, malformed `event_id`, or invalid PIN shape — rejected value never echoed |

## Invariants (verified before any success)

1. PIN/hash/salt never cross the bridge upward, never logged, never in the response (FR-6 / P7).
2. Scope (`tenant/branch/terminal`) sourced from pairing state, never the renderer (FR-9 / Constitution VII).
3. Role-gate is the first executable check (FR-4), mirroring `resetCashierPin`.
4. Success implies a durably sealed row + a committed `cashier.pin.provisioned` audit event in one transaction (NFR-1 / P18).
5. The row is created keyed on `user_id` (born-neutral, FR-2) with `cashier_clerk_user_id` also populated for the bridge window.

## Bridge surface

```ts
// bridge-api.ts (operator namespace)
provisionCashierPin(req: ProvisionCashierPinRequest): Promise<ProvisionCashierPinResponse>;
// channel: 'operator.provisionCashierPin'
```

## Roster dependency (held)

The handler reads the cashier's `user_id` from the cached/fetched branch roster (`PosRosterCashierEntry.user_id`) — a **held DP-2 upstream field** (017 OUTBOX). Until DP-2 ships it, `roster-handler.ts` carries no `user_id`, so every provisioning attempt returns `not_ready` — the truthful state.
