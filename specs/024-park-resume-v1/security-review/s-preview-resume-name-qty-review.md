# §A4 — P8 Bridge-Security Review: product name and quantity on `cart.previewResume`

| Field | Value |
| :--- | :--- |
| Feature | 024 park/resume v1 — PK-2 bridge, additive fields (RT-610) |
| Decision | RT-471 OD-1, owner-approved 2026-10-17 |
| Gate | §A4, P8 Electron security boundary (response fields added to an existing channel) |
| Bridge surface | `cart.parked.previewResume` on channel `cart:previewResume` (PK-2, RT-440). No new channel, no new request field. |
| Review type | Post-implementation walk by the implementing agent (Claude Code), 2026-10-17 |
| Verdict | **Controls observed in code and covered by tests.** Two display fields added to a read response: the product name snapshot and the line quantity. No new input, no write, no PII, no secret. |

## What changed

Each `changes[]` entry and each `unavailable[]` entry of a `preview` response now carries `display_name` and `quantity` beside `line_id`:

```
changes:     [{ line_id, display_name, quantity, old_unit_minor, new_unit_minor }]
unavailable: [{ line_id, display_name, quantity }]
```

`unavailable` was a list of line ids; it is now a list of objects with the same `line_id` first. The PK-3 UI (RT-445) is its first renderer consumer, so no renderer code changes with it.

## Required controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| 1 | Values read in main, never from the renderer | `asPreviewReq` still rebuilds the request as `{ cart_id }` only (`src/main/ipc/cart-park.ts`). The name and quantity come from `parkedLines(cart_id)`, which now also selects `display_name` from `cart_lines` (`src/main/cart/park/park-store.ts`), and are copied into the diff in `computeResumeDiff` (`src/main/cart/park/resume-diff.ts`). Test: *names each changed and unavailable line with its stored name and quantity* compares against the stored `cart_lines` row. |
| 2 | No schema change | `cart_lines.display_name` (`TEXT NOT NULL`, the add-time snapshot, FR-013) and `cart_lines.quantity` exist since `migrations/0010_cart_lines.sql`. No migration added. |
| 3 | Data class: product name and quantity only | `display_name` is the catalogue product name as snapshotted when the line was added; `quantity` is a positive integer. Neither is personal data. The response does not add `item_ref`, the line note, a line or sale total, the owner, the session or the park label. Test: the response's top-level keys are unchanged and the serialised preview contains no `item_ref`. The same name and quantity already reach this renderer through `cart.snapshot` (023 §A4 control 6) for the operator's own active cart. |
| 4 | Ownership and tenant scope unchanged | `previewResume` still runs `admit` (session, lock, terminal) and `ownParkedCart` (`isOwnCart`: tenant, branch, terminal and owning operator) before any line is read. A manager or admin still cannot preview another operator's parked sale. The existing `wrong_owner` / `not_parked` tests stay green. |
| 5 | `diff_token` semantics unchanged | `tokenOf` still digests `[line_id, old_unit_minor, new_unit_minor]` per change and the unavailable **line ids**. The name and quantity are not in it. Test: *keeps the diff_token a digest of line ids and prices only* recomputes the pre-RT-610 digest and matches it. `cart.resume` recomputes the same token and acceptance rule (`isAcceptedDiff`), unchanged. |
| 6 | Refusals and idempotency unchanged | No new refusal reason. `catalogue_unavailable`, `not_parked`, `wrong_owner` behave as before (existing tests). `previewResume` stays read only and takes no idempotency key; `cart.resume`'s key and replay are untouched. |
| 7 | No logging of the new fields | `previewResume` logs nothing. Test: no log line written during the preview contains the product name. |
| 8 | Sender-origin and sale-boundary guards | The channel is still registered on `guardedIpcMain` (`src/main/index.ts`, `registerCartParkHandlers(guardedIpcMain, …)`), behind the lock, recovery-mode and sale-boundary guards (`tests/unit/main/ipc/cart-park-ipc.test.ts`). |
| 9 | Typed on both ends | `ResumeLineRef`, `ResumePriceChange` and `ResumeUnavailableLine` live in `src/shared/cart/park-types.ts`, shared by main, the IPC registrar, the preload and `bridge-api.ts`. The preload passes the response through unchanged, as for every park call. |

## Residuals

- `display_name` is the add-time snapshot. If the catalogue renamed the product since, the review shows the name the cashier saw when adding the line, as the parked sale itself does. Not a security concern.
- The `unavailable` shape change (ids → objects) has no renderer consumer on `main` today; RT-445 builds against the new shape.
