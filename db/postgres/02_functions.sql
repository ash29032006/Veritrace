/* =========================================================
   VERITRACE
   File 02 : schema evolution, functions, triggers,
             stored procedures and views
   Run after 01_schema.sql. Safe to rerun.

   Error convention: business rules raise SQLSTATE P0001
   (plain RAISE EXCEPTION). The API maps P0001 to HTTP 409 so
   the database's refusal reaches the user verbatim.
   Role violations raise 42501 (insufficient_privilege).
   ========================================================= */


/* =========================================================
   A. SCHEMA EVOLUTION  (requirement 5: ALTER)
   The first version of complaint stored only the matched
   batch. Keeping the score lets a regulator judge how
   confident each match was, so the column is added here.
   ========================================================= */
ALTER TABLE complaint
    ADD COLUMN IF NOT EXISTS similarity_score NUMERIC(6,5);

ALTER TABLE complaint
    DROP CONSTRAINT IF EXISTS chk_complaint_score;

ALTER TABLE complaint
    ADD CONSTRAINT chk_complaint_score
    CHECK (similarity_score IS NULL
           OR (similarity_score >= 0 AND similarity_score <= 1));

/* a score without a match (or the reverse) is meaningless */
ALTER TABLE complaint
    DROP CONSTRAINT IF EXISTS chk_complaint_match_pair;

ALTER TABLE complaint
    ADD CONSTRAINT chk_complaint_match_pair
    CHECK ((matched_batch_id IS NULL) = (similarity_score IS NULL));


/* =========================================================
   B. HELPER FUNCTIONS
   ========================================================= */

/* Who is acting. The API sets this at the start of every
   write transaction with set_config('veritrace.user_id', ..,
   true), so triggers can attribute audit rows without the
   caller passing the user into every statement. */
CREATE OR REPLACE FUNCTION fn_current_user_id()
RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('veritrace.user_id', true), '')::BIGINT;
$$;


/* Units of a batch not yet consumed by another batch or
   shipped to an outlet. */
CREATE OR REPLACE FUNCTION fn_batch_available(p_batch_id BIGINT)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT b.quantity_produced
         - COALESCE((SELECT SUM(bc.quantity_used)
                       FROM batch_composition bc
                      WHERE bc.parent_batch_id = b.batch_id), 0)
         - COALESCE((SELECT SUM(sl.quantity)
                       FROM shipment_line sl
                      WHERE sl.batch_id = b.batch_id), 0)
      FROM batch b
     WHERE b.batch_id = p_batch_id;
$$;


/* Forward lineage: every batch that contains material from
   p_batch_id, with the fewest WENT_INTO hops to reach it.
   Includes p_batch_id itself at depth 0. This is the SQL twin
   of the Cypher pattern -[:WENT_INTO*0..]->. The CYCLE clause
   is a second line of defence; trg_guard_composition already
   rejects cycles on insert. */
CREATE OR REPLACE FUNCTION fn_downstream_batches(p_batch_id BIGINT)
RETURNS TABLE (batch_id BIGINT, hop_depth INT)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE downstream (batch_id, hop_depth) AS (
        SELECT p_batch_id, 0
        UNION ALL
        SELECT bc.child_batch_id, d.hop_depth + 1
          FROM batch_composition bc
          JOIN downstream d ON d.batch_id = bc.parent_batch_id
    ) CYCLE batch_id SET is_cycle USING path
    SELECT d.batch_id, MIN(d.hop_depth)::INT
      FROM downstream d
     WHERE NOT d.is_cycle
     GROUP BY d.batch_id;
$$;


/* Backward lineage: every batch that went into p_batch_id at
   any depth. Excludes p_batch_id (a batch is not its own
   input), matching the Cypher pattern -[:WENT_INTO*1..]->. */
CREATE OR REPLACE FUNCTION fn_upstream_batches(p_batch_id BIGINT)
RETURNS TABLE (batch_id BIGINT, hop_depth INT)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE upstream (batch_id, hop_depth) AS (
        SELECT bc.parent_batch_id, 1
          FROM batch_composition bc
         WHERE bc.child_batch_id = p_batch_id
        UNION ALL
        SELECT bc.parent_batch_id, u.hop_depth + 1
          FROM batch_composition bc
          JOIN upstream u ON u.batch_id = bc.child_batch_id
    ) CYCLE batch_id SET is_cycle USING path
    SELECT u.batch_id, MIN(u.hop_depth)::INT
      FROM upstream u
     WHERE NOT u.is_cycle
     GROUP BY u.batch_id;
$$;


/* =========================================================
   C. TRIGGERS
   ========================================================= */

/* ---------------------------------------------------------
   C1. Reject shipment lines for unsafe batches.
   The headline trigger: recall a batch, try to ship it, and
   the database itself refuses. Also refuses to ship more than
   is left. FOR NO KEY UPDATE waits for any in-flight recall
   on the same batch, so a shipment cannot slip through while
   a recall is committing.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_block_unsafe_shipment()
RETURNS TRIGGER AS $$
DECLARE
    v_batch     batch%ROWTYPE;
    v_available NUMERIC;
BEGIN
    SELECT * INTO v_batch
      FROM batch
     WHERE batch_id = NEW.batch_id
       FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RETURN NEW;  -- the foreign key reports the missing batch
    END IF;

    IF v_batch.status IN ('RECALLED', 'QUARANTINED') THEN
        RAISE EXCEPTION 'Batch % is % and cannot be shipped',
                        v_batch.batch_code, v_batch.status
              USING DETAIL = 'Rejected by trigger trg_block_unsafe_shipment on shipment_line.';
    END IF;

    v_available := fn_batch_available(NEW.batch_id);
    IF NEW.quantity > v_available THEN
        RAISE EXCEPTION 'Batch % has only % units left, cannot ship %',
                        v_batch.batch_code, v_available, NEW.quantity
              USING DETAIL = 'Rejected by trigger trg_block_unsafe_shipment on shipment_line.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_unsafe_shipment ON shipment_line;
CREATE TRIGGER trg_block_unsafe_shipment
    BEFORE INSERT ON shipment_line
    FOR EACH ROW EXECUTE FUNCTION fn_block_unsafe_shipment();


/* ---------------------------------------------------------
   C2. Guard composition: no unsafe inputs, no overuse,
   no time travel, no cycles.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_guard_composition()
RETURNS TRIGGER AS $$
DECLARE
    v_parent    batch%ROWTYPE;
    v_child     batch%ROWTYPE;
    v_available NUMERIC;
BEGIN
    SELECT * INTO v_parent FROM batch
     WHERE batch_id = NEW.parent_batch_id
       FOR NO KEY UPDATE;
    SELECT * INTO v_child FROM batch
     WHERE batch_id = NEW.child_batch_id;

    IF v_parent.batch_id IS NULL OR v_child.batch_id IS NULL THEN
        RETURN NEW;  -- the foreign keys report it
    END IF;

    IF v_parent.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Batch % is % and cannot be used as an input',
                        v_parent.batch_code, v_parent.status;
    END IF;

    IF v_child.status = 'RECALLED' THEN
        RAISE EXCEPTION 'Batch % is RECALLED and cannot receive new inputs',
                        v_child.batch_code;
    END IF;

    /* parent -> child closes a cycle exactly when the parent is
       already downstream of the child */
    IF EXISTS (SELECT 1
                 FROM fn_downstream_batches(NEW.child_batch_id) d
                WHERE d.batch_id = NEW.parent_batch_id) THEN
        RAISE EXCEPTION 'Using % as an input to % would create a lineage cycle',
                        v_parent.batch_code, v_child.batch_code;
    END IF;

    IF v_parent.manufacture_date > v_child.manufacture_date THEN
        RAISE EXCEPTION 'Input % (made %) is newer than % (made %)',
                        v_parent.batch_code, v_parent.manufacture_date,
                        v_child.batch_code,  v_child.manufacture_date;
    END IF;

    v_available := fn_batch_available(NEW.parent_batch_id);
    IF NEW.quantity_used > v_available THEN
        RAISE EXCEPTION 'Batch % has only % units left, cannot use %',
                        v_parent.batch_code, v_available, NEW.quantity_used;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_composition ON batch_composition;
CREATE TRIGGER trg_guard_composition
    BEFORE INSERT ON batch_composition
    FOR EACH ROW EXECUTE FUNCTION fn_guard_composition();


/* ---------------------------------------------------------
   C3. Provenance is permanent.
   Composition, recall scope and shipment lines are never
   edited in place. One function, the message passed as a
   trigger argument.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_reject_change()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% on % is not permitted: %',
                    TG_OP, TG_TABLE_NAME, TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_composition_immutable ON batch_composition;
CREATE TRIGGER trg_composition_immutable
    BEFORE UPDATE OR DELETE ON batch_composition
    FOR EACH ROW EXECUTE FUNCTION fn_reject_change('lineage records are permanent');

DROP TRIGGER IF EXISTS trg_recall_batch_immutable ON recall_batch;
CREATE TRIGGER trg_recall_batch_immutable
    BEFORE UPDATE OR DELETE ON recall_batch
    FOR EACH ROW EXECUTE FUNCTION fn_reject_change('the scope of a recall is permanent');

DROP TRIGGER IF EXISTS trg_shipment_line_no_update ON shipment_line;
CREATE TRIGGER trg_shipment_line_no_update
    BEFORE UPDATE ON shipment_line
    FOR EACH ROW EXECUTE FUNCTION fn_reject_change('cancel the shipment and create a new one');


/* ---------------------------------------------------------
   C4. Inventory follows shipments.
   Receiving: every shipment line adds stock at the outlet.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_inventory_receive()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO inventory (outlet_id, batch_id, quantity_on_hand)
    SELECT s.outlet_id, NEW.batch_id, NEW.quantity
      FROM shipment s
     WHERE s.shipment_id = NEW.shipment_id
    ON CONFLICT (outlet_id, batch_id)
    DO UPDATE SET quantity_on_hand = inventory.quantity_on_hand
                                   + EXCLUDED.quantity_on_hand;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_receive ON shipment_line;
CREATE TRIGGER trg_inventory_receive
    AFTER INSERT ON shipment_line
    FOR EACH ROW EXECUTE FUNCTION fn_inventory_receive();


/* Releasing: give stock back when a line is cancelled.
   Refused if the batch is recalled (the shipment is evidence
   of exposure) or if the outlet has already sold part of it. */
CREATE OR REPLACE FUNCTION fn_release_stock(
    p_outlet_id BIGINT,
    p_batch_id  BIGINT,
    p_quantity  NUMERIC
)
RETURNS VOID AS $$
DECLARE
    v_code    VARCHAR(40);
    v_status  VARCHAR(20);
    v_on_hand NUMERIC;
BEGIN
    SELECT batch_code, status INTO v_code, v_status
      FROM batch WHERE batch_id = p_batch_id;

    IF v_status = 'RECALLED' THEN
        RAISE EXCEPTION 'Batch % is RECALLED; its shipments are evidence of exposure and cannot be cancelled',
                        v_code;
    END IF;

    SELECT quantity_on_hand INTO v_on_hand
      FROM inventory
     WHERE outlet_id = p_outlet_id AND batch_id = p_batch_id
       FOR UPDATE;

    IF COALESCE(v_on_hand, 0) < p_quantity THEN
        RAISE EXCEPTION 'Outlet holds only % of the % units of % shipped; the rest is already sold',
                        COALESCE(v_on_hand, 0), p_quantity, v_code;
    END IF;

    UPDATE inventory
       SET quantity_on_hand = quantity_on_hand - p_quantity
     WHERE outlet_id = p_outlet_id AND batch_id = p_batch_id;
END;
$$ LANGUAGE plpgsql;


/* Cancelling a whole shipment (the DELETE feature).
   Runs before the header row goes; the lines are then removed
   by ON DELETE CASCADE. */
CREATE OR REPLACE FUNCTION fn_shipment_cancel()
RETURNS TRIGGER AS $$
DECLARE
    v_line    RECORD;
    v_summary TEXT;
BEGIN
    FOR v_line IN
        SELECT batch_id, quantity FROM shipment_line
         WHERE shipment_id = OLD.shipment_id
    LOOP
        PERFORM fn_release_stock(OLD.outlet_id, v_line.batch_id, v_line.quantity);
    END LOOP;

    SELECT string_agg(format('%s x %s', b.batch_code, sl.quantity), ', ' ORDER BY b.batch_code)
      INTO v_summary
      FROM shipment_line sl JOIN batch b ON b.batch_id = sl.batch_id
     WHERE sl.shipment_id = OLD.shipment_id;

    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    VALUES ('SHIPMENT_CANCELLED', 'shipment', OLD.shipment_id, fn_current_user_id(),
            format('Shipment #%s to outlet #%s cancelled. Lines: %s',
                   OLD.shipment_id, OLD.outlet_id, COALESCE(v_summary, 'none')));
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shipment_cancel ON shipment;
CREATE TRIGGER trg_shipment_cancel
    BEFORE DELETE ON shipment
    FOR EACH ROW EXECUTE FUNCTION fn_shipment_cancel();


/* Deleting a single line directly (not via the header).
   When the header is already gone this is the cascade, and
   fn_shipment_cancel has released the stock. */
CREATE OR REPLACE FUNCTION fn_shipment_line_delete()
RETURNS TRIGGER AS $$
DECLARE
    v_outlet BIGINT;
BEGIN
    SELECT outlet_id INTO v_outlet FROM shipment WHERE shipment_id = OLD.shipment_id;
    IF v_outlet IS NOT NULL THEN
        PERFORM fn_release_stock(v_outlet, OLD.batch_id, OLD.quantity);
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shipment_line_delete ON shipment_line;
CREATE TRIGGER trg_shipment_line_delete
    BEFORE DELETE ON shipment_line
    FOR EACH ROW EXECUTE FUNCTION fn_shipment_line_delete();


/* ---------------------------------------------------------
   C5. Batch status rules.
   RECALLED is terminal and can only be set by
   sp_initiate_recall, which raises a transaction-local flag.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_batch_status_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'RECALLED' AND NEW.status <> 'RECALLED' THEN
        RAISE EXCEPTION 'Batch % is RECALLED; recall is terminal', OLD.batch_code;
    END IF;

    IF NEW.status = 'RECALLED' AND OLD.status <> 'RECALLED'
       AND COALESCE(current_setting('veritrace.recall_in_progress', true), '') <> 'on' THEN
        RAISE EXCEPTION 'Batch % can only be recalled through sp_initiate_recall', OLD.batch_code;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batch_status_guard ON batch;
CREATE TRIGGER trg_batch_status_guard
    BEFORE UPDATE OF status ON batch
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION fn_batch_status_guard();


/* ---------------------------------------------------------
   C6. Audit trail written by the database itself, in the same
   transaction as the change it describes.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_audit_trail()
RETURNS TRIGGER AS $$
DECLARE
    v_parent VARCHAR(40);
    v_child  VARCHAR(40);
BEGIN
    IF TG_TABLE_NAME = 'batch' AND TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
        VALUES ('BATCH_CREATED', 'batch', NEW.batch_id, fn_current_user_id(),
                format('%s (%s), %s units, made %s',
                       NEW.batch_code, NEW.product_name,
                       NEW.quantity_produced, NEW.manufacture_date));

    ELSIF TG_TABLE_NAME = 'batch' AND TG_OP = 'UPDATE' THEN
        /* recall writes its own, richer BATCH_RECALLED rows */
        IF NEW.status <> 'RECALLED' THEN
            INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
            VALUES ('BATCH_STATUS_CHANGED', 'batch', NEW.batch_id, fn_current_user_id(),
                    format('%s: %s -> %s', NEW.batch_code, OLD.status, NEW.status));
        END IF;

    ELSIF TG_TABLE_NAME = 'batch_composition' THEN
        SELECT batch_code INTO v_parent FROM batch WHERE batch_id = NEW.parent_batch_id;
        SELECT batch_code INTO v_child  FROM batch WHERE batch_id = NEW.child_batch_id;
        INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
        VALUES ('COMPOSITION_RECORDED', 'batch', NEW.child_batch_id, fn_current_user_id(),
                format('%s units of %s went into %s', NEW.quantity_used, v_parent, v_child));

    ELSIF TG_TABLE_NAME = 'shipment' THEN
        INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
        VALUES ('SHIPMENT_CREATED', 'shipment', NEW.shipment_id, fn_current_user_id(),
                format('Shipment #%s to outlet #%s dated %s',
                       NEW.shipment_id, NEW.outlet_id, NEW.shipment_date));

    ELSIF TG_TABLE_NAME = 'complaint' THEN
        INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
        VALUES ('COMPLAINT_RECEIVED', 'complaint', NEW.complaint_id, fn_current_user_id(),
                left(NEW.complaint_text, 160));
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_batch_insert ON batch;
CREATE TRIGGER trg_audit_batch_insert
    AFTER INSERT ON batch
    FOR EACH ROW EXECUTE FUNCTION fn_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_batch_status ON batch;
CREATE TRIGGER trg_audit_batch_status
    AFTER UPDATE OF status ON batch
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION fn_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_composition ON batch_composition;
CREATE TRIGGER trg_audit_composition
    AFTER INSERT ON batch_composition
    FOR EACH ROW EXECUTE FUNCTION fn_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_shipment ON shipment;
CREATE TRIGGER trg_audit_shipment
    AFTER INSERT ON shipment
    FOR EACH ROW EXECUTE FUNCTION fn_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_complaint ON complaint;
CREATE TRIGGER trg_audit_complaint
    AFTER INSERT ON complaint
    FOR EACH ROW EXECUTE FUNCTION fn_audit_trail();


/* ---------------------------------------------------------
   C7. The audit log is append only.
   The single permitted UPDATE is the one Postgres itself
   issues for ON DELETE SET NULL when a user account is
   removed: performed_by becomes NULL and nothing else moves.
   --------------------------------------------------------- */
CREATE OR REPLACE FUNCTION fn_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.performed_by IS NULL
       AND OLD.performed_by IS NOT NULL
       AND (NEW.log_id, NEW.action, NEW.entity_name, NEW.entity_id,
            NEW.performed_at, NEW.details)
           IS NOT DISTINCT FROM
           (OLD.log_id, OLD.action, OLD.entity_name, OLD.entity_id,
            OLD.performed_at, OLD.details)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'audit_log is append only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_log;
CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


/* =========================================================
   D. STORED PROCEDURES
   ========================================================= */

/* ---------------------------------------------------------
   D1. sp_initiate_recall : the recall cascade.

   The affected set comes from Neo4j, resolved by the API
   (POST /api/recalls). A procedure cannot query Neo4j, so the
   cross-database boundary is the API, not this procedure.
   Everything below is Postgres work and runs inside the
   caller's transaction: it all commits or none of it does.

     1. check the caller is a MANUFACTURER
     2. lock the source batch, refuse if already recalled
     3. refuse if the graph missed any downstream batch
     4. INSERT recall + recall_batch (the persisted scope)
     5. UPDATE batch status for the whole scope
     6. UPDATE inventory to QUARANTINED wherever stock remains
     7. INSERT audit rows, one per action
   --------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE sp_initiate_recall(
    p_batch_id           BIGINT,
    p_reason             TEXT,
    p_user_id            BIGINT,
    p_affected_batch_ids BIGINT[],
    p_hop_depths         INT[],
    INOUT p_recall_id    BIGINT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_role         VARCHAR(20);
    v_source       batch%ROWTYPE;
    v_prior        BIGINT;
    v_missing      TEXT;
    v_batch_rows   INT;
    v_scope_size   INT;
    v_inv_rows     INT;
    v_outlets      INT;
    v_units        NUMERIC;
BEGIN
    /* 1. role, checked in the database as well as the API */
    SELECT role INTO v_role FROM app_user WHERE user_id = p_user_id;
    IF v_role IS DISTINCT FROM 'MANUFACTURER' THEN
        RAISE EXCEPTION 'Only a MANUFACTURER can initiate a recall'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    p_affected_batch_ids := COALESCE(p_affected_batch_ids, '{}');
    p_hop_depths         := COALESCE(p_hop_depths, '{}');
    IF cardinality(p_affected_batch_ids) <> cardinality(p_hop_depths) THEN
        RAISE EXCEPTION 'Affected batch ids (%) and hop depths (%) differ in length',
                        cardinality(p_affected_batch_ids), cardinality(p_hop_depths)
              USING ERRCODE = 'invalid_parameter_value';
    END IF;

    /* 2. source batch */
    SELECT * INTO v_source FROM batch
     WHERE batch_id = p_batch_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Batch % does not exist', p_batch_id
              USING ERRCODE = 'no_data_found';
    END IF;
    IF v_source.status = 'RECALLED' THEN
        SELECT rb.recall_id INTO v_prior
          FROM recall_batch rb
         WHERE rb.batch_id = p_batch_id
         ORDER BY rb.recall_id DESC
         LIMIT 1;
        RAISE EXCEPTION 'Batch % is already recalled under recall #%',
                        v_source.batch_code, v_prior;
    END IF;

    /* 3. stale graph guard. Postgres is the source of truth: if
       the projection missed a downstream batch, under-recalling
       is the dangerous failure, so refuse rather than continue. */
    SELECT string_agg(b.batch_code, ', ' ORDER BY b.batch_code)
      INTO v_missing
      FROM fn_downstream_batches(p_batch_id) d
      JOIN batch b ON b.batch_id = d.batch_id
     WHERE d.batch_id <> p_batch_id
       AND NOT (d.batch_id = ANY (p_affected_batch_ids));
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Graph projection is stale: downstream batches % are missing from the affected set',
                        v_missing
              USING HINT = 'Run npm run graph:resync, then retry the recall.';
    END IF;

    /* 4. the recall and its persisted scope */
    INSERT INTO recall (batch_id, reason, initiated_by)
    VALUES (p_batch_id, btrim(p_reason), p_user_id)
    RETURNING recall_id INTO p_recall_id;

    INSERT INTO recall_batch (recall_id, batch_id, hop_depth)
    SELECT p_recall_id, a.batch_id, MIN(a.hop_depth)
      FROM (SELECT p_batch_id AS batch_id, 0 AS hop_depth
            UNION ALL
            SELECT u.batch_id, u.hop_depth
              FROM unnest(p_affected_batch_ids, p_hop_depths) AS u(batch_id, hop_depth)
           ) a
     GROUP BY a.batch_id;
    GET DIAGNOSTICS v_scope_size = ROW_COUNT;

    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    VALUES ('RECALL_INITIATED', 'recall', p_recall_id, p_user_id,
            format('Recall #%s on %s (%s). Reason: %s',
                   p_recall_id, v_source.batch_code, v_source.product_name, btrim(p_reason)));

    /* 5. batch status for the whole scope */
    PERFORM set_config('veritrace.recall_in_progress', 'on', true);

    UPDATE batch b
       SET status = 'RECALLED'
      FROM recall_batch rb
     WHERE rb.recall_id = p_recall_id
       AND b.batch_id   = rb.batch_id
       AND b.status    <> 'RECALLED';
    GET DIAGNOSTICS v_batch_rows = ROW_COUNT;

    PERFORM set_config('veritrace.recall_in_progress', 'off', true);

    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    SELECT 'BATCH_RECALLED', 'batch', rb.batch_id, p_user_id,
           format('%s recalled under recall #%s, %s hop(s) below %s',
                  b.batch_code, p_recall_id, rb.hop_depth, v_source.batch_code)
      FROM recall_batch rb
      JOIN batch b ON b.batch_id = rb.batch_id
     WHERE rb.recall_id = p_recall_id
     ORDER BY rb.hop_depth, b.batch_code;

    /* 6. quarantine every unit still sitting at an outlet */
    WITH quarantined AS (
        UPDATE inventory i
           SET stock_status = 'QUARANTINED'
          FROM recall_batch rb
         WHERE rb.recall_id      = p_recall_id
           AND i.batch_id        = rb.batch_id
           AND i.quantity_on_hand > 0
           AND i.stock_status    <> 'QUARANTINED'
        RETURNING i.outlet_id, i.quantity_on_hand
    )
    SELECT COUNT(*), COUNT(DISTINCT outlet_id), COALESCE(SUM(quantity_on_hand), 0)
      INTO v_inv_rows, v_outlets, v_units
      FROM quarantined;

    /* 7. summary */
    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    VALUES ('INVENTORY_QUARANTINED', 'recall', p_recall_id, p_user_id,
            format('Recall #%s: %s batches in scope (%s newly recalled), %s inventory rows quarantined across %s outlets, %s units held',
                   p_recall_id, v_scope_size, v_batch_rows, v_inv_rows, v_outlets, v_units));
END;
$$;


/* ---------------------------------------------------------
   D2. sp_close_recall : a REGULATOR closes a recall once no
   affected stock is left available anywhere.
   --------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE sp_close_recall(
    p_recall_id BIGINT,
    p_user_id   BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_role   VARCHAR(20);
    v_recall recall%ROWTYPE;
    v_loose  INT;
BEGIN
    SELECT role INTO v_role FROM app_user WHERE user_id = p_user_id;
    IF v_role IS DISTINCT FROM 'REGULATOR' THEN
        RAISE EXCEPTION 'Only a REGULATOR can close a recall'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_recall FROM recall WHERE recall_id = p_recall_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Recall % does not exist', p_recall_id
              USING ERRCODE = 'no_data_found';
    END IF;
    IF v_recall.recall_status = 'CLOSED' THEN
        RAISE EXCEPTION 'Recall #% is already closed', p_recall_id;
    END IF;

    SELECT COUNT(*) INTO v_loose
      FROM recall_batch rb
      JOIN inventory i ON i.batch_id = rb.batch_id
     WHERE rb.recall_id = p_recall_id
       AND i.quantity_on_hand > 0
       AND i.stock_status = 'AVAILABLE';
    IF v_loose > 0 THEN
        RAISE EXCEPTION 'Recall #% still has % inventory rows available for sale', p_recall_id, v_loose;
    END IF;

    UPDATE recall
       SET recall_status = 'CLOSED',
           closed_by     = p_user_id,
           closed_at     = now()
     WHERE recall_id = p_recall_id;

    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    VALUES ('RECALL_CLOSED', 'recall', p_recall_id, p_user_id,
            format('Recall #%s closed after %s',
                   p_recall_id, date_trunc('minute', now() - v_recall.initiated_at)));
END;
$$;


/* =========================================================
   E. VIEWS
   ========================================================= */

/* Stock position of every batch: produced, consumed into
   other batches, shipped, and what is left. */
CREATE OR REPLACE VIEW v_batch_stock AS
SELECT b.batch_id,
       b.batch_code,
       b.product_name,
       b.manufacture_date,
       b.status,
       b.quantity_produced,
       COALESCE(used.qty, 0)                                   AS quantity_consumed,
       COALESCE(shipped.qty, 0)                                AS quantity_shipped,
       b.quantity_produced - COALESCE(used.qty, 0)
                           - COALESCE(shipped.qty, 0)          AS quantity_available,
       (SELECT COUNT(*) FROM batch_composition bc
         WHERE bc.child_batch_id = b.batch_id)                 AS input_count,
       (SELECT COUNT(*) FROM batch_composition bc
         WHERE bc.parent_batch_id = b.batch_id)                AS output_count
  FROM batch b
  LEFT JOIN (SELECT parent_batch_id, SUM(quantity_used) AS qty
               FROM batch_composition GROUP BY parent_batch_id) used
         ON used.parent_batch_id = b.batch_id
  LEFT JOIN (SELECT batch_id, SUM(quantity) AS qty
               FROM shipment_line GROUP BY batch_id) shipped
         ON shipped.batch_id = b.batch_id;


/* v_outlet_exposure: affected units per outlet per OPEN recall.
   Shipped and held quantities are aggregated separately before
   joining, otherwise each inventory row would be counted once
   per shipment line. */
CREATE OR REPLACE VIEW v_outlet_exposure AS
WITH shipped AS (
    SELECT rb.recall_id,
           s.outlet_id,
           COUNT(DISTINCT sl.batch_id)  AS affected_batches,
           MIN(rb.hop_depth)            AS min_hop_depth,
           MAX(rb.hop_depth)            AS max_hop_depth,
           SUM(sl.quantity)             AS units_shipped
      FROM recall_batch  rb
      JOIN shipment_line sl ON sl.batch_id   = rb.batch_id
      JOIN shipment      s  ON s.shipment_id = sl.shipment_id
     GROUP BY rb.recall_id, s.outlet_id
),
held AS (
    SELECT rb.recall_id,
           i.outlet_id,
           SUM(i.quantity_on_hand) AS units_quarantined
      FROM recall_batch rb
      JOIN inventory    i ON i.batch_id = rb.batch_id
     WHERE i.stock_status = 'QUARANTINED'
     GROUP BY rb.recall_id, i.outlet_id
)
SELECT r.recall_id,
       r.batch_id                         AS source_batch_id,
       b.batch_code                       AS source_batch_code,
       r.initiated_at,
       o.outlet_id,
       o.outlet_name,
       o.city,
       sh.affected_batches,
       sh.min_hop_depth,
       sh.max_hop_depth,
       sh.units_shipped,
       COALESCE(h.units_quarantined, 0)   AS units_quarantined
  FROM recall  r
  JOIN batch   b  ON b.batch_id   = r.batch_id
  JOIN shipped sh ON sh.recall_id = r.recall_id
  JOIN outlet  o  ON o.outlet_id  = sh.outlet_id
  LEFT JOIN held h ON h.recall_id = sh.recall_id
                  AND h.outlet_id = sh.outlet_id
 WHERE r.recall_status = 'OPEN';
