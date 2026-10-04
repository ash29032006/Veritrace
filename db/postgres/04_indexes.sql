/* =========================================================
   VERITRACE
   File 04 : secondary indexes

   Kept apart from 01_schema.sql on purpose. Run the exposure
   query with EXPLAIN ANALYZE first, save the plan, THEN run
   this file and measure again. scripts/bench-indexes.ts does
   both automatically on a large generated dataset and writes
   docs/indexing-evidence.md.

   Primary keys already index their leading column, so
   batch_composition(parent_batch_id) and shipment_line
   (shipment_id) need nothing extra. Every index below serves a
   lookup that would otherwise be a sequential scan.
   ========================================================= */

/* 1. exposure hot path: batch -> every shipment line carrying it.
      shipment_line's PK leads with shipment_id, so it cannot help. */
CREATE INDEX IF NOT EXISTS idx_shipment_line_batch
    ON shipment_line (batch_id);

/* 2. recall cascade: batch -> every outlet holding it.
      inventory's PK leads with outlet_id. */
CREATE INDEX IF NOT EXISTS idx_inventory_batch
    ON inventory (batch_id);

/* 3. provenance (backward) traversal: child -> its inputs.
      The PK covers the forward direction (parent first). */
CREATE INDEX IF NOT EXISTS idx_bc_child
    ON batch_composition (child_batch_id);

/* 4. outlet history and the per-city aggregates */
CREATE INDEX IF NOT EXISTS idx_shipment_outlet
    ON shipment (outlet_id, shipment_date DESC);

/* 5. partial index: the dashboard only ever lists OPEN recalls,
      which are a small slice of all recalls */
CREATE INDEX IF NOT EXISTS idx_recall_open
    ON recall (initiated_at DESC)
    WHERE recall_status = 'OPEN';

/* 6. the audit log is read newest first, filtered by action */
CREATE INDEX IF NOT EXISTS idx_audit_performed_at
    ON audit_log (performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action
    ON audit_log (action, performed_at DESC);

/* 7. complaints per batch (requirement 6, query 7) */
CREATE INDEX IF NOT EXISTS idx_complaint_matched_batch
    ON complaint (matched_batch_id);

/* 8. full text search over batch descriptions. Used for the
      keyword baseline that the vector search is compared with. */
CREATE INDEX IF NOT EXISTS idx_batch_fts
    ON batch
    USING gin (to_tsvector('english', product_name || ' ' || COALESCE(description, '')));

/* 9. expired session sweep */
CREATE INDEX IF NOT EXISTS idx_session_expires
    ON app_session (expires_at);

ANALYZE;
