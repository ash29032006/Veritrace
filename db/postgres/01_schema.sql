/* =========================================================
   VERITRACE : Batch Provenance and Recall Cascade Engine
   File 01 : relational schema (DDL)
   Target   : PostgreSQL 16 or later

   Run order:
     01_schema.sql     tables, keys, CHECK constraints
     02_functions.sql  ALTER, functions, triggers, procedures, views
     (seed data)       npm run db:seed
     04_indexes.sql    secondary indexes, created AFTER the
                       "before" EXPLAIN ANALYZE has been saved
   03_queries.sql is the requirement 6 query set; it changes nothing.

   Vectors are not stored here. Complaint and batch embeddings
   live in Qdrant, keyed by complaint_id and batch_id.
   ========================================================= */

/* ---------------------------------------------------------
   Drop in reverse dependency order so the file is rerunnable
   while developing.
   --------------------------------------------------------- */
DROP VIEW  IF EXISTS v_outlet_exposure  CASCADE;
DROP VIEW  IF EXISTS v_batch_stock      CASCADE;
DROP TABLE IF EXISTS complaint          CASCADE;
DROP TABLE IF EXISTS audit_log          CASCADE;
DROP TABLE IF EXISTS recall_batch       CASCADE;
DROP TABLE IF EXISTS recall             CASCADE;
DROP TABLE IF EXISTS inventory          CASCADE;
DROP TABLE IF EXISTS shipment_line      CASCADE;
DROP TABLE IF EXISTS shipment           CASCADE;
DROP TABLE IF EXISTS batch_composition  CASCADE;
DROP TABLE IF EXISTS outlet             CASCADE;
DROP TABLE IF EXISTS batch              CASCADE;
DROP TABLE IF EXISTS app_session        CASCADE;
DROP TABLE IF EXISTS app_user           CASCADE;


/* =========================================================
   1. app_user
   Two roles are required by the project brief.
   Passwords are stored only as a bcrypt hash.
   ========================================================= */
CREATE TABLE app_user (
    user_id        BIGSERIAL    PRIMARY KEY,
    username       VARCHAR(50)  NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(20)  NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_user_role
        CHECK (role IN ('MANUFACTURER', 'REGULATOR')),
    /* a bcrypt hash always starts $2a$, $2b$ or $2y$ and is 60 chars */
    CONSTRAINT chk_user_password_is_bcrypt
        CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$')
);


/* =========================================================
   2. app_session
   Server side session store. The cookie carries a random
   token; only its HMAC is stored, so a leaked table cannot
   be replayed as a cookie.
   ========================================================= */
CREATE TABLE app_session (
    token_hash   CHAR(64)     PRIMARY KEY,
    user_id      BIGINT       NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ  NOT NULL,

    CONSTRAINT fk_session_user
        FOREIGN KEY (user_id) REFERENCES app_user(user_id)
        ON DELETE CASCADE,
    CONSTRAINT chk_session_window
        CHECK (expires_at > created_at)
);


/* =========================================================
   3. batch
   A raw material lot is simply a batch with no rows in
   batch_composition pointing into it. No separate table.
   description is the product text that gets embedded for
   complaint matching.
   ========================================================= */
CREATE TABLE batch (
    batch_id           BIGSERIAL     PRIMARY KEY,
    batch_code         VARCHAR(40)   NOT NULL UNIQUE,
    product_name       VARCHAR(120)  NOT NULL,
    description        VARCHAR(400),
    manufacture_date   DATE          NOT NULL,
    quantity_produced  NUMERIC(12,2) NOT NULL,
    status             VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT chk_batch_status
        CHECK (status IN ('ACTIVE', 'QUARANTINED', 'RECALLED')),
    CONSTRAINT chk_batch_qty
        CHECK (quantity_produced > 0),
    CONSTRAINT chk_batch_date
        CHECK (manufacture_date <= CURRENT_DATE),
    CONSTRAINT chk_batch_code_format
        CHECK (batch_code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$')
);


/* =========================================================
   4. batch_composition
   The self referencing many to many relationship.
   parent_batch_id went INTO child_batch_id.
   This is the table the whole project exists for.
   Longer cycles (A -> B -> A) are rejected by a trigger in
   02_functions.sql, since a CHECK cannot see other rows.
   ========================================================= */
CREATE TABLE batch_composition (
    parent_batch_id  BIGINT        NOT NULL,
    child_batch_id   BIGINT        NOT NULL,
    quantity_used    NUMERIC(12,2) NOT NULL,

    CONSTRAINT pk_batch_composition
        PRIMARY KEY (parent_batch_id, child_batch_id),

    CONSTRAINT fk_bc_parent
        FOREIGN KEY (parent_batch_id) REFERENCES batch(batch_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_bc_child
        FOREIGN KEY (child_batch_id)  REFERENCES batch(batch_id)
        ON DELETE RESTRICT,

    /* a batch cannot be an input to itself */
    CONSTRAINT chk_bc_no_self_loop
        CHECK (parent_batch_id <> child_batch_id),
    CONSTRAINT chk_bc_qty
        CHECK (quantity_used > 0)
);


/* =========================================================
   5. outlet
   ========================================================= */
CREATE TABLE outlet (
    outlet_id      BIGSERIAL    PRIMARY KEY,
    outlet_name    VARCHAR(120) NOT NULL,
    city           VARCHAR(80)  NOT NULL,
    contact_email  VARCHAR(120),

    CONSTRAINT uq_outlet_name_city
        UNIQUE (outlet_name, city),
    CONSTRAINT chk_outlet_email
        CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);


/* =========================================================
   6. shipment  (header)
   ========================================================= */
CREATE TABLE shipment (
    shipment_id    BIGSERIAL   PRIMARY KEY,
    outlet_id      BIGINT      NOT NULL,
    shipment_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
    dispatched_by  BIGINT      NOT NULL,

    CONSTRAINT fk_shipment_outlet
        FOREIGN KEY (outlet_id)     REFERENCES outlet(outlet_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_shipment_user
        FOREIGN KEY (dispatched_by) REFERENCES app_user(user_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_shipment_date
        CHECK (shipment_date <= CURRENT_DATE)
);


/* =========================================================
   7. shipment_line  (which batches, how much)
   Cascades from its header because a line has no meaning
   without the shipment it belongs to.
   ========================================================= */
CREATE TABLE shipment_line (
    shipment_id  BIGINT        NOT NULL,
    batch_id     BIGINT        NOT NULL,
    quantity     NUMERIC(12,2) NOT NULL,

    CONSTRAINT pk_shipment_line
        PRIMARY KEY (shipment_id, batch_id),

    CONSTRAINT fk_sl_shipment
        FOREIGN KEY (shipment_id) REFERENCES shipment(shipment_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_sl_batch
        FOREIGN KEY (batch_id)    REFERENCES batch(batch_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_sl_qty CHECK (quantity > 0)
);


/* =========================================================
   8. inventory
   Current stock of a batch at an outlet. Maintained by the
   shipment_line triggers in 02_functions.sql, so it can
   never drift from what was actually shipped.
   ========================================================= */
CREATE TABLE inventory (
    outlet_id         BIGINT        NOT NULL,
    batch_id          BIGINT        NOT NULL,
    quantity_on_hand  NUMERIC(12,2) NOT NULL DEFAULT 0,
    stock_status      VARCHAR(20)   NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT pk_inventory
        PRIMARY KEY (outlet_id, batch_id),

    CONSTRAINT fk_inv_outlet
        FOREIGN KEY (outlet_id) REFERENCES outlet(outlet_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inv_batch
        FOREIGN KEY (batch_id)  REFERENCES batch(batch_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_inv_status
        CHECK (stock_status IN ('AVAILABLE', 'QUARANTINED')),
    CONSTRAINT chk_inv_qty
        CHECK (quantity_on_hand >= 0)
);


/* =========================================================
   9. recall
   ========================================================= */
CREATE TABLE recall (
    recall_id      BIGSERIAL    PRIMARY KEY,
    batch_id       BIGINT       NOT NULL,
    reason         TEXT         NOT NULL,
    initiated_by   BIGINT       NOT NULL,
    initiated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    recall_status  VARCHAR(20)  NOT NULL DEFAULT 'OPEN',
    closed_by      BIGINT,
    closed_at      TIMESTAMPTZ,

    CONSTRAINT fk_recall_batch
        FOREIGN KEY (batch_id)     REFERENCES batch(batch_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_recall_user
        FOREIGN KEY (initiated_by) REFERENCES app_user(user_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_recall_closer
        FOREIGN KEY (closed_by)    REFERENCES app_user(user_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_recall_status
        CHECK (recall_status IN ('OPEN', 'CLOSED')),
    CONSTRAINT chk_recall_reason
        CHECK (length(btrim(reason)) >= 10),
    /* closed exactly when it has a closer and a closing time */
    CONSTRAINT chk_recall_closure
        CHECK ((recall_status = 'CLOSED') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
    CONSTRAINT chk_recall_close_order
        CHECK (closed_at IS NULL OR closed_at >= initiated_at)
);

/* at most one OPEN recall per source batch */
CREATE UNIQUE INDEX ux_recall_open_batch
    ON recall (batch_id) WHERE recall_status = 'OPEN';


/* =========================================================
   10. recall_batch
   Every batch a recall reached, and how many WENT_INTO hops
   it sits below the source batch (0 for the source itself).
   The affected set is resolved in Neo4j by the API and
   persisted here by sp_initiate_recall, so the exposure view
   and the audit trail never depend on the graph later.
   ========================================================= */
CREATE TABLE recall_batch (
    recall_id  BIGINT  NOT NULL,
    batch_id   BIGINT  NOT NULL,
    hop_depth  INT     NOT NULL,

    CONSTRAINT pk_recall_batch
        PRIMARY KEY (recall_id, batch_id),
    CONSTRAINT fk_rb_recall
        FOREIGN KEY (recall_id) REFERENCES recall(recall_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_rb_batch
        FOREIGN KEY (batch_id)  REFERENCES batch(batch_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_rb_depth
        CHECK (hop_depth >= 0)
);


/* =========================================================
   11. audit_log
   Append only, enforced by a trigger in 02_functions.sql.
   No foreign key to batch or recall on purpose: the log must
   survive deletion of whatever it describes. performed_by is
   SET NULL so removing a user account does not erase history.
   ========================================================= */
CREATE TABLE audit_log (
    log_id        BIGSERIAL    PRIMARY KEY,
    action        VARCHAR(60)  NOT NULL,
    entity_name   VARCHAR(60)  NOT NULL,
    entity_id     BIGINT,
    performed_by  BIGINT,
    performed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    details       TEXT,

    CONSTRAINT fk_audit_user
        FOREIGN KEY (performed_by) REFERENCES app_user(user_id)
        ON DELETE SET NULL,

    CONSTRAINT chk_audit_action
        CHECK (action ~ '^[A-Z][A-Z_]*$')
);


/* =========================================================
   12. complaint
   Free text from customers. No batch number in it.
   The embedding is stored in Qdrant under complaint_id.
   similarity_score is added by an ALTER in 02_functions.sql
   (requirement 5 schema evolution step).
   ========================================================= */
CREATE TABLE complaint (
    complaint_id      BIGSERIAL     PRIMARY KEY,
    outlet_id         BIGINT,
    complaint_text    TEXT          NOT NULL,
    received_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    matched_batch_id  BIGINT,

    CONSTRAINT fk_complaint_outlet
        FOREIGN KEY (outlet_id)        REFERENCES outlet(outlet_id)
        ON DELETE SET NULL,
    CONSTRAINT fk_complaint_batch
        FOREIGN KEY (matched_batch_id) REFERENCES batch(batch_id)
        ON DELETE SET NULL,

    CONSTRAINT chk_complaint_text
        CHECK (length(btrim(complaint_text)) BETWEEN 10 AND 2000)
);
