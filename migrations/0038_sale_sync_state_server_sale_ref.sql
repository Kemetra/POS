-- RT-15 S1 — persist the Backend-Core `saleRef` on `sale_sync_state`.
--
-- Adds ONE nullable column, `server_sale_ref`, to the 011-owned
-- `sale_sync_state` bookkeeping table (0034). Nothing else changes: same
-- columns, PK, FK, CHECKs and index as 0034. 008's enqueue-only
-- `sale_sync_outbox` is not touched.
--
-- ## Why this migration exists
--
-- Backend-Core `captureSale` answers 201 (first capture) or 200 (provenance
-- replay) with the `Sale` projection, whose required `saleRef` (= `sales.id`,
-- a UUID) is the stable server reference. The cashier return flow (RT-15
-- S2+) must call `POST /api/pos/v1/sales/{saleRef}/returns` and
-- `GET /api/pos/v1/sales/{saleRef}`, so the till has to remember that
-- reference once the sale syncs. Jira RT-15 decision D-f authorizes this
-- POS-local migration.
--
-- ## Nullability posture
--
-- NULL is the honest "not known" value, and it stays legal forever:
--   • every row written before this migration (sales synced pre-S1) — the
--     server never told us their saleRef, and there is no provenance lookup
--     (RT-15 plan: "Sales synced before S1 are not returnable at the till");
--   • rows that are still `pending` or are `dead_letter` (never captured);
--   • a `synced` row whose capture answer carried no readable `saleRef`
--     (a 409, or a malformed 200/201 body).
-- A NOT NULL column would need a DEFAULT that lies about all of those.
--
-- ## Shape CHECK
--
-- Mirrors the repo's GLOB/length CHECK convention (0014, 0015). A non-NULL
-- value must be the canonical 8-4-4-4-12 UUID text the contract declares
-- (`format: uuid`): exactly 36 characters, only hex digits and '-', with the
-- four '-' at positions 9, 14, 19 and 24 and nowhere else. Case is not
-- constrained, matching Backend-Core's own case-insensitive saleRef check.
-- The client validates before writing; this CHECK is the storage backstop.
-- SQLite tests an ADD COLUMN CHECK against existing rows; every existing row
-- gets NULL, which passes.
--
-- ## Re-apply protection
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`. Like 0027/0028/0035 this file is
-- not file-level idempotent; the runner (`src/main/db/migrate.ts`) records it
-- in `schema_migrations` and never re-runs it. It runs inside the runner's
-- default per-file transaction.

ALTER TABLE sale_sync_state ADD COLUMN server_sale_ref TEXT
  CHECK (
    server_sale_ref IS NULL
    OR (
      length(server_sale_ref) = 36
      AND server_sale_ref NOT GLOB '*[^0-9A-Fa-f-]*'
      AND substr(server_sale_ref, 9, 1) = '-'
      AND substr(server_sale_ref, 14, 1) = '-'
      AND substr(server_sale_ref, 19, 1) = '-'
      AND substr(server_sale_ref, 24, 1) = '-'
      AND length(replace(server_sale_ref, '-', '')) = 32
    )
  );
